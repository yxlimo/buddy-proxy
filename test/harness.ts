// test/harness.ts — 起一个真网关的共用 helper。
//
//   import { startGateway } from "./harness.ts";
//
// 它只做两件事，不做业务：
//   1. 起一个真的 router-proxy.ts，/health 答了才算起来；
//   2. 保证收尾：端口被抢就换号重试，进程退出时一定把子进程杀掉。
//
// 为什么有它：以前每个测试自己写一套 freePort() + spawn()。freePort() 是
// 「listen(0) 拿一个号再关掉」，内核把同一个号发给两个并行测试时就撞车
// （listen EADDRINUSE），而失败时那个子进程没人收 —— 留一个跑好几分钟的
// 网关在后台。这里把两件事收口到一处：撞了换号再来，退出时一定收干净。
//
// 离线：这个 helper 只起本机的网关，不发任何真实上游请求。

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 最多试几个端口。 */
const MAX_ATTEMPTS = 3;
/** 网关要起来就等多久（毫秒）。 */
const READY_TIMEOUT_MS = 20_000;
/** SIGTERM 之后多久还活着就上 SIGKILL。 */
const KILL_AFTER_MS = 500;
/** 失败时附在错误后面的输出长度。 */
const LOG_TAIL = 1500;

export interface GatewayOptions {
  /** 不给就 mkdtemp 一个临时目录。 */
  dataDir?: string;
  /** 追加/覆盖的环境变量（BUDDY_DATA_DIR、ROUTER_PORT、PERIODIC_ENABLED 由 helper 自己填）。 */
  env?: Record<string, string>;
  /** 默认 "/health"。 */
  healthPath?: string;
  /** true：stop() 不删数据目录（调用方后面还要读那个库）。 */
  keepDataDir?: boolean;
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
  /** 目录是不是 helper 自己建的：只有自己建的才删。 */
  owned: boolean;
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
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** 等 /health 答。子进程先死了就不等了。 */
async function waitForHealth(child: ChildProcess, base: string, healthPath: string): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited(child)) return false;
    try {
      const res = await fetch(`${base}${healthPath}`, { signal: AbortSignal.timeout(2000) });
      await res.text();
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
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

/**
 * 起一个真的网关，等它 /health 答了才返回。
 *
 * 端口被抢了（并行测试撞车）就换一个号再来，最多 MAX_ATTEMPTS 次；
 * 别的错（配置不对、代码崩了）不重试 —— 重试也没用，直接带着子进程的输出报错。
 */
export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const healthPath = options.healthPath ?? "/health";
  const owned = !options.dataDir;
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "buddy-gateway-"));
  let lastOutput = "";

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
    let ready = await waitForHealth(child, base, healthPath);
    // 端口可能已经被别的网关抢了：那时候答 /health 的是它，不是我们。
    // 我们的子进程会自己退出，等它一下再算数。
    if (ready && (await died(child, 200))) ready = false;

    if (ready) {
      const state: GatewayState = {
        child,
        dataDir,
        owned,
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
    // 这一次没起来：先把子进程收干净，不留僵尸。
    await terminate(child);
    // 只有「端口被抢」才换号重试。
    if (!output.text.includes("EADDRINUSE")) {
      removeTempDir(dataDir, owned);
      throw new Error(`网关没起来（端口 ${port}）：\n${output.text.slice(-LOG_TAIL)}`);
    }
  }

  removeTempDir(dataDir, owned);
  throw new Error(
    `网关没起来（试了 ${MAX_ATTEMPTS} 个端口，端口一直被抢）：\n${lastOutput.slice(-LOG_TAIL)}`,
  );
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
