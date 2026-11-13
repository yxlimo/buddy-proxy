// tests/panel-open-platform-keys.e2e.ts — 通用开放平台的凭据弹窗：填得进去，格子叫对名字。
//
// 两件事，都是「面板自己算一份」留下的毛病：
//
//   1. 通用开放平台（kind openai / anthropic）的推理 Key 那一格曾经根本画不出来：
//      种类登记表把 kind 名当平台 id 去查平台行，查不到就整份返回空数组。面板按
//      0 格提交，服务端按位置要 1 段，保存被段数校验挡下 —— 一个字也写不进去。
//      所以这里验的是**端到端存得下来**：弹窗里贴一把 key，服务端真收到那把 key
//      （按指纹比，不看「有个提示说成功了」）。
//   2. 额度插件那一格的名字只有一处产出：插件自己的声明。面板曾经用
//      `field.label || field.name` 兜出插件的描述性叫法（门户 cookie），与凭据行
//      上的「额度 Cookie」是两套词。这里验弹窗里那一格就叫「额度 Cookie」。
//
// 上游一律指到本机假上游（tests/panel-upstream.ts）：这一套不发一个出机器的请求。
// 平台与账号用 admin RPC 建，收尾自己删掉，不给下一个用例留数据。

import { createHash } from 'node:crypto';
import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import { addAccount, adminRpc, dropPlatform, login, seedPlatform } from './panel.ts';
import { UPSTREAM_BASE, startPanelUpstream } from './panel-upstream.ts';

/** 弹窗里贴的那把推理 key —— 编造的样例。 */
const KEY = 'sk-E2E-OPEN-TESTONLY'; // privacy:allow — 编造的样例

/** 额度那一段贴的值 —— 编造的样例。 */
const COOKIE = 'c=E2E-TESTONLY'; // privacy:allow — 编造的样例

/** 服务端那边这个账号的凭据行。 */
interface CredentialRow {
  accountId?: string;
  kind?: string;
  label?: string;
  fingerprint?: string;
  masked?: string;
}

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
 * 点账号那一行的凭据入口，返回弹窗。
 *
 * 入口的名字由格子数决定（一格写「API Key」，几格写「凭据」，见
 * web/src/features/upstreams/provider-accounts.tsx 的 accessLabel）：格子数本身
 * 就是这两条用例要验的东西，所以名字写死在这里 —— 画不出格子时按钮名不对，
 * 这一步就找不到它。
 */
async function openKeysDialog(
  screen: Screen,
  alias: string,
  entry: 'API Key' | '凭据',
  title: string,
): Promise<Locator> {
  // 账号那张表（有「权重」列、没有「平台」列）：平台那一行把整张账号表包在
  // 自己里面，光按文字找行会同时命中外层那一行。
  const row = screen
    .getByRole('table')
    .filter({ has: screen.getByRole('columnheader', { name: '权重' }) })
    .filter({ hasNot: screen.getByRole('columnheader', { name: '平台' }) })
    .getByRole('row')
    .filter({ hasText: alias });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: entry }).click();
  const dialog = screen.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 服务端现在有这个账号的哪几条凭据。 */
async function credentialsOnServer(accountId: string): Promise<CredentialRow[]> {
  const listed = await adminRpc<{ credentials?: CredentialRow[] }>('ListCredentials', {
    accountId,
  });
  return (listed.credentials ?? []).filter((row) => row.accountId === accountId);
}

/** 值的指纹：与 lib/admin/accounts.ts 的 fingerprintOf 同一个算法。 */
function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** 收尾：这次自己建的平台（连账号与凭据）一起删掉。 */
async function drop(platformId: string): Promise<void> {
  await dropPlatform(platformId).catch(() => {});
}

test('开放平台凭据：通用开放平台（openai）弹窗里贴一把推理 Key，服务端真收到那把 key', async ({
  app,
  screen,
  browser,
}) => {
  await startPanelUpstream();
  const platform = 'e2e-open-keys-plain';
  const label = 'E2E 开放平台一号站';
  await seedPlatform({
    id: platform,
    label,
    kind: 'openai',
    baseUrl: `${UPSTREAM_BASE}/v1`,
  });
  const account = await addAccount(platform, '开放一号');
  try {
    // 前置：这个账号还没有任何凭据（不然「存下来了」可能是原来就有的）。
    expect(await credentialsOnServer(account)).toHaveLength(0);

    await app.open();
    await openAccountsOf(screen, browser, platform);

    // 一格 = 「API Key」入口。格子画不出来时这里就没有这个按钮。
    const dialog = await openKeysDialog(screen, '开放一号', 'API Key', `${label}的凭据`);
    await expect(dialog.getByLabel('推理 Key')).toBeVisible();
    await dialog.getByLabel('推理 Key').fill(KEY);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toHaveCount(0);

    // 服务端真收到那把 key：指纹对得上才算（提示说成功不算）。
    const rows = await credentialsOnServer(account);
    const inference = rows.filter((row) => row.kind === 'api_key');
    expect(inference).toHaveLength(1);
    expect(inference[0].label).toBe('推理 Key');
    expect(inference[0].fingerprint).toBe(fingerprintOf(KEY));

    // 屏上那一行也摆出来了，类型是「推理 Key」。凭据那张表：有「指纹」列、
    // 没有「账号」列（平台那一行把整张凭据表包在自己里面，不排掉会多命中）。
    await expect(
      screen
        .getByRole('table')
        .filter({ has: screen.getByRole('columnheader', { name: '指纹' }) })
        .filter({ hasNot: screen.getByRole('columnheader', { name: '账号' }) })
        .getByRole('row')
        .filter({ hasText: '推理 Key' }),
    ).toHaveCount(1);
  } finally {
    await drop(platform);
  }
});

test('开放平台凭据：插件那一格叫「额度 Cookie」（插件声明说了算，不是面板兜出来的名字）', async ({
  app,
  screen,
  browser,
}) => {
  await startPanelUpstream();
  const platform = 'e2e-open-keys-plugin';
  const label = 'E2E 开放平台二号站';
  // 通用开放平台 + 七牛那个额度插件：插件要的那一段由平台这一行指名。
  await adminRpc('AddPlatform', {
    id: platform,
    label,
    kind: 'openai',
    baseUrl: `${UPSTREAM_BASE}/v1`,
    quotaPlugin: 'qiniu',
  });
  const account = await addAccount(platform, '开放二号');
  try {
    await app.open();
    await openAccountsOf(screen, browser, platform);

    // 两格（推理 Key + 插件那一段）= 「凭据」入口。
    const dialog = await openKeysDialog(screen, '开放二号', '凭据', `${label}的凭据`);
    await expect(dialog.getByLabel('推理 Key')).toBeVisible();
    await expect(dialog.getByLabel('额度 Cookie')).toBeVisible();
    // 面板不许再兜出插件的描述性叫法：那是同一个东西的第二套词。
    const text = (await dialog.textContent()) ?? '';
    expect(text).not.toContain('门户 cookie');
    expect(text).not.toContain('门户账号');

    // 两格都填：位置就是顺序，插件那一段也要真存下来。
    await dialog.getByLabel('推理 Key').fill(KEY);
    await dialog.getByLabel('额度 Cookie').fill(COOKIE);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toHaveCount(0);

    const rows = await credentialsOnServer(account);
    expect(rows.filter((row) => row.kind === 'api_key')).toHaveLength(1);
    const quota = rows.filter((row) => row.kind === 'cookie');
    expect(quota).toHaveLength(1);
    expect(quota[0].label).toBe('额度 Cookie');
    expect(quota[0].fingerprint).toBe(fingerprintOf(COOKIE));
  } finally {
    await drop(platform);
  }
});
