// tests/panel-credentials.e2e.ts — 账号名下的凭据栏：摆哪几条、类型写什么。
//
// 凭据栏是「平台」页展开一个平台之后、选中一个账号时下面那张表。它要收口成两
// 件事：
//
//   1. 一个账号最多两条：推理那一段 + 额度那一段（只有会话的模拟客户端只有一
//      条「登录会话」）。「登录账号」这一类只是账号本身，不给它单列一行 ——
//      多列一行等于把一件东西摆两遍。
//   2. 类型说人话：徽章上写「登录会话」/「推理 Key」/「额度 Cookie」，不是契约
//      里的枚举值（session / api_key / cookie）。
//
// 前置数据分两步：账号用 admin RPC 建（`tests/panel.ts`），凭据也走 admin（开放
// 平台那两段按位置写，`SetProviderKeys`）或者用 `tests/seed-credentials.ts` 铺进
// 这一次运行的库（模拟客户端的会话是登录换回来的，那份答复没录下来 —— 编一份
// 就是假造上游说过的话）。铺进去的形状照抄那一家真的存的那一份，值是编造的。
// 上游一律关着：这一套不发一个请求。
//
// 关于「屏幕上不许出现协议值」这一条，断言的边界写清楚：整页文字里出现
// `session:provider:12`、`account:7#cookie` 这种是**凭据 id**（表里「凭据」那一
// 列的第二行），id 是 id，不是类型；要读的类型只有「类型」那一列。所以整页断
// 言先把 id 抠掉，再查那四个词；类型那一列则一个例外都不给。

import { execFileSync } from 'node:child_process';
import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import {
  addAccount,
  adminRpc,
  dataDir,
  dropPlatform,
  login,
  seedPlatform,
} from './panel.ts';

/** 面板上认的三个类型（`web/src/lib/credential-kind.ts` 的那张表）。 */
const KINDS = ['登录会话', '推理 Key', '额度 Cookie'] as const;

/** 契约里的协议值：屏幕上不该出现（凭据 id 里那几段除外，见文件开头）。 */
const PROTOCOL_WORDS = ['api_key', 'cookie', 'session', 'login'] as const;

/** 进「平台」页并展开某个平台那一行的账号区。 */
async function openAccountsOf(
  screen: Screen,
  browser: Browser,
  platformId: string,
): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await screen
    .getByRole('button', { name: `展开 ${platformId} 的账号与凭据` })
    .click();
  await expect(
    screen.getByRole('button', { name: `收起 ${platformId} 的账号与凭据` }),
  ).toBeVisible();
  await expect(browser).toHaveURL('/admin/upstreams');
}

/**
 * 凭据那张表。
 *
 * 三条判据，缺一不可：
 *   · 有「指纹」列 —— 只有凭据表有；按「凭据」认不行，账号表里也有一列叫
 *     「凭据」（那一格是条数）。
 *   · 没有「账号」列 —— 平台那一行把整张凭据表包在**自己**那张表里，光看
 *     「有没有指纹列」外层那张也会命中（`has` 认的是后代）。
 */
function credentialTable(screen: Screen): Locator {
  return screen
    .getByRole('table')
    .filter({ has: screen.getByRole('columnheader', { name: '指纹' }) })
    .filter({ hasNot: screen.getByRole('columnheader', { name: '账号' }) });
}

/** 凭据表里的数据行（表头那行没有 `cell`，只有 `columnheader`）。 */
function credentialRows(screen: Screen): Locator {
  return credentialTable(screen)
    .getByRole('row')
    .filter({ has: screen.getByRole('cell') });
}

/** 每一行的「类型」列：第二格（凭据 / 类型 / 掩码 / 指纹 / 状态 / 到期 / 操作）。 */
async function kindBadges(screen: Screen): Promise<string[]> {
  const rows = await credentialRows(screen).all();
  const out: string[] = [];
  for (const row of rows) {
    const cell = row.getByRole('cell').nth(1);
    out.push(String(await cell.textContent()).trim());
  }
  return out;
}

/** 每一行的整行文字（「登录账号」这种字样要整行找）。 */
async function rowTexts(screen: Screen): Promise<string[]> {
  return credentialRows(screen).allTextContents();
}

/** 整页可见文字。 */
async function pageText(browser: Browser): Promise<string> {
  return String(await browser.evaluate<string>('document.body.innerText'));
}

/**
 * 把凭据 id 从一段文字里抠掉。
 *
 * id 的形态由 `lib/credential-ids.ts` 定：`session:provider:<账号>`、
 * `key:provider:<账号>:<后缀>`、`account:<账号>[#<后缀>]`。它们是 id，不是类
 * 型 —— 整页断言只查抠掉 id 之后的那部分。
 */
function withoutCredentialIds(text: string): string {
  return text.replace(
    /(?:session|key):provider:[\w:#.\-]+|account:[\w.\-]+(?:#[\w.\-]+)?/g,
    '〈凭据 id〉',
  );
}

/** 用 `tests/seed-credentials.ts` 把凭据铺进这次运行的库。 */
function seedCredentials(shape: 'minimax', accountId: string): void {
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', 'tests/seed-credentials.ts', shape, accountId],
    { env: { ...process.env, BUDDY_DATA_DIR: dataDir() }, stdio: 'pipe' },
  );
}

/**
 * 收尾：只删除这次加的账号（连它的凭据）。
 *
 * 模拟客户端那几行（`minimax` 之类）是网关启动时自己播出来的：删了它整轮就少
 * 一个平台，后面的用例跟着红。所以这里不碰平台行。
 */
async function dropAccount(accountId: string): Promise<void> {
  await adminRpc('DeleteAccount', { id: accountId }).catch(() => {});
}

/** 收尾：这次自己建的平台（连账号与凭据）一起删掉，不给下一个用例留数据。 */
async function dropPlatformAndAccount(platformId: string, accountId: string): Promise<void> {
  await dropAccount(accountId);
  await dropPlatform(platformId).catch(() => {});
}

/** 服务端那边这个账号现在有哪几条凭据（拿来看屏上的断言是不是空转）。 */
async function kindsOnServer(accountId: string): Promise<string[]> {
  const listed = await adminRpc<{
    credentials?: Array<{ accountId?: string; kind?: string; label?: string }>;
  }>('ListCredentials', { accountId });
  return (listed.credentials ?? [])
    .filter((entry) => entry.accountId === accountId)
    .map((entry) => String(entry.kind ?? ''));
}


test('凭据栏：只有会话的平台（MiniMax Code）恰好一条，类型是「登录会话」', async ({
  app,
  screen,
  browser,
}) => {
  // 模拟客户端那几行是启动时播出来的（`migrateSimulatedClients`），只加账号。
  const account = await addAccount('minimax', '会话一号');
  try {
    seedCredentials('minimax', account);

    await app.open();
    await openAccountsOf(screen, browser, 'minimax');
    await expect(credentialTable(screen)).toBeVisible();

    await expect(credentialRows(screen)).toHaveCount(1);
    const badges = await kindBadges(screen);
    expect(badges).toEqual(['登录会话']);
    // 只有会话的平台没有第二段可列：屏上不该冒出「推理 Key」「额度 Cookie」。
    expect(badges).not.toContain('推理 Key');
    expect(badges).not.toContain('额度 Cookie');

    // 协议值同样不许露（id 除外）。
    const readable = withoutCredentialIds(await pageText(browser));
    for (const word of PROTOCOL_WORDS) {
      expect(readable).not.toContain(word);
    }
  } finally {
    // 平台是启动时播出来的，不能删：只清自己加的那个账号。
    await dropAccount(account);
  }
});

test('凭据栏：迁移过来的平台（openai + 七牛额度插件）恰好两行 —— 推理 Key + 额度 Cookie', async ({
  app,
  screen,
  browser,
}) => {
  // 厂商 kind 已经没了，老行迁移成 openai + 原来那个额度插件。凭据那两段因此
  // 来自两个地方：推理那一把归 kind（openai），额度那一段归插件（platform 行上
  // 的 quota_plugin）—— 这一条就是「额度逻辑本来就是插件」的证据。
  const platform = 'e2e-creds-migrated';
  await seedPlatform({
    id: platform,
    label: 'E2E 凭据四号站',
    kind: 'openai',
    baseUrl: 'https://legacy.example/v1',
    quotaPlugin: 'qiniu',
  });
  const account = await addAccount(platform, '凭据四号');
  try {
    // 两段按位置写：推理 Key，然后是插件要的那一格（七牛的门户 cookie）。
    // 值都是编造的。
    const accountKey = 'sk-e2e-creds-key'; // privacy:allow — 编造的样例
    await adminRpc('SetProviderKeys', {
      upstreamId: account,
      keys: [accountKey, 'e2e-portal-cookie'],
    });

    await app.open();
    await openAccountsOf(screen, browser, platform);
    await expect(credentialTable(screen)).toBeVisible();

    // 恰好两条：推理那一段 + 额度那一段，不是「不超过两条」。
    await expect(credentialRows(screen)).toHaveCount(2);
    const badges = await kindBadges(screen);
    expect(badges).toHaveLength(2);
    expect(badges).toContain('推理 Key');
    expect(badges).toContain('额度 Cookie');
    // 类型那一列只说中文：协议值一个例外都不给。
    for (const badge of badges) {
      expect(KINDS as readonly string[]).toContain(badge);
    }

    // 整页也一样：除了凭据 id，协议值一个都不许露出来。
    const readable = withoutCredentialIds(await pageText(browser));
    for (const word of PROTOCOL_WORDS) {
      expect(readable).not.toContain(word);
    }
    expect(await pageText(browser)).not.toContain('登录账号');

    // 服务端那侧：推理那把是 api_key，插件那一格是 account；没有 login 那一条。
    const kinds = await kindsOnServer(account);
    expect(kinds).toContain('api_key');
    expect(kinds).not.toContain('login');
  } finally {
    await dropPlatformAndAccount(platform, account);
  }
});
