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
  /** 带档位的那份目录：**不是实录**，见下面 `/efforts/v1/models` 那一段。 */
  effortsCatalog: 'catalog-models-efforts',
  /** 带计费的那份目录：**不是实录**，见下面 `/billing/v1/models` 那一段。 */
  billingCatalog: 'catalog-models-billing',
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

/**
 * Qoder 额度那两条查询（`/api/v3/user/status` 与 `/api/v2/quota/usage`）的开关。
 *
 * 默认关着，这两个路径照旧 404 —— 其余用例（排队、登录那些）都是照着
 * 「没问到额度」的世界写的，不能让默认行为悄悄变掉。要验额度页的用例自己
 * 打开它、摆好每个账号剩多少（按 Authorization 的 token 认账号），收尾 reset。
 */
export const qoderQuotaControl = {
  /** 开了才有这两个路径的答复；没开就落到下面的 404。 */
  enabled: false,
  /** ok：照常给数；error：500（额度服务挂了）。 */
  mode: 'ok' as 'ok' | 'error',
  /** 答复前拖多少毫秒：拖着，面板那一条查询就停在「正在读取」。 */
  delayMs: 0,
  /** 哪把 token 剩多少点（plan 池）；没登记的账号按 100 算。 */
  remaining: new Map<string, number>(),
  /** 回到「没开」：模式、延迟与每个账号的数都忘掉。 */
  reset(): void {
    this.enabled = false;
    this.mode = 'ok';
    this.delayMs = 0;
    this.remaining.clear();
  },
};

/**
 * 七牛门户资源包那一条查询（`QINIU_RESPACK_PATH`）的开关。形状同上：默认
 * 关着照旧 404；开了之后按门户 cookie（`Cookie` 头）报各账号剩多少。
 */
export const qiniuQuotaControl = {
  enabled: false,
  /** ok：给资源包；error：500（门户挂了）。 */
  mode: 'ok' as 'ok' | 'error',
  delayMs: 0,
  /** 哪份门户 cookie 剩多少 k tokens；没登记的账号按 0 算。 */
  remaining: new Map<string, number>(),
  reset(): void {
    this.enabled = false;
    this.mode = 'ok';
    this.delayMs = 0;
    this.remaining.clear();
  },
};

/**
 * WorkBuddy 签到状态那一条（`/v2/billing/meter/checkin-activity-status`）的开关。
 *
 * 默认关着照旧 404：其余用例都是照着「没问到签到状态」的世界写的。要验签到页
 * 「立即签到」的用例自己打开它 —— 假上游照这份固定正文答，还会先拖
 * `delayMs`：拖着，「立即签到」那个按钮就能稳定停在「签到中…」。
 */
export const workbuddyCheckinControl = {
  /** 开了才有这条路径的答复；没开就落到下面的 404。 */
  enabled: false,
  /** 答复前拖多少毫秒。 */
  delayMs: 0,
  /** 回到「没开」：开关与延迟都忘掉。 */
  reset(): void {
    this.enabled = false;
    this.delayMs = 0;
  },
};

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

  // ── Qoder：账号状态与额度（额度页的用例打开；默认关着，见上） ──────────
  // ── Qoder：账号状态与额度（额度页的用例打开；默认关着，见上） ──────────
  // 七牛的门户资源包（额度插件的探测）：qiniuQuotaControl 开了才认。平台行的
  // baseUrl 指到本机时，openai 类没有默认门户，额度就照行上那台问 —— 假上游
  // 按账号的门户 cookie 认人，报各自的数。
  if (qiniuQuotaControl.enabled && method === 'GET' && path === '/api/proxy/finance/janus/api/proxy/respack/v1/respack/month-overview') {
    const answer = (): void => {
      if (qiniuQuotaControl.mode === 'error') {
        answerJson(500, { code: 500, message: 'portal down' });
        return;
      }
      // lib/qiniu/quota.ts 认的形状：信封 code=200，data.records 是资源包。
      const cookie = String(req.headers.cookie ?? '');
      const remaining = qiniuQuotaControl.remaining.get(cookie) ?? 0;
      answerJson(200, {
        code: 200,
        data: {
          records: [
            {
              item_code: 'e2e-pack',
              item_name: 'E2E 资源包',
              zone_name: 'e2e-zone',
              total_surplus: remaining,
              month_used: 0,
              month_remain: remaining,
              respack_unit: 'k/tokens',
              update_time: Math.floor(Date.now() / 1000),
            },
          ],
        },
      });
    };
    if (qiniuQuotaControl.delayMs > 0) setTimeout(answer, qiniuQuotaControl.delayMs);
    else answer();
    return;
  }

  if (qoderQuotaControl.enabled) {
    if (method === 'GET' && path === '/api/v3/user/status') {
      // checkAccountHealth 只认 id 与 whitelistStatus：PASS 就是账号能用。
      answerJson(200, { id: 'e2e-e2e-e2e', whitelistStatus: 'PASS', userType: 'e2e' });
      return;
    }
    if (method === 'GET' && path === '/api/v2/quota/usage') {
      const answer = (): void => {
        if (qoderQuotaControl.mode === 'error') {
          answerJson(500, { errorCode: 'E2E_QUOTA_DOWN', message: 'quota service down' });
          return;
        }
        // lib/qoder/credits.ts 认的形状：两个池各报 total/used/remaining，
        // isQuotaExceeded 是平台自己的「用光了」。
        const remaining = qoderQuotaControl.remaining.get(hit.authorization.replace(/^Bearer\s+/i, '')) ?? 100;
        answerJson(200, {
          userQuota: { total: remaining, used: 0, remaining },
          addOnQuota: { total: 0, used: 0, remaining: 0 },
          isQuotaExceeded: remaining <= 0,
          expiresAt: Date.now() + 3600_000,
        });
      };
      // 拖着再答：答复没回来之前，面板那一条查询一直停在「正在读取」。
      if (qoderQuotaControl.delayMs > 0) setTimeout(answer, qoderQuotaControl.delayMs);
      else answer();
      return;
    }
  }

  // ── WorkBuddy：签到状态（签到页的用例打开；默认关着，见上） ─────────────
  if (workbuddyCheckinControl.enabled && method === 'POST' && path === '/v2/billing/meter/checkin-activity-status') {
    const answer = (): void => {
      // lib/workbuddy/benefits.ts 的 workbuddyCheckin 认的形状：今天已签、连签 3 天。
      answerJson(200, { code: 0, msg: 'ok', data: { today_checked_in: true, streak_days: 3 } });
    };
    if (workbuddyCheckinControl.delayMs > 0) setTimeout(answer, workbuddyCheckinControl.delayMs);
    else answer();
    return;
  }

  // ── 开放平台：模型目录 ───────────────────────────────────────────────
  if (method === 'GET' && path === '/v1/models') {
    answerFixture(FIXTURE.catalog);
    return;
  }

  // 开放平台：**带档位**的模型目录。
  //
  // 这一份不是实录，是编出来的形状：真录到的那份 `catalog-models` 里一个模型都
  // 没报档位，而「档位来自模型目录」这条路（自定义模型弹窗里那几档勾选框）必须
  // 由上游报出来才验得到 —— 拿面板自己编的值去验，等于验面板自己。
  //
  // 键名用的是 `lib/open-platform-catalog.ts` 的 TRAIT_PATHS.efforts 认的那条
  // （`supported_efforts`）。要它落到这条路上：平台的地址填
  // `${UPSTREAM_BASE}/efforts/v1`，于是这里收的就是 `/efforts/v1/models`。
  if (method === 'GET' && path === '/efforts/v1/models') {
    answerFixture(FIXTURE.effortsCatalog);
    return;
  }

  // 开放平台：**带计费**的模型目录。
  //
  // 这一份也不是实录，是编出来的形状：三条模型各报一种计费 —— 三个价都报（带
  // 缓存读）、只报输入与输出、完全没有报价。面板那行「上游报价 …」必须由上游
  // 报出来才验得到。
  //
  // 形状按 `lib/catalog-billing.ts` 的 opencode-go 描述符（cost.text.input.price /
  // output.price / input.cache.read.price，币种由描述符定死成美元）：计费描述符
  // 按**平台行的 id** 认，所以平台的 id 填 `opencode-go` 就落到它。要它落到这条
  // 路上：平台的地址填 `${UPSTREAM_BASE}/billing/v1`，于是这里收的就是
  // `/billing/v1/models`。
  if (method === 'GET' && path === '/billing/v1/models') {
    answerFixture(FIXTURE.billingCatalog);
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
