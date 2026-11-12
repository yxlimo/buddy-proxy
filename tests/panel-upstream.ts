// tests/panel-upstream.ts — 面板 e2e 的假上游：按录下来的答复回话，并把收到的请求记下来。
//
// 为什么要有它：面板上有三件事只能由上游回答，而它们都不能现编（编出来的形状
// 就是猜）—— 排队（Qoder 把模型停进队列）、登录的「发起」那一步（设备码与授权
// 链接）、开放平台的模型目录。三件事的答复都在 `test/fixtures/panel-e2e/` 里，
// 是**录下来的实录**、只读：这个文件只读它们，不改。
//
// 它监听一个**固定的**本机端口（`PANEL_E2E_UPSTREAM_PORT`，默认 6820），因为
// 指过去的那些设置是网关启动时读的（`test/panel-e2e-app.sh` 里 export 的那几
// 个 *_BASE / *_ORIGIN），测试进程没有第二次机会改。全部落在 127.0.0.1：这个
// 文件里没有一条出机器的请求，被指过来的网关也没有。
//
// 一个已知的时序缺口（目前不影响，将来会）：这个假上游起在**测试进程**里，而
// 网关是 `app.command` 先拉起来的 —— 两者之间存在没人监听的窗口（网关就绪到
// listen 之间，以及测试文件之间假上游随上一个进程/上下文退掉的那一段）。落在
// 这段窗口里的请求会 ECONNREFUSED，而且**不会进 `hits`** —— 断言就在看不见的
// 地方少了一条。实跑一轮能在这个窗口里看到两行（一次登录轮询的尾巴）：
// `[AUTH] 1 登录失败 connect ECONNREFUSED 127.0.0.1:6820`。它落在回环上，所以
// 永远不会变成一条真请求，只是没被记账。
//
// 目前不影响：`PERIODIC_ENABLED=false`，且这一套里每个发往上游的请求都是用例
// 自己驱动出来的（用例都先 `await startPanelUpstream()` 再动面板）。将来要是在
// `test/panel-e2e-app.sh` 里打开后台请求，得先把假上游挑到网关前面去（比如在
// app 命令里先起它，再把端口告诉测试进程）。
//
// 除了六份实录，还有两条**没有录过**的答复（各家的「还在等」）：
//
//   MiniMax   POST /oauth2/token                  → {"status":"pending"}
//   WorkBuddy GET  /v2/plugin/auth/token?state=…  → {"code":11217,…}
//   ZCode     GET  /api/v1/oauth/cli/poll/<flow>  → {"data":{"status":"pending"}}
//
// 它们不是从上游录来的，是后台轮询在那几家代码里的**约定**（面板的
// 「正在等你同意」那一屏）。没有它们，登录弹窗会在发起之后几秒内翻成失败，
// 断言就测不到「还在等」。这里明确标注：这三条是约定的形状，不是实录。
//
// 别的路径一律 404 并记下来（例：额度查询 /api/v2/quota/usage —— 面板打开时
// 健康快照会顺路问它，没录过，就答「没有」）。记下来是为了让断言能说清
// 「这一趟打过哪些上游地址」。

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { decodeLegacyBody, legacyModelKey } from '../test/legacy-wire.ts';

/** 假上游的端口：`test/panel-e2e-app.sh` 里的默认值与这里必须一致。 */
export const UPSTREAM_PORT = Number(process.env.PANEL_E2E_UPSTREAM_PORT ?? 6820);

/** 假上游的地址（网关那几格设置指的就是它）。 */
export const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

/** 一份录下来的答复：`{ upstream, status, headers, body }`。 */
interface Fixture {
  /** 录的时候那个地址（只用于说明这份答复对应哪条路）。 */
  upstream: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 六份实录的文件名（`test/fixtures/panel-e2e/` 下面的，没有扩展名）。 */
export const FIXTURE = {
  queue: 'qoder-queue-frame',
  minimaxDeviceCode: 'minimax-device-code',
  qoderPoll: 'qoder-login-poll-pending',
  workbuddyLogin: 'workbuddy-login-start',
  zcodeLogin: 'zcode-login-start',
  catalog: 'catalog-models',
} as const;

const FIXTURE_DIR = new URL('../test/fixtures/panel-e2e/', import.meta.url);

/**
 * 读一份实录。
 *
 * 只读：这是别的单刚录下来的东西，改一个字它就不再是「上游说的话」了。要
 * 「改一点再回」就在测试里 clone 之后改，不动文件。
 */
export function readFixture(name: string): Fixture {
  const raw = readFileSync(new URL(`${name}.json`, FIXTURE_DIR), 'utf8');
  return JSON.parse(raw) as Fixture;
}

/** 假上游收到过的一次请求。 */
export interface UpstreamHit {
  method: string;
  /** 路径（不含查询串）。 */
  path: string;
  /** 查询串（含 `?`；没有就是空串）。 */
  query: string;
  /** 这个请求是拿哪一份实录答的；没有实录命中就是 null（答了 404）。 */
  fixture: string | null;
  /** 请求头上的 Authorization（原样，可能是 COSY 签名或 Bearer key）。 */
  authorization: string;
  /** 请求头上的 x-api-key（Anthropic 方言的 key 在这一格）。 */
  apiKey: string;
  /**
   * 请求体里那个模型。
   *
   * 两边都认：普通的 JSON 取 `model`；Qoder 老协议的正文是它自己那一套 base64，
   * 解出来是 `model_config.key`（`dmodel` 这种上游模型名）。解不开就是空串。
   */
  model: string;
  /** 原始请求体（正文断言用得上）。 */
  body: string;
}

export interface FakeUpstream {
  /** 收过的请求，按先后。 */
  hits: UpstreamHit[];
  /** 忘掉收过的请求。 */
  reset(): void;
  /** 停下来（测试收尾用；同一个端口上的下一次 catch 会重新起）。 */
  close(): Promise<void>;
}

/** 起过的那个（一个端口上只该有一个）。 */
let running: Promise<FakeUpstream> | null = null;

/**
 * 起假上游（第一次调用时起，之后拿到同一个）。
 *
 * 端口是固定的：网关在启动时就把那几格设置读进常量了，测试没有第二次机会。
 * 端口被占就报清楚（多半是上一轮没收干净的进程）。
 *
 * 时序空缺（见文件开头）：网关先就绪、这里后 listen，中间落下的请求会
 * ECONNREFUSED 且不进 `hits`。当前无后台请求，不影响。
 */
export function startPanelUpstream(): Promise<FakeUpstream> {
  if (!running) {
    running = launch().catch((e) => {
      running = null;
      throw e;
    });
  }
  return running;
}

async function launch(): Promise<FakeUpstream> {
  const hits: UpstreamHit[] = [];
  const server = createServer((req, res) => {
    void handle(req, res, hits);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(
        new Error(
          e.code === 'EADDRINUSE'
            ? `假上游起不来：${UPSTREAM_BASE} 已被占用（上一轮没收干净？PANEL_E2E_UPSTREAM_PORT）`
            : `假上游起不来：${e.message}`,
        ),
      );
    });
    server.listen(UPSTREAM_PORT, '127.0.0.1', resolve);
  });
  // 别把测试进程吊在这个服务器上：跑完该退就退。
  server.unref();
  return { hits, reset: () => hits.splice(0, hits.length), close: () => close(server) };
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // 已经完成的连接不该拖住收尾（keep-alive 的那几条）。
    server.closeAllConnections?.();
  });
}

/** 一次请求：记下来，然后按路径挑一份答复。 */
async function handle(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  hits: UpstreamHit[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url ?? '/', UPSTREAM_BASE);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  const hit: UpstreamHit = {
    method,
    path,
    query: url.search,
    fixture: null,
    authorization: String(req.headers.authorization ?? ''),
    apiKey: String(req.headers['x-api-key'] ?? ''),
    model: modelOf(raw),
    body: raw,
  };
  hits.push(hit);

  /** 用一份实录答：状态、头、正文一个都不改。 */
  const answerFixture = (name: string): void => {
    const fixture = readFixture(name);
    hit.fixture = name;
    res.writeHead(fixture.status, fixture.headers);
    res.end(fixture.body);
  };
  const answerJson = (status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  // ── MiniMax Code：设备流 ─────────────────────────────────────────────
  if (method === 'POST' && path === '/oauth2/device/code') {
    answerFixture(FIXTURE.minimaxDeviceCode);
    return;
  }
  // 轮询：约定的形状（没录过），见文件开头。
  if (method === 'POST' && path === '/oauth2/token') {
    answerJson(200, { status: 'pending' });
    return;
  }

  // ── WorkBuddy：浏览器流 ──────────────────────────────────────────────
  if (method === 'POST' && path === '/v2/plugin/auth/state') {
    answerFixture(FIXTURE.workbuddyLogin);
    return;
  }
  if (method === 'GET' && path === '/v2/plugin/auth/token') {
    // `code: 11217` 就是它说的「还没同意」（lib/workbuddy/auth.ts 的 LOGIN_PENDING）。
    answerJson(200, { code: 11217, msg: '还在等用户同意' });
    return;
  }

  // ── ZCode：浏览器 OAuth ──────────────────────────────────────────────
  if (method === 'POST' && path === '/api/v1/oauth/cli/init') {
    answerFixture(FIXTURE.zcodeLogin);
    return;
  }
  if (method === 'GET' && path.startsWith('/api/v1/oauth/cli/poll/')) {
    answerJson(200, { code: 0, msg: '', data: { status: 'pending' } });
    return;
  }

  // ── Qoder：登录轮询（404 = 还在等，实录）与老协议推理 ─────────────────
  if (method === 'GET' && path === '/api/v1/deviceToken/poll') {
    answerFixture(FIXTURE.qoderPoll);
    return;
  }
  if (method === 'POST' && path === '/algo/api/v2/service/pro/sse/agent_chat_generation') {
    answerFixture(FIXTURE.queue);
    return;
  }

  // ── 开放平台：模型目录 ───────────────────────────────────────────────
  if (method === 'GET' && path === '/v1/models') {
    answerFixture(FIXTURE.catalog);
    return;
  }

  // 别的路径：没有实录就答「没有」。记下来是为了让断言说得清打过哪些地址。
  answerJson(404, { error: 'no fixture for this path', path });
}

/**
 * 请求体里那个模型。
 *
 * Qoder 老协议的正文是它自己那套 base64（`test/legacy-wire.ts` 解），别的是
 * 普通的 JSON。都不是就空串 —— 不猜。
 */
function modelOf(raw: string): string {
  if (!raw) return '';
  try {
    const body = JSON.parse(raw);
    if (body?.model !== undefined) return String(body.model);
    // 老协议：正文的 JSON 里有一个 model_config.key。
    return legacyModelKey(body);
  } catch {
    // 不是 JSON：当作老协议的编码正文再试一次。
    try {
      return legacyModelKey(decodeLegacyBody(raw));
    } catch {
      return '';
    }
  }
}
