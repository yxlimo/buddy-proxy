// tests/seed-session.ts — 给面板 e2e 的那个账号写一份会话（离线测试数据）。
//
//   BUDDY_DATA_DIR=<这次运行的数据目录> node --experimental-strip-types \
//     tests/seed-session.ts <platform> <accountId> [accessToken]
//
// 第三段是可选的会话令牌：额度页的用例要按 token 分清是哪个账号（假上游照
// Authorization 报不同的数），不给就还是那份默认的。
//
// 为什么需要它：面板上「排队中」这一档要一个**能接请求**的账号才算得出来
// （lib/admin/platform-state.ts 的判定顺序里，凭据那一关在排队前面）。而 Qoder
// 的登录要人在浏览器里点同意，那份「同意」之后上游给的答复没有录下来 —— 编一份
// 就等于假造上游说过的话。所以这一步只把**会话**铺进去，形状与
// test/fake-sessions.ts 给后端测试铺的那份一模一样，令牌是编造的。
//
// 铺完之后：请求仍然从真网关发出去、真的走到假上游、真的被上游排进队列 ——
// 「排队中」这个状态是被两次真请求推出来的，不是写进去的。
//
// 账号行由调用方（测试）用 admin RPC 建好，这里只写凭据：不建账号、不改开关。
// 只碰 BUDDY_DATA_DIR 那一份库；令牌是编造的，假上游不看它们。

import { saveSession as saveQoderSession } from '../lib/qoder/auth.ts';
import { saveSession as saveWorkBuddySession } from '../lib/workbuddy/auth.ts';

const [platform, accountId, accessToken] = process.argv.slice(2);

if (!process.env.BUDDY_DATA_DIR) {
  throw new Error('需要 BUDDY_DATA_DIR（这次运行的数据目录）');
}
if (!platform || !accountId) {
  throw new Error('用法：seed-session.ts <platform> <accountId>');
}

const now = Date.now();
const year = now + 365 * 24 * 3600 * 1000;
/** 会话令牌：给第三段就用它，否则还是那份默认的样例。 */
const TOKEN = accessToken || 'dt-E2E-TESTONLY-access'; // privacy:allow — 编造的样例

/** Qoder 的会话：字段与 test/fake-sessions.ts 那份一致，值是编造的样例。 */
function qoder(region: 'global' | 'cn') {
  return {
    schemaVersion: 1,
    region,
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    accessToken: TOKEN, // privacy:allow — 编造的样例
    refreshToken: 'drt-E2E-TESTONLY-refresh', // privacy:allow — 编造的样例
    userId: '00000000-0000-0000-0000-000000000000',
    expiresAtMs: year,
    refreshExpiresAtMs: year,
    machineId: '00000000-0000-4000-8000-000000000000',
    machineToken: 'e2e-machine-token',
    machineType: 'e2e-machine-type',
    generation: 1,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

/** WorkBuddy 的会话：字段与 test/fake-sessions.ts 那份一致，值是编造的样例。 */
function workBuddy() {
  return {
    accessToken: TOKEN, // privacy:allow — 编造的样例
    refreshToken: 'drt-E2E-TESTONLY-refresh', // privacy:allow — 编造的样例
    uid: '00000000-0000-0000-0000-000000000000',
    nickname: 'e2e',
    domain: 'www.workbuddy.cn',
    region: 'cn' as const,
    generation: 1,
    expiresAtMs: year,
    refreshExpiresAtMs: year,
    loginAtMs: now,
    refreshedAtMs: now,
  };
}

switch (platform) {
  case 'qoder':
    saveQoderSession(qoder('global'), accountId, { force: true });
    break;
  case 'qoder-cn':
    saveQoderSession(qoder('cn'), accountId, { force: true });
    break;
  case 'workbuddy-cn':
    saveWorkBuddySession(workBuddy(), accountId, { force: true });
    break;
  default:
    throw new Error(`这个平台没有可铺的会话：${platform}`);
}

console.log(JSON.stringify({ account: accountId, platform }));
