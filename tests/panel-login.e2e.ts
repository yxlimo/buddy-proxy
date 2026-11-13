// tests/panel-login.e2e.ts — 账号登录弹窗。
//
// 这一套只碰面板与面板接口：上游一律关着，一次真请求都不发。所以只覆盖
// **发起登录这一步不需要打上游**的那几种情况 —— 它们的样子由平台的 kind 决定：
//
//   没有登录方式（openai / 用户自建的开放平台）：面板当场说清用 API Key，
//   不开弹窗、不发请求。
//
// 厂商那几类的登录样子（sensenova / tokenrhythm 的账号密码、intern-ai 的 SSO
// 链接）随那几个 kind 一起从代码里拿掉了，它们的用例跟着走了 —— 留着只能拿
// openai 演一遍旧行为。
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

/** 点账号行上的「登录」。 */
async function clickLogin(screen: Screen, alias: string): Promise<void> {
  const row = accountRow(screen, alias);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '登录' }).click();
}


test('没有登录方式的平台（开放平台）：点「登录」当场说清，不开弹窗也不发请求', async ({
  app,
  screen,
  browser,
}) => {
  // 开放平台没有会话登录：凭据就是一把 key。点了要说清没有这道口子，而不是留
  // 一个转圈的弹窗让人等。
  await seedPlatform({ id: 'e2e-open-platform', label: 'E2E 开放站', kind: 'openai' });
  await addAccount('e2e-open-platform', '开放一号');

  await app.open();
  await openAccountsOf(screen, browser, 'e2e-open-platform');

  await clickLogin(screen, '开放一号');

  // 当场说清这个上游没有登录方式（具体那句话由服务端给，不在这里转述一遍）。
  await expect(screen.getByText(/没有登录方式/)).toBeVisible();
  // 没有登录会话，就没有弹窗、没有 login_id。
  await expect(screen.getByRole('dialog')).toHaveCount(0);
  expect(await browser.evaluate<string>('window.location.hash')).toBe('');

  await dropPlatform('e2e-open-platform');
});
