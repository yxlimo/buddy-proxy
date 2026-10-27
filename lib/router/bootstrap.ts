// lib/router/bootstrap.ts — what runs at startup, after the server is listening.
//
// The order matters: the credentials come first (an account with no session logs
// in here, in the background), then the catalogues that need one, then the
// wallets. The periodic timer starts once, not once per account — a token is
// one-shot, and a second refresh of the same session looks like a replay to the
// platform (lib/periodic.ts).

import { configNumber } from "../config.ts";
import { AuthError } from "../credential.ts";
import { readCredential } from "../minimax/auth.ts";
import { startPeriodic } from "../periodic.ts";
import { tokenRhythmStatuses } from "../tokenrhythm/wallet.ts";
import { qoderStatus } from "../qoder/auth.ts";
import { workbuddyStatus } from "../workbuddy/auth.ts";
import {
  ensureMinimaxSession,
  ensureQoderSession,
  ensureWorkBuddySession,
  providersNeedingLogin,
} from "../login.ts";
import {
  ensureSenseNovaKey,
  refreshSenseNovaCatalog,
  senseNovaCatalog,
} from "../sensenova/transport.ts";
import {
  loadSession as loadSenseNovaSession,
  login as loginSenseNova,
} from "../sensenova/auth.ts";
import {
  ensureInternAiKey,
  internAiCatalog,
  refreshInternAiCatalog,
} from "../intern-ai/transport.ts";
import { loadSession as loadInternAiSession } from "../intern-ai/auth.ts";
import { PLATFORMS } from "../platforms.ts";
import { accountsOfPlatform } from "../providers.ts";
import { benefits } from "../admin/benefits.ts";
import { pruneUsage } from "../usage.ts";
import { enabledAccounts, refreshWorkBuddyCatalog } from "./catalog-routes.ts";

/** The background work of a start: the logins, the catalogues, the timers. */
export function startUpstreams(): void {
  // The server owns the credentials. An enabled region with no session runs the
  // device flow here, in the background: the URL goes to the log and the operator
  // approves it. A region that is off is never looked at.
  for (const provider of providersNeedingLogin("minimax")) {
    void ensureMinimaxSession(provider)
      .then(async (outcome) => {
        const c = await readCredential(provider);
        const state = `generation ${c.generation}, expires in ${Math.round(c.remainingMs / 60000)} min`;
        console.log(
          outcome === "logged-in"
            ? `  [AUTH] ${provider}: logged in: ${state}`
            : `  [AUTH] ${provider}: token ok: ${state}`,
        );
      })
      .catch((e) => {
        const err = e as AuthError;
        console.warn(`  [AUTH] minimax: ${err.message}`);
        console.warn(`         ${err.hint}`);
      });
  }

  // One timer for everything periodic: the tokens are refreshed, the
  // check-ins are taken and the state is read, one after another (see
  // lib/periodic.ts). The client does the same in the background, so
  // nobody has to ask for a new token and a request never waits for one.
  //
  // It starts once, not once per account: two timers would ask the platform
  // the same thing twice, and a token is one-shot (a second refresh of the
  // same session looks like a replay, and the platform revokes the session).
  startPeriodic();

  for (const provider of providersNeedingLogin("qoder")) {
    void ensureQoderSession(provider)
      .then((outcome) => {
        const s = qoderStatus(provider);
        console.log(
          outcome === "logged-in"
            ? `  [AUTH] ${provider}: logged in`
            : `  [AUTH] ${provider}: session ok, expires in ${Math.round(Number(s.remainingSec ?? 0) / 60)} min`,
        );
        // A fresh session is worth a run right away.
        void benefits.runOnce();
      })
      .catch((e) => console.warn(`  [AUTH] ${provider} login failed: ${(e as Error).message}`));
  }

  // WorkBuddy 的目录：库里那份先顶着，后台按 TTL 再抓一次（全新库里没有，
  // 抓到的第一份就写进库，写死的那张引导表也就退场了）。
  void refreshWorkBuddyCatalog();

  for (const provider of providersNeedingLogin("workbuddy")) {
    void ensureWorkBuddySession(provider)
      .then(async (outcome) => {
        const s = workbuddyStatus(provider);
        console.log(
          outcome === "logged-in"
            ? `  [AUTH] ${provider}: logged in`
            : `  [AUTH] ${provider}: session ok, expires in ${Math.round(Number(s.remainingSec ?? 0) / 60)} min`,
        );
        // The catalogue needs a token, so it comes after the login.
        await refreshWorkBuddyCatalog(true);
        // A fresh session is worth a run right away.
        void benefits.runOnce();
      })
      .catch((e) => console.warn(`  [AUTH] ${provider} login failed: ${(e as Error).message}`));
  }

  // 中转站：一个账号一行一个钱包，启动时问一遍平台，余额不明就早说。
  for (const template of PLATFORMS) {
    if (template.kind !== "tokenrhythm") continue;
    if (!accountsOfPlatform(template.id).length) continue;
    void tokenRhythmStatuses(template.id)
      .then((accounts) => {
        for (const account of accounts) {
          const wallet = account.wallet;
          const left = wallet ? `${wallet.availableCny} 元` : "未知";
          console.log(
            `  [TOKENRHYTHM] ${account.accountId} (${account.account}): 可用 ${left}` +
              (account.error ? ` — ${account.error}` : ""),
          );
        }
      })
      .catch((e) => console.warn(`  [TOKENRHYTHM] 账号状态获取失败: ${(e as Error).message}`));
  }

  // 账号一行一个：谁的会话没了就补谁的，不停在整个平台上。
  for (const row of enabledAccounts("sensenova")) {
    // 推理端点要的是一把 key，不是 cookie。账号上有会话却没有 key 的（老版本
    // 登录留下的），在这里补一把 —— 登录完了上游才是 READY 的。
    void (async () => {
      // SenseNova 的登录是账号密码加 PKCE，不用开浏览器，所以没有会话时
      // 网关自己登 —— 凭据在环境里，够用。
      let session = loadSenseNovaSession(row.id);
      if (!session) {
        console.log(`  [SENSENOVA] ${row.id} 还没有登录态，用环境里的账号密码登录`);
        session = await loginSenseNova(undefined, undefined, row.id);
      }
      await ensureSenseNovaKey(session, row.id);
      await refreshSenseNovaCatalog(true, row.id);
      console.log(`  [SENSENOVA] ${row.id} 模型清单：${senseNovaCatalog().length} 个`);
    })().catch((e) => console.warn(`  [SENSENOVA] ${row.id}: ${(e as Error).message}`));
  }

  for (const row of enabledAccounts("intern-ai")) {
    // 与 SenseNova 一样：推理端点认的是 Discovery 子站那把 key。
    void (async () => {
      const session = loadInternAiSession(row.id);
      if (!session) {
        // 端砚的登录要过人机验证，服务器替不了：让人在面板上登一次。
        console.log(`  [INTERN-AI] ${row.id} 还没有登录态，在面板上登录一次即可`);
        return;
      }
      await ensureInternAiKey(session, row.id);
      await refreshInternAiCatalog(true, row.id);
      console.log(`  [INTERN-AI] ${row.id} 模型目录：${internAiCatalog().length} 个`);
    })().catch((e) => console.warn(`  [INTERN-AI] ${row.id}: ${(e as Error).message}`));
  }

  // The daily benefits of the China accounts — the check-in, the growth centre
  // and the campaigns — run on the periodic timer (lib/periodic.ts).

  // The usage log grows one row per request, so the old rows go. The startup
  // run does the first pass; this one catches the records that age out while
  // the service runs, and picks up a retention the operator changed.
  setInterval(
    () => {
      const days = configNumber("USAGE_RETENTION_DAYS", 30);
      const dropped = pruneUsage(days);
      if (dropped > 0) console.log(`  [USAGE] 丢掉了 ${dropped} 条超过 ${days} 天的用量记录`);
    },
    60 * 60 * 1000,
  ).unref?.();
}
