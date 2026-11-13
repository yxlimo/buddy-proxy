// tests/seed-credentials.ts — 给面板 e2e 的账号写一份凭据（离线测试数据）。
//
//   BUDDY_DATA_DIR=<这次运行的数据目录> node --experimental-strip-types \
//     tests/seed-credentials.ts <形状> <accountId>
//
// 为什么需要它：凭据栏要验的是「一个账号名下摆哪几条」，而真正的凭据是登录换
// 回来的 —— 登录要人在浏览器里点同意（设备流 / 浏览器流），那份「同意」之后
// 上游给的答复没有录下来，编一份就等于假造上游说过的话。所以这一步只把**凭据
// 本身**铺进库：形状照抄各家真的存进去的那一份。
//
// 还剩一种形状（minimax）：其余几种（sensenova / tokenrhythm 的会话）随厂商
// kind 一起从代码里拿掉了。开放平台那条路要的两段凭据不走这里 —— 它们本来就
// 是面板填的两格，用 admin 的 SetProviderKeys 写就得（按位置写，见
// tests/panel-credentials.e2e.ts）。
//
// 铺完之后面板照常从库里读（`lib/admin/accounts.ts` 的 `credentialsOf`）：这一
// 套验的是「面板把凭据栏画成什么」，不是「登录能不能成功」—— 后者有别的用例。
//
// 账号行由调用方（测试）用 admin RPC 建好，这里只写凭据：不建账号、不改开关。
// 只碰 BUDDY_DATA_DIR 那一份库，绝不落回 ~/.buddy-proxy 或 NAS 上的库。

import { setSecret } from '../lib/store.ts';
import { providerSecretId } from '../lib/providers.ts';

const [shape, accountId] = process.argv.slice(2);

if (!process.env.BUDDY_DATA_DIR) {
  throw new Error('需要 BUDDY_DATA_DIR（这次运行的数据目录）');
}
if (!shape || !accountId) {
  throw new Error('用法：seed-credentials.ts <minimax> <accountId>');
}

const now = Date.now();

/** 一小时后到期：看得见「还没过期」，也不靠一年那么远。 */
const hour = now + 60 * 60 * 1000;

/** 这一趟要铺的形状。 */
switch (shape) {
  case 'minimax': {
    // MiniMax Code 只有会话：推理凭据就是它，额度也跟着它走。
    setSecret(providerSecretId(accountId), 'session', {
      schemaVersion: 1,
      clientId: 'mcode-public',
      audience: 'agent-backend',
      scopes: ['agent.default'],
      region: 'cn',
      accessToken: 'e2e-TESTONLY-minimax-access', // privacy:allow — 编造的样例
      refreshToken: 'e2e-TESTONLY-minimax-refresh', // privacy:allow — 编造的样例
      tokenType: 'Bearer',
      expiresAtMs: hour,
      generation: 1,
      loginAtMs: now,
      refreshedAtMs: now,
    });
    break;
  }
  default:
    throw new Error(`不认识的形状：${shape}`);
}

console.log(JSON.stringify({ shape, account: accountId }));
