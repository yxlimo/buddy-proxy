// tests/panel-login-flows.e2e.ts — 设备码 / 浏览器型登录：面板上点「登录」，
// 弹窗里那段码与那条链接就是上游这一趟给的答复。
//
// 这四家的「发起」都要问上游一句（Qoder 除外，它的挑战是本地算的），而它们的
// 基址都由设置给（`MINIMAX_OAUTH_ORIGIN`、`WORKBUDDY_CN_BASE`/`_ORIGIN`、
// `ZCODE_BASE_URL`、`QODER_CN_OPENAPI_BASE`）：`test/panel-e2e-app.sh` 把这些
// 一格一格指到本机的假上游，所以这一套一次真上游都不打。
//
// 断言的东西：
//   · 弹窗起来了，里面那段大字码 / 那条授权链接**逐字**等于实录里的值 ——
//     面板上看见的字是上游这一趟说的话，不是面板自己拼的；
//   · 之后的轮询我们答「还在等」，所以弹窗一直停在「正在等你同意」：既没有
//     翻成「登录完成」（没人点过同意），也没有翻成失败（答的不是错误）；
//   · 关掉弹窗 = 这次登录取消：账号上一条凭据都没有（登录没完成）。
//
// 不去点「已批准」：上游那份答复（同意之后给的会话）没有录下来，编一份就等于
// 假造上游说的话。这一套只走到「等」为止。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import { addAccount, adminRpc, login } from './panel.ts';
import { FIXTURE, readFixture, startPanelUpstream } from './panel-upstream.ts';

/** 进「平台」页并展开某个平台那一行的账号区（与 panel-login.e2e.ts 同一套动作）。 */
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

/** 账号那一行（名字以别名开头的那一条，见 panel-login.e2e.ts 的说明）。 */
function accountRow(screen: Screen, alias: string): Locator {
  return screen.getByRole('row', { name: new RegExp(`^${alias}`) });
}

/** 点账号行上的「登录」，返回登录弹窗。 */
async function startLogin(screen: Screen, alias: string): Promise<Locator> {
  const row = accountRow(screen, alias);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '登录' }).click();
  const dialog = screen.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * 关掉弹窗，并确认这次登录是真的取消了。
 *
 * 关掉 = 这次登录不再进行，但**账号还在**、只是没有凭据：登录没完成。
 */
async function cancelLogin(
  screen: Screen,
  browser: Browser,
  dialog: Locator,
  accountId: string,
): Promise<void> {
  await browser.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await browser.evaluate<string>('window.location.hash')).toBe('');
  const listed = await adminRpc<{ accounts?: Array<{ id?: string; status?: string }> }>(
    'ListAccounts',
  );
  const account = (listed.accounts ?? []).find((entry) => entry.id === accountId);
  expect(account).toBeDefined();
  // missing = 没登录（凭据那一行在，但它是空的）；usable 才是「登录完成、能推理」。
  expect(account?.status).toBe('missing');
  const credentials = await adminRpc<{
    credentials?: Array<{ accountId?: string; status?: string; kind?: string }>;
  }>('ListCredentials', { accountId });
  const mine = (credentials.credentials ?? []).filter(
    (entry) => entry.accountId === accountId,
  );
  // 登录没完成：这个账号上一条能用的凭据都没有。
  expect(mine.filter((entry) => entry.status === 'usable')).toHaveLength(0);
}

/** 弹窗上等的那个状态（授权链接型共用的那一句）。 */
const WAITING = '正在等你在浏览器里同意…';

test('登录弹窗（MiniMax 设备流）：大字码与授权链接就是实录里那一条，轮询答「还在等」就一直等，关掉之后账号上没有凭据', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();
  const fixture = JSON.parse(readFixture(FIXTURE.minimaxDeviceCode).body) as {
    user_code: string;
    verification_uri_complete: string;
  };

  const account = await addAccount('minimax', '设备一号');
  try {
    await app.open();
    await openAccountsOf(screen, browser, 'minimax');
    const dialog = await startLogin(screen, '设备一号');
    await expect(screen.getByRole('dialog', { name: '登录 设备一号' })).toBeVisible();

    // 大字码：上游给的 user_code，逐字。
    await expect(dialog.getByText('大字码')).toBeVisible();
    await expect(dialog.getByText(fixture.user_code, { exact: true })).toBeVisible();
    await expect(dialog.getByText('授权页上要填这个码。')).toBeVisible();

    // 授权链接：上游给的 verification_uri_complete，逐字（链接上写的字也是它）。
    const link = dialog.getByRole('link');
    await expect(link).toHaveCount(1);
    expect(await link.getAttribute('href')).toBe(fixture.verification_uri_complete);
    expect(await link.textContent()).toContain(fixture.verification_uri_complete);

    // 发起真的问过上游：一条 device/code（实录答的），之后是轮询（我们答还在等）。
    const code = upstream.hits.filter((hit) => hit.path === '/oauth2/device/code');
    expect(code).toHaveLength(1);
    expect(code[0]?.fixture).toBe(FIXTURE.minimaxDeviceCode);
    await expect
      .poll(() => upstream.hits.filter((hit) => hit.path === '/oauth2/token').length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // 轮询答的还是「等」：弹窗停在那一句，没有翻成成功或失败。
    await expect(dialog.getByText(WAITING)).toBeVisible();

    await cancelLogin(screen, browser, dialog, account);
  } finally {
    await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

test('登录弹窗（WorkBuddy 浏览器流）：授权链接就是实录里的 authUrl，轮询答「还在等」，关掉之后账号上没有凭据', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();
  const fixture = JSON.parse(readFixture(FIXTURE.workbuddyLogin).body) as {
    data: { authUrl: string; state: string };
  };

  const account = await addAccount('workbuddy-cn', '浏览器一号');
  try {
    await app.open();
    await openAccountsOf(screen, browser, 'workbuddy-cn');
    const dialog = await startLogin(screen, '浏览器一号');
    await expect(screen.getByRole('dialog', { name: '登录 浏览器一号' })).toBeVisible();

    // WorkBuddy 没有大字码，只有一条链接：链接与 state 都来自那份答复。
    const link = dialog.getByRole('link');
    await expect(link).toHaveCount(1);
    expect(await link.getAttribute('href')).toBe(fixture.data.authUrl);
    await expect(dialog.getByText('大字码')).toHaveCount(0);

    const start = upstream.hits.filter((hit) => hit.path === '/v2/plugin/auth/state');
    expect(start).toHaveLength(1);
    expect(start[0]?.fixture).toBe(FIXTURE.workbuddyLogin);
    expect(start[0]?.query).toContain('platform=workbuddy');

    // 轮询：带上 spawning 那一趟的 state，答「还在等」（code 11217）。
    await expect
      .poll(() => upstream.hits.filter((hit) => hit.path === '/v2/plugin/auth/token').length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const poll = upstream.hits.find((hit) => hit.path === '/v2/plugin/auth/token');
    expect(poll?.query).toContain(encodeURIComponent(fixture.data.state));

    await expect(dialog.getByText(WAITING)).toBeVisible();

    await cancelLogin(screen, browser, dialog, account);
  } finally {
    await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

test('登录弹窗（ZCode 浏览器流）：授权链接与 flow_id 是实录里的那一条，轮询按那个 flow_id 问、答「还在等」，关掉之后账号上没有凭据', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();
  const fixture = JSON.parse(readFixture(FIXTURE.zcodeLogin).body) as {
    data: { authorize_url: string; flow_id: string };
  };

  const account = await addAccount('zcode', 'Z码一号');
  try {
    await app.open();
    await openAccountsOf(screen, browser, 'zcode');
    const dialog = await startLogin(screen, 'Z码一号');
    await expect(screen.getByRole('dialog', { name: '登录 Z码一号' })).toBeVisible();

    const link = dialog.getByRole('link');
    await expect(link).toHaveCount(1);
    expect(await link.getAttribute('href')).toBe(fixture.data.authorize_url);

    const init = upstream.hits.filter((hit) => hit.path === '/api/v1/oauth/cli/init');
    expect(init).toHaveLength(1);
    expect(init[0]?.fixture).toBe(FIXTURE.zcodeLogin);

    // 轮询问的是 init 给的那个 flow_id：留下的是实录里的值，不是另编的。
    await expect
      .poll(() => upstream.hits.filter((hit) => hit.path.includes('/oauth/cli/poll/')).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const poll = upstream.hits.find((hit) => hit.path.includes('/oauth/cli/poll/'));
    expect(poll?.path).toContain(fixture.data.flow_id);

    await expect(dialog.getByText(WAITING)).toBeVisible();

    await cancelLogin(screen, browser, dialog, account);
  } finally {
    await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

test('登录弹窗（Qoder 中国区）：链接是本地算的挑战页，轮询按实录的 404 回「还在等」，关掉之后账号上没有凭据', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  const account = await addAccount('qoder-cn', 'Q码一号');
  try {
    await app.open();
    await openAccountsOf(screen, browser, 'qoder-cn');
    const dialog = await startLogin(screen, 'Q码一号');
    await expect(screen.getByRole('dialog', { name: '登录 Q码一号' })).toBeVisible();

    // Qoder 没有上游给的 device code：挑账号那一页的地址是本地算出来的（挑战
    // 与 nonce 都在 query 里）。这里只说得出「它指向哪个站的哪一页」。
    const link = dialog.getByRole('link');
    await expect(link).toHaveCount(1);
    const href = String(await link.getAttribute('href'));
    expect(href).toContain('/device/selectAccounts?');
    expect(href).toContain('challenge_method=S256');
    // 没有大字码：Qoder 的码就是挑战本身。
    await expect(dialog.getByText('大字码')).toHaveCount(0);

    // 轮询真的打了上游，而且答的就是实录那一份（Qoder 用 404 说「还没同意」）。
    await expect
      .poll(() => upstream.hits.filter((hit) => hit.path === '/api/v1/deviceToken/poll').length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const poll = upstream.hits.find((hit) => hit.path === '/api/v1/deviceToken/poll');
    expect(poll?.fixture).toBe(FIXTURE.qoderPoll);
    // 前提：这份实录必须是 404（404 才是它说的「还没同意」）。不是断言 —— 它比的是
    // fixture 里那个状态码与测试常量，验不到产品。真正要断的是下面那条「弹窗还在等」。
    if (fixtureStatus(FIXTURE.qoderPoll) !== 404) {
      throw new Error(`fixture ${FIXTURE.qoderPoll} 不是 404，测试的前提没了`);
    }

    // 404 读成「等」：弹窗还在等，没有翻成失败。
    await expect(dialog.getByText(WAITING)).toBeVisible();

    await cancelLogin(screen, browser, dialog, account);
  } finally {
    await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

/** 这份实录答的是什么状态码（上面那条前提用：轮询那份必须是 404 = 还在等）。 */
function fixtureStatus(name: string): number {
  return readFixture(name).status;
}
