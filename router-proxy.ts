// router-proxy.ts — the single entry point in front of every upstream.
//
// One port, two dialects:
//
//   POST /v1/messages         Anthropic dialect
//   POST /v1/chat/completions  OpenAI dialect
//   GET  /v1/models            the published model catalog
//   GET  /health
//
// The root route serves the models the panel published: the database decides
// which models exist and which upstream serves them. A request that names an
// upstream in the path (`/qoder-cn/v1/messages`) goes to that upstream with
// the real model name.
//
// Each dialect is cheapest on the upstream that speaks it natively:
//   OpenAI  → Qoder    the Qoder gateway is an OpenAI endpoint, so it passes through
//   OpenAI  → MiniMax  converted to Anthropic on the way out
//   Anthropic → Qoder  converted to Anthropic on the way in
//   Anthropic → MiniMax passes through

import { configNumber, configString, logConfig } from "./lib/config.ts";
import { deleteSecret, listSecrets } from "./lib/store.ts";
import { requireApiKey } from "./lib/api-keys.ts";
import { PLATFORMS, platformPolicy } from "./lib/platforms.ts";
import { accountsOfPlatform } from "./lib/providers.ts";
import { adminToken } from "./lib/admin/token.ts";
import { CONNECT_PREFIX, hasWebDist } from "./lib/admin/http.ts";
import { initWorkBuddyCatalog } from "./lib/workbuddy/catalog-store.ts";
import { pruneUsage } from "./lib/usage.ts";
import { app } from "./lib/router/app.ts";
import { modelsOfPlatform } from "./lib/router/catalog-routes.ts";
import { startUpstreams } from "./lib/router/bootstrap.ts";
import { assertLoginFlows } from "./lib/login-flow.ts";

const PORT = configNumber("ROUTER_PORT", 6450);
const HOST = configString("ROUTER_HOST", "0.0.0.0");

const PING_MS = configNumber("MINIMAX_PING_MS", 15000);

// `node router-proxy.ts --clear <id>` forgets one credential, so that the next
// start logs in again. It runs before anything else, so it touches nothing but
// the database.
const clearAt = process.argv.indexOf("--clear");
if (clearAt >= 0) {
  const id = process.argv[clearAt + 1] ?? "";
  if (!id) {
    console.error("usage: node router-proxy.ts --clear <credential-id>");
    console.error("the credentials in the database:");
    for (const row of listSecrets()) console.error(`  ${row.id}  (${row.kind})`);
    process.exit(1);
  }
  deleteSecret(id);
  console.log(`cleared ${id}`);
  process.exit(0);
}

// WorkBuddy 的模型目录住在数据库里（lib/workbuddy/catalog-store.ts）：那是
// 上游最后一次发布的目录，重启以后还在。启动时把它读进内存 —— 注册表与
// 路由读的是内存里那一份，所以这一步要在第一个请求之前做完。库里没有的
// 时候，留着写死的那份引导值，等第一次抓取换掉它。
initWorkBuddyCatalog();

// 这里才是「所有模块都加载完了」的那一刻。新接一个平台只写了 registerKind、
// 忘了登记登录链（或声明「没有」），这里当场报出来，而不是等人在面板上点
// 「登录」才收到一句 400。放在 kinds/index.ts 里不行：那个文件被 import
// 的时机比各模块登记 flow 早。
assertLoginFlows();

const server = app.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
  // The panel's token: generated once, kept in the data directory. The
  // operator reads it from the file and hands it to the panel.
  adminToken();
  // The usage log grows one row per request, so old rows go. Ninety days is
  // enough for "today" and the monthly view.
  const pruned = pruneUsage(configNumber("USAGE_RETENTION_DAYS", 30));
  if (pruned > 0) console.log(`  [USAGE] 丢掉了 ${pruned} 条超过 90 天的用量记录`);
  console.log("");
  console.log(`  router listening on ${base}`);
  console.log(`    Anthropic  ${base}/v1/messages`);
  console.log(`    OpenAI     ${base}/v1/chat/completions`);
  console.log(`    Models     ${base}/v1/models`);
  console.log(`    Health     ${base}/health`);
  console.log(`    Panel      ${base}/admin${hasWebDist() ? "" : " (还没有构建产物)"}`);
  console.log(`    Admin API  ${base}${CONNECT_PREFIX}/<Method>  (Bearer 令牌)`);
  console.log("");
  // 每个平台一行：开着的账号数、策略、服务多少个模型。没有账号的平台也列
  // 出来 —— 新装好的服务一个账号都没有，这是要看出来的常态，不是错误。
  console.log(`  platforms:`);
  for (const template of PLATFORMS) {
    const accounts = accountsOfPlatform(template.id);
    const on = accounts.filter((row) => row.enabled).length;
    const models = modelsOfPlatform(template.id).length;
    const state = on ? `${on}/${accounts.length} accounts, ${models} models` : `off (${accounts.length} accounts)`;
    console.log(`    ${template.id.padEnd(13)} ${state}  policy=${platformPolicy(template.id)}`);
  }
  console.log(`  auth: ${requireApiKey() ? "api key required" : "public"}`);
  console.log("");

  // Where the settings came from: the database first, then the environment,
  // then the defaults in the code. A setting that is not the default is
  // printed, so a change in the database is visible in the log.
  logConfig();
  console.log("");

  startUpstreams();
  void PING_MS;
});

/**
 * Keep the idle connections longer than the clients do.
 *
 * Node closes an idle connection after five seconds, and the clients (Node's
 * own fetch, and everything built on it) keep theirs for up to six. A request
 * that arrives in that gap is written to a socket the server has just closed,
 * and the client sees "other side closed" instead of an answer.
 *
 * Thirty seconds is above the clients' six and below the headers timeout.
 */
server.keepAliveTimeout = 30_000;

/**
 * Stop taking new work, let the running requests finish.
 *
 * A deployment replaces the container. Without this the requests that are in
 * flight when the container is stopped die with it -- the client sees a
 * dropped connection half-way through an answer. So: stop listening, wait for
 * what is running, and only then leave.
 */
let shuttingDown = false;
const DRAIN_MS = 20_000;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`  [SHUTDOWN] ${signal}: 不再接新请求，等手上的活干完（最多 ${DRAIN_MS / 1000} 秒）`);
    server.close(() => {
      console.log("  [SHUTDOWN] 手上的活干完了");
      process.exit(0);
    });
    // A request that hangs (an upstream that never answers) must not keep the
    // container alive forever.
    setTimeout(() => {
      console.log("  [SHUTDOWN] 等太久了，走了");
      process.exit(0);
    }, DRAIN_MS).unref?.();
  });
}
