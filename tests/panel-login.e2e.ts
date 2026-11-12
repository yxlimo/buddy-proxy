// tests/panel-login.e2e.ts — 账号登录弹窗。
//
// 这一套只碰面板与面板接口：上游一律关着，一次真请求都不发。所以只覆盖
// **发起登录这一步不需要打上游**的那几类 —— 它们的样子由平台的 kind 决定：
//
//   账号密码型（sensenova / tokenrhythm）：面板摆表单，提交才出去；
//   人机校验型（intern-ai）：面板给一条 SSO 链接，人在浏览器里登完把 token 贴回来。
//
// 设备流（minimax / qoder）与浏览器流（workbuddy / zcode）的 authorize 一步要
// 真去上游换一个设备码或 state，这一套的环境指不到假上游（见交付记录里的缺口），
// 所以不点它们。
//
// 平台用 admin RPC 铺：方言类的平台是用户自己建的（id、地址都由建的人定），
// 建完就在「平台」页那一行展开，登录按钮在账号那一行上。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import { addAccount, dropPlatform, login, seedPlatform } from './panel.ts';

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
 * 账号那一行。
 *
 * 展开之后有两层 `<tr>` 名字里都带别名：外面那一行包着整张账号子表。账号那一行
 * 自己（子表里的）名字**以别名开头**（第一列就是账号），外层那行以表头开头。
 */
function accountRow(screen: Screen, alias: string): Locator {
  return screen.getByRole('row', { name: new RegExp(`^${alias}`) });
}

/** 点账号行上的「登录」，返回登录弹窗。 */
async function startLogin(
  screen: Screen,
  alias: string,
): Promise<Locator> {
  const row = accountRow(screen, alias);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '登录' }).click();
  const dialog = screen.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 关掉弹窗，并确认 hash 里那次登录也清掉了。 */
async function closeLogin(
  screen: Screen,
  browser: Browser,
  dialog: Locator,
): Promise<void> {
  await browser.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // 关掉 = 这次登录不再进行：hash 里不能留一个接不上的 login_id。
  expect(await browser.evaluate<string>('window.location.hash')).toBe('');
}

test('登录弹窗（账号密码型）：SenseNova 只摆账号名与密码，TokenRhythm 才有「记住密码」', async ({
  app,
  screen,
  browser,
}) => {
  // 两个密码型平台：一个留不留密码一样用（sensenova 的 cookie 就是会话），
  // 一个能记住（tokenrhythm）。这一格是平台类别决定的，不是用户勾的。
  await seedPlatform({ id: 'e2e-sensenova', label: 'E2E 密码站', kind: 'sensenova' });
  await seedPlatform({ id: 'e2e-tokenrhythm', label: 'E2E 中转站', kind: 'tokenrhythm' });
  await addAccount('e2e-sensenova', '密码一号');
  await addAccount('e2e-tokenrhythm', '密码二号');

  await app.open();
  await openAccountsOf(screen, browser, 'e2e-sensenova');

  const dialog = await startLogin(screen, '密码一号');
  // 标题说的是这一次登录落在哪个账号上。
  await expect(screen.getByRole('dialog', { name: '登录 密码一号' })).toBeVisible();
  // 密码型不要链接、不要大字码：面板直接摆表单，并说下一步做什么。
  await expect(
    dialog.getByText('在面板中填写账号与密码，然后点击「登录」。'),
  ).toBeVisible();
  await expect(dialog.getByLabel('账号名')).toBeVisible();
  await expect(dialog.getByLabel('密码')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '登录' })).toBeEnabled();
  await expect(dialog.getByRole('link')).toHaveCount(0);
  // sensenova 不摆「记住密码」：登录完后端总会把密码擦掉，给了也说了不算。
  await expect(
    dialog.getByText('记住密码吗（密码会保存在网关上）'),
  ).toHaveCount(0);

  await closeLogin(screen, browser, dialog);

  // 换成能记住密码的那一类：同一个弹窗，多这一格。
  await screen
    .getByRole('button', { name: '展开 e2e-tokenrhythm 的账号与凭据' })
    .click();
  const second = await startLogin(screen, '密码二号');
  await expect(second.getByLabel('账号名')).toBeVisible();
  await expect(second.getByLabel('密码')).toBeVisible();
  await expect(
    second.getByText('记住密码吗（密码会保存在网关上）'),
  ).toBeVisible();
  await expect(second.getByRole('checkbox')).toBeVisible();

  await closeLogin(screen, browser, second);

  await dropPlatform('e2e-sensenova');
  await dropPlatform('e2e-tokenrhythm');
});

test('登录弹窗（人机校验型）：书生·端砚给出 SSO 链接与贴 token 的三步，刷新之后靠 hash 里的 login_id 接得上', async ({
  app,
  screen,
  browser,
}) => {
  await seedPlatform({ id: 'e2e-intern', label: 'E2E 端砚站', kind: 'intern-ai' });
  await addAccount('e2e-intern', '端砚一号');

  await app.open();
  await openAccountsOf(screen, browser, 'e2e-intern');

  // 这一类的账号上没有凭据也能开始登录：凭据是人在浏览器里登完贴回来的 token。
  const dialog = await startLogin(screen, '端砚一号');
  await expect(
    screen.getByRole('dialog', { name: '登录 端砚一号' }),
  ).toBeVisible();

  // 链接是这一步的产物：一条能点开的 SSO 登录地址（发起登录时就该有了）。
  const link = dialog.getByRole('link');
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^https:\/\/[^/]+\/login$/);
  // 链接上写的字就是那个地址（不是「点这里」）。
  expect(await link.textContent()).toContain(String(href).replace(/^https:\/\//, ''));

  // 人机校验怎么办：说清这一步只能人做，以及三步各是什么。
  await expect(dialog.getByText('SSO 登录链接')).toBeVisible();
  await expect(
    dialog.getByText('人机验证需要在浏览器中完成，服务器无法代替：'),
  ).toBeVisible();
  await expect(dialog.getByText('1. 点击上方链接', { exact: false })).toBeVisible();
  await expect(dialog.getByText('找到 uaa-token 并复制其值', { exact: false })).toBeVisible();
  await expect(
    dialog.getByText('3. 将该值粘贴到下方，点击「导入 token」。'),
  ).toBeVisible();

  // 贴回来的那两格：token 输入框与导入按钮。
  await expect(dialog.getByLabel('uaa-token')).toBeVisible();
  await expect(dialog.getByLabel('uaa-token')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: '导入 token' })).toBeEnabled();

  // login_id 记在 hash 里（面板不把令牌放进 URL，只放这次登录的 id）。
  const hash = await browser.evaluate<string>('window.location.hash');
  expect(hash).toMatch(/^#login=[0-9a-f-]{8,}$/);

  // 刷新页面：会话在网关那边，靠 hash 里的 login_id 接得上 —— 弹窗自己回来，
  // 链接还是那一条。
  const url = await browser.url();
  await browser.goto(url);
  const again = screen.getByRole('dialog');
  await expect(again).toBeVisible();
  await expect(again.getByText('SSO 登录链接')).toBeVisible();
  const againHref = await again.getByRole('link').getAttribute('href');
  expect(againHref).toBe(href);
  await expect(again.getByLabel('uaa-token')).toBeVisible();
  expect(await browser.evaluate<string>('window.location.hash')).toBe(hash);

  await closeLogin(screen, browser, again);

  await dropPlatform('e2e-intern');
});

test('登录弹窗（没有登录方式的平台）：点「登录」当场说用 API Key，不开弹窗也不发请求', async ({
  app,
  screen,
  browser,
}) => {
  // 七牛云、讯飞星火这类没有扫码登录：凭据就是一把 key。点了要说清用哪个入口，
  // 而不是留一个转圈的弹窗让人等。
  await seedPlatform({ id: 'e2e-qiniu', label: 'E2E 七牛站', kind: 'qiniu' });
  await addAccount('e2e-qiniu', '七牛一号');

  await app.open();
  await openAccountsOf(screen, browser, 'e2e-qiniu');

  const row = accountRow(screen, '七牛一号');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '登录' }).click();

  // 当场说清：这类平台不扫码登录，用「API Key」那个入口。
  await expect(
    screen.getByText(/七牛云不扫码登录.*API Key/),
  ).toBeVisible();
  // 没有登录会话，就没有弹窗、没有 login_id。
  await expect(screen.getByRole('dialog')).toHaveCount(0);
  expect(await browser.evaluate<string>('window.location.hash')).toBe('');

  await dropPlatform('e2e-qiniu');
});
