// test/serve.ts — 给 shell 脚本用的网关启动器。
//
//   node --experimental-strip-types test/serve.ts --mock --ready-file /tmp/ready.json
//
// 为什么有它：五个 shell 脚本（smoke / aggregate / capture / 两个浏览器脚本）
// 原来各自挑端口、自己 spawn、自己等 /health。固定端口（6698/6699、6708/6709、
// 6792/6793、6797/6798）撞上别人就整跑失败，失败时子进程还没人收。
//
// 这里把它收口到 test/harness.ts：端口由 helper 挑（撞了换号再来），起来之后
// 归属探针确认「答话的是我们」，进程退出时一定杀干净。shell 只负责拿一行
// JSON（base / port / dataDir / token），其余照旧。
//
// 全离线：只起本机的网关；--mock 起的是本机的假上游。

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, startGateway, type Gateway } from "./harness.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `用法：node --experimental-strip-types test/serve.ts [选项]

  --data-dir <dir>     网关的数据目录；不给就建一个临时的（退出时删掉）
  --upstream <base>    假上游基址：把各平台的上游都指过去
  --mock               自己起 test/mock-server.ts，并把它当作上游
  --env K=V            额外的环境变量，可重复；覆盖上面的默认值
  --ready-file <path>  起来之后把 {"base","port","dataDir","token"} 写进这个文件
  --log-file <path>    进程收尾时把网关的输出写到这个文件
  --no-seed            不往库里种假会话（默认种）
  --keep               不删数据目录
  --help               打这段 `;

interface Args {
  dataDir: string;
  upstream: string;
  mock: boolean;
  env: [string, string][];
  readyFile: string;
  logFile: string;
  seed: boolean;
  keep: boolean;
}

function parse(argv: string[]): Args | null {
  const args: Args = {
    dataDir: "",
    upstream: "",
    mock: false,
    env: [],
    readyFile: "",
    logFile: "",
    seed: true,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} 后面缺一个值`);
      return value;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--data-dir":
        args.dataDir = next();
        break;
      case "--upstream":
        args.upstream = next();
        break;
      case "--mock":
        args.mock = true;
        break;
      case "--env": {
        const pair = next();
        const at = pair.indexOf("=");
        if (at < 1) throw new Error(`--env 要 K=V 的形状：${pair}`);
        args.env.push([pair.slice(0, at), pair.slice(at + 1)]);
        break;
      }
      case "--ready-file":
        args.readyFile = next();
        break;
      case "--log-file":
        args.logFile = next();
        break;
      case "--no-seed":
        args.seed = false;
        break;
      case "--keep":
        args.keep = true;
        break;
      default:
        throw new Error(`不认识的选项：${flag}`);
    }
  }
  if (args.mock && args.upstream) throw new Error("--mock 与 --upstream 只能给一个");
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 假会话：网关没有凭据就会走设备流去真登录，测试里不能那样。 */
function seedDummySession(dataDir: string): void {
  const file = path.join(dataDir, "minimax-session.json");
  if (fs.existsSync(file)) return;
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        schemaVersion: 1,
        clientId: "mcode-public",
        audience: "agent-backend",
        scopes: ["agent.default"],
        region: "cn",
        accessToken: "test-token",
        refreshToken: "test-refresh",
        tokenType: "Bearer",
        expiresAtMs: now + 365 * 24 * 3600 * 1000,
        generation: 1,
        loginAtMs: now,
        refreshedAtMs: now,
      },
      null,
      2,
    ),
  );
}

/** 库里的假会话（qoder / workbuddy / minimax 各一份）。
 *
 * TEST_UPSTREAMS 决定开哪几个平台，所以要把给网关的那份 env 一起传进去：
 * 漏了它，minimax 就不在库里，指向 minimax 的模型会被当成“没有目标”剔掉。 */
function seedSessions(dataDir: string, env: Record<string, string>): void {
  execFileSync(process.execPath, ["--experimental-strip-types", "test/fake-sessions.ts"], {
    cwd: ROOT,
    env: { ...process.env, ...env, BUDDY_DATA_DIR: dataDir },
    stdio: "ignore",
  });
}

/** 上游都指到一个地方：与原来 run-router.sh 的那一组完全一致。 */
function upstreamEnv(base: string): Record<string, string> {
  if (!base) return {};
  return {
    QODER_GLOBAL_INFER_BASE: `${base}/qoder-global`,
    QODER_GLOBAL_LEGACY_BASE: `${base}/qoder-global-legacy`,
    QODER_CN_INFER_BASE: `${base}/qoder-cn`,
    QODER_GLOBAL_OPENAPI_BASE: `${base}/openapi-global`,
    QODER_CN_OPENAPI_BASE: `${base}/openapi-cn`,
    WORKBUDDY_CHAT_BASE: `${base}/workbuddy`,
    // MiniMax 打在 <base>/messages 上；mock 与录制代理都答在 /minimax/v1/messages。
    MINIMAX_BASE_URL: `${base}/minimax/v1`,
    // 额度与套餐问的是另一个 host：不指过去的话，假令牌会去问真平台。
    MINIMAX_API_BASE: `${base}/minimax`,
    TOKENRHYTHM_INFER_BASE: `${base}/tokenrhythm/v1`,
    TOKENRHYTHM_API_BASE: `${base}/tokenrhythm`,
  };
}

/** 等一个 HTTP 端点答话（假上游可能比网关先起也可能后起）。 */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return; // 答什么都行：说明端口上有服务在听
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error(`假上游没起来：${url}`);
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  let args: Args | null;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (!args) {
    console.log(USAGE);
    return;
  }

  const createdByUs = !args.dataDir;
  const dataDir = args.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "buddy-serve-"));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let mock: ChildProcess | null = null;
  let upstream = args.upstream;
  if (args.mock) {
    const port = await freePort();
    mock = spawn(process.execPath, ["--experimental-strip-types", "test/mock-server.ts", String(port)], {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const base = `http://127.0.0.1:${port}`;
    await waitForHttp(base, 20_000);
    upstream = base;
  }

  const env: Record<string, string> = {
    BENEFITS_DISABLED: "1",
    TEST_UPSTREAMS: "qoder,qoder-cn,workbuddy-cn,minimax",
    ...upstreamEnv(upstream),
  };
  for (const [key, value] of args.env) env[key] = value;

  // 种子要在 env 之后：它读的就是这一份 TEST_UPSTREAMS。
  seedDummySession(dataDir);
  if (args.seed) seedSessions(dataDir, env);

  let gateway: Gateway | null = null;
  const flush = (): void => {
    if (!args?.logFile) return;
    try {
      fs.writeFileSync(args.logFile, gateway?.log() ?? "");
    } catch {
      /* 写不了日志也不能让收尾失败 */
    }
  };
  const killMock = (): void => {
    if (!mock) return;
    try {
      mock.kill("SIGKILL");
    } catch {
      /* 已经走了 */
    }
  };
  const shutdown = (code: number): void => {
    flush();
    try {
      gateway?.stop();
    } catch {
      /* 已经走了 */
    }
    killMock();
    process.exit(code);
  };

  // 信号处理要在起网关之前装：helper 自己也装了 SIGTERM 钩子（它会先
  // process.exit），后装的处理器可能根本轮不到 —— 假上游就被留在了后台。
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("exit", () => {
    flush();
    killMock();
  });

  try {
    gateway = await startGateway({
      dataDir,
      env,
      keepDataDir: args.keep,
      cleanupDataDir: createdByUs && !args.keep,
    });
  } catch (e) {
    console.error(`网关没起来：${(e as Error).message}`);
    shutdown(1);
    return;
  }

  const token = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim();
  const info = { base: gateway.base, port: gateway.port, dataDir, token };
  if (args.readyFile) writeAtomic(args.readyFile, `${JSON.stringify(info)}\n`);
  console.log(JSON.stringify(info));
}

await main();
// 事件循环里还有网关的子进程与监听器，进程会一直在这儿等着信号。
await new Promise<void>(() => {});
