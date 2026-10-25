// lib/session-refresh.ts — 按客户端的节奏定时刷新会话。
//
// 官方客户端不等请求来了才换令牌：它自己按时间表换（快到点就换掉）。网关照做：
// 一个定时器，每隔一会儿看一眼，令牌快到点就换掉。这样有两个好处：请求来的
// 时候拿到的令牌一定是还能用的，也不会出现「第一个请求等刷新」的那种慢。
//
// 刷不出来就算了：平台拒了就是拒了（那份会话已经作废），等操作者重新授权。
// 断路器（lib/session.ts）记得这次拒绝，不会拿着同一份死会话再去问平台。

import { listProviders } from "./providers.ts";
import { kindOf } from "./provider-kinds.ts";

/** 每分钟看一眼。 */
const INTERVAL_MS = 60_000;

/** 上一次失败的措辞：一样的就不重复打印了。 */
const lastFailure = new Map<string, string>();

/**
 * 刷新一次所有该刷的会话。
 *
 * 每个种类自己知道怎么刷（见 ProviderKind.refresh），所以这里不认得是哪家
 * 平台，也不会在这里写 if/else。
 */
export async function refreshSessionsOnce(): Promise<void> {
  for (const provider of listProviders()) {
    const kind = kindOf(provider.kind);
    if (!kind?.refresh) continue;
    try {
      await kind.refresh(provider);
      lastFailure.delete(provider.id);
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (message === lastFailure.get(provider.id)) continue;
      lastFailure.set(provider.id, message);
      console.warn(`[AUTH] ${provider.id}: ${message}`);
      const hint = (e as { hint?: string })?.hint;
      if (hint) console.warn(`       ${hint}`);
    }
  }
}

/**
 * 定时刷新。
 *
 * 客户端是自己在后台换令牌的，网关也这样：不需要谁来点。
 */
export function startSessionRefresh(intervalMs = INTERVAL_MS): void {
  const timer = setInterval(() => void refreshSessionsOnce(), intervalMs);
  timer.unref?.();
}
