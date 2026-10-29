// test/harness.ts — 起一个真网关的共用 helper。
//
//   import { startGateway } from "./harness.ts";
//
// 它只做两件事，不做业务：
//   1. 起一个真的 router-proxy.ts，探到它答话才算起来；
//   2. 保证收尾：端口被抢就换号重试，进程退出时一定把子进程杀掉。
//
// 为什么有它：以前每个测试自己写一套 freePort() + spawn()。freePort() 是
// 「listen(0) 拿一个号再关掉」，内核把同一个号发给两个并行测试时就撞车
// （listen EADDRINUSE），而失败时那个子进程没人收 —— 留一个跑好几分钟的
// 网关在后台。这里把两件事收口到一处：撞了换号再来，退出时一定收干净。
//
// 「起来了」的判据（这里踩过坑）：
//   freePort() 拿到号就放开，等子进程真的去绑，中间有半秒的空窗 —— 别的
//   测试可能抢走这个号。这时候 /health 答话的是**别人**的网关，我们的
//   子进程随后带着 EADDRINUSE 退掉。原来只等 200ms 看它退没退，而它要
//   500ms 才退得掉，于是 helper 以为起来了，测试用着一个随时会消失的网关，
//   最后报的是 ECONNREFUSED —— 看着像网络问题，其实是启动竞态。
//   所以现在要两样都对：端口上有 HTTP 答复（不是连不上），而且答话的那个
//   网关认我们的面板令牌（是「我们」而不是「别人」）。
//
// 离线：这个 helper 只起本机的网关，不发任何真实上游请求。

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 最多试几个端口。 */
const MAX_ATTEMPTS = 8;
/** 网关要起来就等多久（毫秒）。 */
const READY_TIMEOUT_MS = 20_000;
/** 换端口之前等多久（毫秒）：让并行的测试错开，别一起抢同一段端口号。 */
const RETRY_DELAY_MIN_MS = 100;
const RETRY_DELAY_MAX_MS = 300;
/** 探测的间隔与单次超时（毫秒）。 */
const POLL_MS = 150;
const PROBE_TIMEOUT_MS = 3_000;
/** SIGTERM 之后多久还活着就上 SIGKILL。 */
const KILL_AFTER_MS = 500;
/** 失败时附在错误后面的输出长度。 */
const LOG_TAIL = 2000;
/**
 * 归属探针用的路径：一个不存在的方法。
 *
 * 面板的 API 要令牌（数据目录里的 admin-token，每个网关一份）。探一个不存在
 * 的方法：令牌被认了才走得到路由里，答 404（unimplemented）；令牌不对就是
 * 401。别的网关有它自己的令牌 —— 所以这个 404 就是「这个端口上是我们」。
 */
const CONNECT_PROBE_PATH = "/buddy.admin.v1.AdminService/__harness_probe__";

export interface GatewayOptions {
  /** 不给就 mkdtemp 一个临时目录。 */
  dataDir?: string;
  /** 追加/覆盖的环境变量（BUDDY_DATA_DIR、ROUTER_PORT、PERIODIC_ENABLED 由 helper 自己填）。 */
  env?: Record<string, string>;
  /** 默认 "/health"。 */
  healthPath?: string;
  /** true：stop() 不删数据目录（调用方后面还要读那个库）。 */
  keepDataDir?: boolean;
  /**
   * true：连调用方自己给的 dataDir 也由 helper 删。
   *
   * 为什么需要：自己建的目录是临时的，留着只是垃圾；但删它要等子进程死了
   * 之后，否则它还在写的 SQLite 会把文件写回来。
   */
  cleanupDataDir?: boolean;
}

export interface Gateway {
  base: string;
  port: number;
  dataDir: string;
  /** 启动期间子进程的输出（失败时打印它）。 */
  log(): string;
  /** 幂等：SIGTERM → 500ms → SIGKILL，并删掉临时数据目录（只有 helper 自己建的才删）。 */
  stop(): void;
}

interface GatewayState {
  child: ChildProcess;
  dataDir: string;
  /** 这个目录该不该由 helper 删：自己建的，或者调用方点名要的。 */
  owned: boolean;
  /** 调用方要求留着：true 就不删。 */
  keepDataDir: boolean;
  /** 子进程的输出。用对象装着，后来的输出也进得来。 */
  output: { text: string };
  stopped: boolean;
}

/** 起过的网关：退出钩子靠它收尾。 */
const states = new Set<GatewayState>();

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once("exit", onExit);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
}

/** 进程要走了：把子进程杀掉，别留一个网关在后台跑。 */
function onExit(): void {
  for (const state of states) cleanupSync(state);
}

function onSigint(): void {
  for (const state of states) cleanupSync(state);
  // 装了监听器，默认的「收到信号就死」就没了，这里补上。
  process.exit(130);
}

function onSigterm(): void {
  for (const state of states) cleanupSync(state);
  process.exit(143);
}

/**
 * 同步收尾：子进程还在就上 SIGKILL，临时目录顺手删掉。
 *
 * 目录要删两遍：子进程被杀的那一瞬可能正在写 SQLite，它会把文件写回来，
 * 所以再叫一个脱离的 rm 去删一遍 —— 那个 rm 跑的时候，子进程已经不在了。
 */
function cleanupSync(state: GatewayState): void {
  if (!exited(state.child)) {
    try {
      state.child.kill("SIGKILL");
    } catch {
      /* 已经走了 */
    }
  }
  removeDataDir(state);
  removeDataDirLater(state);
}

function removeDataDir(state: GatewayState): void {
  if (!state.owned || state.keepDataDir) return;
  try {
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了，不能让测试挂在收尾上 */
  }
}

/** 叫一个脱离的 rm 稍后再删一遍这个目录。 */
function removeDataDirLater(state: GatewayState): void {
  if (!state.owned || state.keepDataDir) return;
  try {
    const rm = spawn("rm", ["-rf", state.dataDir], { detached: true, stdio: "ignore" });
    rm.unref();
  } catch {
    /* 没有 rm 就留着那个目录吧 */
  }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从内核拿一个空端口（拿完就放开，让子进程去绑）。 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------------ *
 * 探测：这个端口上有没有网关，那个网关是不是我们的
 * ------------------------------------------------------------------ */

/** 面板令牌：数据目录里的 admin-token。网关绑好端口之后才写它。 */
function readAdminToken(dataDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** 连接类失败：连不上（不是 HTTP 答复）。 */
function isConnectionError(e: unknown): boolean {
  const err = e as any;
  const code = String(err?.cause?.code ?? err?.code ?? "");
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT"].includes(code)) {
    return true;
  }
  return /fetch failed|ECONNREFUSED|socket hang up/i.test(String(err?.message ?? ""));
}

/** 把一个异常说成人话：连接类失败要能一眼看出是 ECONNREFUSED。 */
function describeError(e: unknown): string {
  const err = e as any;
  const code = String(err?.cause?.code ?? err?.code ?? "");
  const message = String(err?.message ?? err);
  return code ? `${code}（${message}）` : message;
}

interface Probe {
  /** 端口上有 HTTP 答复（状态码不管）：不是连不上。 */
  http: boolean;
  /** 这个端口上的是我们的网关。 */
  ours: boolean;
  /** 连接类失败。 */
  refused: boolean;
  /** 答的状态码。 */
  status: number | null;
  /** 一句话说清刚才看见了什么。 */
  detail: string;
}

/**
 * 探一次端口。
 *
 * 两问：「有没有 HTTP 答复」和「答话的是不是我们」。
 * 只问第一问不够 —— 端口被抢的时候，答话的是**别的**网关，它答得挺好。
 */
async function probe(base: string, token: string | null): Promise<Probe> {
  let http = false;
  let ours = false;
  let refused = false;
  let status: number | null = null;
  let detail = "";

  // 一、真实端点：答什么状态码都行，要的是「有 HTTP 答复」，不是连不上。
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.text();
    http = true;
    status = res.status;
  } catch (e) {
    refused = isConnectionError(e);
    detail = describeError(e);
  }

  // 二、归属：面板令牌。这个端口上的网关认我们的令牌，才是我们的。
  if (token) {
    try {
      const res = await fetch(`${base}${CONNECT_PROBE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = await res.text();
      // 令牌被认了才会走到 Connect 的路由：方法不存在，答 404（unimplemented）。
      ours = res.status === 404 && body.includes("unimplemented");
      if (!ours && res.status === 401) {
        detail = `端口上答话的是别的网关（面板令牌被拒：401）`;
      } else if (!ours) {
        detail = `端口上答话的不是我们的网关（状态码 ${res.status}）`;
      }
    } catch (e) {
      refused = refused || isConnectionError(e);
      detail = detail || describeError(e);
    }
  } else if (!detail) {
    detail = "还没有面板令牌（网关还没绑好端口）";
  }

  return { http, ours, refused, status, detail };
}

/** 一次启动的结果。 */
interface ReadyResult {
  ready: boolean;
  /** 失败的原因分类。 */
  reason: "ready" | "child-exited" | "timeout";
  /** 一句话说清。 */
  detail: string;
}

/**
 * 等网关真的起来。
 *
 * 判据是「探到它」：端口上有 HTTP 答复，而且答话的那个网关认我们的令牌。
 * 子进程先死了就不等了。
 */
async function waitForReady(
  child: ChildProcess,
  base: string,
  dataDir: string,
  healthPath: string,
): Promise<ReadyResult> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "";
  let sawHttp = false;
  while (Date.now() < deadline) {
    if (exited(child)) {
      return { ready: false, reason: "child-exited", detail: last || "子进程自己退了" };
    }
    // 健康检查：它答了说明 HTTP 那条路是通的（但可能答的是别人的网关）。
    try {
      const res = await fetch(`${base}${healthPath}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await res.text();
      sawHttp = true;
    } catch {
      /* 还没起来 */
    }
    const p = await probe(base, readAdminToken(dataDir));
    last = p.detail;
    if (p.ours && p.http) {
      // 它可能刚拿到端口又退了：再确认一次它还活着。
      if (await died(child, 0)) {
        return { ready: false, reason: "child-exited", detail: "子进程刚起来就退了" };
      }
      return { ready: true, reason: "ready", detail: "" };
    }
    await sleep(POLL_MS);
  }
  return {
    ready: false,
    reason: "timeout",
    detail: last || (sawHttp ? "健康检查答了，但探不到我们的网关" : "探测超时"),
  };
}

/**
 * 等网关把表建出来。
 *
 * /health 在 bootstrap 之前就能答，而建表是懒的：测试紧接着往库里直接插
 * `secrets`，就会撞上「no such table: secrets」（并行跑时真的会发生 ——
 * 2026-10-28 全套红过两次）。所以启动完成之后再等这张表。
 *
 * 子进程退了就不等了：等下去也是白等。
 */
async function waitForSchema(dataDir: string, child: ChildProcess): Promise<void> {
  const file = path.join(dataDir, "buddy.db");
  for (let i = 0; i < 200; i++) {
    if (exited(child)) throw new Error("网关在建表的时候退了");
    try {
      const db = new DatabaseSync(file);
      const row = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'secrets'")
        .get() as { n?: number } | undefined;
      db.close();
      if (Number(row?.n ?? 0) > 0) return;
    } catch {
      /* 还没有文件、或者正被建着 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("网关起来了，但库里一直没有 secrets 表");
}

/** 子进程是不是在这段时间里走了。 */
function died(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    child.once("exit", onExit);
  });
}

/** 把一个子进程收干净：SIGTERM，500ms 后还活着就 SIGKILL。 */
async function terminate(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const gone = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("exit", finish);
      child.off("error", finish);
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
    // 兜底：赖着不走就当它没了，不能把测试挂住。
    setTimeout(finish, 2000);
    if (exited(child)) finish();
  });
  try {
    child.kill("SIGTERM");
  } catch {
    /* 已经走了 */
  }
  const escalate = setTimeout(() => {
    if (!exited(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经走了 */
      }
    }
  }, KILL_AFTER_MS);
  await gone;
  clearTimeout(escalate);
}

/** 公开的 stop()：幂等，重复调不报错，进程已经走了也不报错。 */
function stopGateway(state: GatewayState): void {
  if (state.stopped) return;
  state.stopped = true;
  if (exited(state.child)) {
    removeDataDir(state);
    return;
  }
  try {
    state.child.kill("SIGTERM");
  } catch {
    /* 已经走了 */
  }
  const escalate = setTimeout(() => {
    if (exited(state.child)) {
      removeDataDir(state);
      return;
    }
    // 等它真的死了再删目录：它还活着的时候会把 SQLite 的文件写回来。
    state.child.once("exit", () => removeDataDir(state));
    try {
      state.child.kill("SIGKILL");
    } catch {
      /* 已经走了 */
    }
  }, KILL_AFTER_MS);
  escalate.unref?.();
}

/* ------------------------------------------------------------------ *
 * 失败分类：端口被抢（换号再来）还是代码崩了（立刻报）
 * ------------------------------------------------------------------ */

type FailureKind = "port-taken" | "crash" | "died" | "not-listening" | "hung";

interface Failure {
  kind: FailureKind;
  detail: string;
  /** 值不值得换个端口再来一次。 */
  retryable: boolean;
}

/** 输出的栈帧：node 崩了的时候会打这种行。 */
function hasStackTrace(output: string): boolean {
  return /\n\s+at\s+\S+.*:\d+:\d+/.test(output);
}

/**
 * 这次为什么没起来。
 *
 * 端口被抢（EADDRINUSE）值得换号再来；代码崩了（栈）换号也没用，立刻报 ——
 * 别把真错误藏在八次重试后面。
 */
function classify(output: string, result: ReadyResult): Failure {
  if (output.includes("EADDRINUSE")) {
    return { kind: "port-taken", detail: "端口被别的进程占了（EADDRINUSE）", retryable: true };
  }
  if (hasStackTrace(output)) {
    return { kind: "crash", detail: "子进程崩了（见下面的输出）", retryable: false };
  }
  if (result.reason === "child-exited") {
    return { kind: "died", detail: result.detail || "子进程自己退了", retryable: false };
  }
  // 起来了但一声不吭：它卡住了，不是什么端口的事，换号也没用。
  if (!output.trim()) {
    return { kind: "hung", detail: "子进程一直没有输出，也没有开始答话", retryable: false };
  }
  return { kind: "not-listening", detail: result.detail || "启动期连不上", retryable: true };
}

/**
 * 起一个真的网关，等它答话才返回。
 *
 * 端口被抢了（并行测试撞车）就换一个号再来，最多 MAX_ATTEMPTS 次；
 * 别的错（配置不对、代码崩了）不重试 —— 重试也没用，直接带着子进程的输出报错。
 */
export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const healthPath = options.healthPath ?? "/health";
  const owned = !options.dataDir;
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "buddy-gateway-"));
  // 调用方自己给的目录也可以由 helper 收：它同样是临时的。
  const removable = owned || options.cleanupDataDir === true;
  let lastOutput = "";
  const tried: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, ["router-proxy.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        BENEFITS_DISABLED: "1",
        // 定时器关着：不换令牌、不签到、不扫余额 —— 自测不碰任何平台。
        PERIODIC_ENABLED: "false",
        ...options.env,
        BUDDY_DATA_DIR: dataDir,
        ROUTER_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { text: "" };
    child.stdout?.on("data", (c: Buffer) => {
      output.text += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      output.text += c.toString();
    });
    child.on("error", (e) => {
      output.text += `\n${String(e)}`;
    });

    const base = `http://127.0.0.1:${port}`;
    const result = await waitForReady(child, base, dataDir, healthPath);

    if (result.ready) {
      try {
        await waitForSchema(dataDir, child);
      } catch (e) {
        lastOutput = output.text;
        await terminate(child);
        removeTempDir(dataDir, removable);
        throw new Error(`网关没起来（第 ${attempt}/${MAX_ATTEMPTS} 次，端口 ${port}）：${String(e)}\n${output.text.slice(-LOG_TAIL)}`);
      }
      // 表建好了，再确认一次网关还活着：早退的子进程不能当成 ready。
      if (await died(child, 0)) {
        lastOutput = output.text;
        await terminate(child);
        tried.push(`第 ${attempt} 次：端口 ${port} —— 子进程在建表之后退了`);
        await sleep(retryDelay());
        continue;
      }
      const state: GatewayState = {
        child,
        dataDir,
        owned: removable,
        keepDataDir: options.keepDataDir === true,
        output,
        stopped: false,
      };
      states.add(state);
      installHooks();
      return {
        base,
        port,
        dataDir,
        log: () => output.text,
        stop: () => stopGateway(state),
      };
    }

    lastOutput = output.text;
    const failure = classify(output.text, result);
    // 这一次没起来：先把子进程收干净，不留僵尸。
    await terminate(child);
    if (!failure.retryable) {
      removeTempDir(dataDir, removable);
      throw new Error(
        `网关没起来（第 ${attempt}/${MAX_ATTEMPTS} 次，端口 ${port}）：${failure.detail}\n${output.text.slice(-LOG_TAIL)}`,
      );
    }
    tried.push(`第 ${attempt} 次：端口 ${port} —— ${failure.detail}`);
    // 换个号再来之前先等一下：让并行的测试错开，别一起抢同一段端口号。
    await sleep(retryDelay());
  }

  removeTempDir(dataDir, removable);
  throw new Error(
    `网关没起来（试了 ${MAX_ATTEMPTS} 个端口）：\n${tried.join("\n")}\n` +
      `--- 子进程输出（尾 ${LOG_TAIL} 字符）---\n${lastOutput.slice(-LOG_TAIL)}`,
  );
}

/** 换号之前等多久：100–300ms 之间随机，错开并行的测试。 */
function retryDelay(): number {
  return RETRY_DELAY_MIN_MS + Math.floor(Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1));
}

/** 删掉 helper 自己建的临时目录。 */
function removeTempDir(dataDir: string, owned: boolean): void {
  if (!owned) return;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }
}
