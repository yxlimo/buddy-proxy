// lib/log-scrub.ts — 把正文里的敏感值抹掉，只留能读懂这句话的部分。
//
// 上游的正文不能丢（只看状态码分不出「风控」「参数不认」「模型没有」），但
// 正文里也可能带着账号标识、邮箱、令牌这样的东西。两个地方会把它读出去：
// stdout（容器日志，会被复制、归档、发到别处）和客户端的答复（网关把上游那句
// 原话交给调用方，见 policy.ts 的 upstreamAnswerError）。两处抹的是同一套规矩，
// 所以只有一份实现，出口两个。
//
// 抹的是「值」，不是「字段名」：字段名留着（`token` 这个字段还在，只是值没了），
// 这样读日志的人还看得懂那句话在说什么。

/**
 * 名字里带着这些词的字段，值不留。
 *
 * 字段名先按驼峰拆开再对这张表：`accessToken` 拆成 `access_Token`、
 * `userId` 拆成 `user_Id` —— 不拆的话驼峰写法一个都匹配不上（2026-11-03，
 * 作者复查发现：`accessToken` 这种 32 位的令牌既没有 `sk-` 前缀、也不够
 * 40 个字符，按文本里的规则也接不住）。
 *
 * 复数与连字符也算：`tokens` / `accessTokens` / `user-id` 一样要抹。
 */
const SENSITIVE_FIELD =
  /(^|_)(tokens?|secrets?|passwords?|passwds?|cookies?|credentials?|mails?|emails?|uids?|ids?|keys?|uuids?|user_?ids?|account_?ids?|session_?ids?|api_?keys?|access_?keys?|private_?keys?)(_|$)/i;

/** 抹掉的值。 */
const REDACTED = "[已抹去]";

/**
 * 名字里带 `id`、带 `token`，但**不是**账号标识的那些。
 *
 * 两组：
 *
 *   · 请求 id、追踪 id —— 每请求随机的值。抹了就没法跟上游的日志对上了，
 *     排查时那正是要找的东西。（账号标识用的是别的名字：`user_id`、`uid`、
 *     `enterpriseId`、`account_id` —— 那些不在白名单里，照样被抹。）
 *   · 用量里的那些数 —— token 数不是凭据。上游的正文里最要紧的就是这些数
 *     （答了 200 却没内容的时候，警告就是靠它们判断的），抹掉等于把日志里
 *     最要读的那部分抹了（2026-11-03，作者复查发现）。
 */
const SAFE_FIELDS = new Set([
  // 请求 id 与追踪 id（连同带 uuid 的请求 id —— 它是随机的，不是账号标识）。
  "request_id",
  "request_uuid",
  "req_id",
  "trace_id",
  "log_id",
  "x_request_id",
  "x_trace_id",
  // 用量：数（复数与单数两种写法都接 —— 上游两样都有）。
  "prompt_tokens",
  "prompt_token",
  "completion_tokens",
  "completion_token",
  "total_tokens",
  "total_token",
  "input_tokens",
  "input_token",
  "output_tokens",
  "output_token",
  "cached_tokens",
  "cached_token",
  "reasoning_tokens",
  "reasoning_token",
  "audio_tokens",
  "audio_token",
  "thinking_tokens",
  "thinking_token",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "prompt_cache_write_tokens",
  "completion_thinking_tokens",
  "accepted_prediction_tokens",
  "rejected_prediction_tokens",
  "prompt_tokens_details",
  "completion_tokens_details",
  // 请求里的那些上限：也不是凭据。
  "max_tokens",
  "max_token",
  "max_output_tokens",
  "max_completion_tokens",
  "max_input_tokens",
  "budget_tokens",
  "thinking_budget_tokens",
  "input_cached_tokens",
  "input_uncached_tokens",
  // 模型 id：查问题的时候要看是哪个模型答的。
  "model_id",
]);

/**
 * UUID 形状。
 *
 * 账号标识最常见的样子。按字段名抹的那一张表只接得住表里有的名字 —— 上游
 * 换个字段名（`account`、`sub`、`openId`…）就接不住了。UUID 不管叫什么都在
 * 那里，所以它是最后一道防线（2026-11-03，作者复查发现）。
 *
 * 请求 id 例外：字段名说了它是请求 id（`request_id`、`trace_id`…），那就留
 * 着 —— 抹了就没法跟上游的日志对上。字段名没说的一律抹。
 */
const UUID_SOURCE = "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b";
/** 把字符串里 UUID 形状的东西都抹掉。 */
const UUID_SHAPE_ALL = new RegExp(UUID_SOURCE, "gi");

/**
 * 驼峰拆成下划线：`accessToken` → `access_Token`。
 *
 * 拆了才能拿 `token` / `id` / `key` 这些词根去对表 —— 不拆的话驼峰写法
 * 一个都匹配不上（`accessToken` 里 `Token` 前面是字母，不是分隔符）。
 * 连字符也当分隔符：上游爱写 `user-id`。
 */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

/** 这个字段的值要不要抹掉。 */
function isSensitiveField(key: string): boolean {
  const name = normalizeKey(key);
  if (SAFE_FIELDS.has(name)) return false;
  return SENSITIVE_FIELD.test(name);
}

/** 这个字段是不是白名单里的（不是账号标识）。 */
function isSafeField(key: string): boolean {
  return SAFE_FIELDS.has(normalizeKey(key));
}

/**
 * 把一段正文里的敏感字段去掉，只留能读懂这句话的部分。
 *
 * 去掉的是：邮箱、令牌样的长串（JWT 那种带点的也算）、UUID 形状的标识、
 * 以及名字里带着 token / secret / key / cookie / uid / id 的字段的值。正文是
 * JSON 就按 JSON 拆，拆不动就按文本里的模式换。
 *
 * SSE 帧（`data: {...}`）是**一帧一帧**地拆。流式上游的正文就是多帧，整段
 * 当一坨去 parse 一定失败 —— 那整条「按字段抹」的规则对流式上游就一点用没有
 * （2026-11-03，作者复查发现）。
 */
function scrubText(text: string, maxLength: number): string {
  const original = (text || "").trim();
  if (!original) return "";
  const frames = framesOf(original);
  let out: string;
  if (frames) {
    // 一帧一帧地抹。
    out = frames.map((frame) => scrubFrame(frame)).join(" ");
  } else {
    // 不是 SSE：整段当 JSON 拆（拆不动就当文本）。
    const parsed = parseMaybeJson(original);
    if (parsed && typeof parsed === "object") {
      out = JSON.stringify(scrubValue(parsed));
    } else {
      // 不是 JSON：按文本走。UUID 形状的账号标识躲过了字段名那一张表，
      // 这里兜底 —— 纯文本里没有字段名可看，UUID 一律抹。
      out = scrubUuids(original.replace(/\s+/g, " ").trim());
    }
  }
  // 最后一遍按形态抹（邮箱、令牌样的长串、JWT）：JSON 里那些装在字符串值里的
  // 也要抹 —— 按字段名抹不到它们。
  return scrubPatterns(out).slice(0, maxLength);
}

/**
 * 写进日志的那一份（stdout）。
 *
 * `maxLength`：留多长。凭据日志留 200（那里要的是「上游说了什么」），控制台
 * 留 500（那里要的是「出了什么事」）。
 */
export function scrubForLog(text: string, maxLength = 200): string {
  return scrubText(text, maxLength);
}

/**
 * 交给客户端的那一份（回复里的 message 与 hint）。
 *
 * 与 scrubForLog 是同一套规矩 —— 字段名、UUID、令牌与邮箱形态、SSE 逐帧都是
 * 同一个实现：上游回显在 401/忙/风控正文里的 key 片段、cookie、邮箱、JWT 不会
 * 因为换了个出口就漏出去（只抹日志那一侧等于把敏感值直接送到调用方）。
 *
 * 与 scrubForLog 的差别只有一处：上限更大。客户端要看的是上游说了什么，4000
 * 那个数是它自己定过的（见 upstreamAnswerError）；日志那边 200 是给「一行日志」
 * 留的位置。日志那边若将来追加什么只有日志才需要的东西（标注、前缀），那是日志
 * 的写法，不进客户端这一份 —— 这里只给抹过的那段正文。
 */
export function scrubForClient(text: string, maxLength = 4000): string {
  return scrubText(text, maxLength);
}

/**
 * 抹一帧。
 *
 * 帧是 JSON 就按字段走；不是（比如 `data: [DONE]`）就当文本。
 */
function scrubFrame(frame: string): string {
  const parsed = parseMaybeJson(frame);
  if (parsed && typeof parsed === "object") {
    return JSON.stringify(scrubValue(parsed));
  }
  return scrubUuids(frame.replace(/\s+/g, " ").trim());
}

/** 按字段名把值抹掉。 */
function scrubValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      isSensitiveField(k) ? REDACTED : scrubValue(v, k),
    ]);
    return Object.fromEntries(entries);
  }
  if (typeof value === "string") {
    if (isSensitiveField(key)) return REDACTED;
    // 请求 id：留着（抹了就没法跟上游的日志对上）。
    if (isSafeField(key)) return value;
    // UUID 形状的标识：这个字段名不在表里（`account`、`sub`…），但值是账号
    // 标识 —— 兜底抹掉。字段名说了它是请求 id，那就留着。
    return scrubUuids(value);
  }
  return value;
}

/** 把字符串里 UUID 形状的东西抹掉。 */
function scrubUuids(text: string): string {
  return text.replace(UUID_SHAPE_ALL, REDACTED);
}

/**
 * 这一段正文是不是 SSE（一帧或多帧）：是的话把每一帧拆出来。
 *
 * 不是 SSE 就返回 undefined（走整段 JSON 那条路）。
 */
function framesOf(raw: string): string[] | undefined {
  if (!raw.includes("\n") && !raw.trimStart().startsWith("data:")) return undefined;
  const frames: string[] = [];
  let current: string[] = [];
  let sawData = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("data:")) {
      sawData = true;
      if (current.length) {
        frames.push(current.join("\n"));
        current = [];
      }
      current.push(trimmed.slice(5).trim());
      continue;
    }
    if (!trimmed) {
      if (current.length) {
        frames.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (current.length) current.push(line);
  }
  if (current.length) frames.push(current.join("\n"));
  if (!sawData) return undefined;
  return frames.length ? frames : undefined;
}

/**
 * 这段正文是不是 JSON：能当 JSON 拆就拆，不能就返回 undefined。
 *
 * SSE 帧的 `data: ` 前缀先剥掉 —— 那是传输层的壳，不是内容。
 */
function parseMaybeJson(raw: string): any {
  let candidate = raw.trim();
  if (candidate.startsWith("data:")) candidate = candidate.slice(5).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Cookie 形状：`acw_tc=0bc1…`、`session=eyJ…`。名字留着，值抹掉。
 *
 * 会话 cookie 常常被上游（或者中间那层 CDN）回显在正文里，而它不是 JSON 字段
 * —— 按名字抹的那一张表接不住，按文本抹的那几条规则也接不住（值里既没有 `sk-`
 * 前缀、也没有点分三段）。所以按「名字=值」的样子接。
 *
 * 两头都收紧，免得把参数值也抹了：值要 32 个字符以上，而且不带点、斜杠、连字符
 * —— 那三样是模型名与地址的特征（`model=claude-3-5-sonnet-20241022`），会话值
 * 里没有。值后面紧跟这三样时不算命中：那是更长的一段，只看前半截会漏下后半截。
 */
const COOKIE_PAIR = /\b([A-Za-z_][A-Za-z0-9_.-]{0,30})=([A-Za-z0-9+/=%_]{32,})(?![A-Za-z0-9+/=%_.-])/g;

/**
 * 文本里那些「不靠字段名」的形态：邮箱、令牌样的长串、JWT、cookie。
 */
function scrubPatterns(text: string): string {
  let out = text;
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED);
  out = out.replace(/\b(?:gh[pousr]_|sk-|bearer\s+)[A-Za-z0-9._-]{8,}/gi, REDACTED);
  // JWT：两段点分的长串（头.体.签名）。
  out = out.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
  // 引号里的长串（不带点的那种）。
  out = out.replace(/"[A-Za-z0-9_-]{40,}"/g, REDACTED);
  // cookie 形状：名字留着，值抹掉。
  out = out.replace(COOKIE_PAIR, `$1=${REDACTED}`);
  return out;
}
