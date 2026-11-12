// tests/panel-token-gate.e2e.ts — 令牌闸门。
//
// 面板没有自己的登录页：第一个打开它的人先被问一句访问令牌（网关启动时生成在
// 数据目录里）。没填对之前，面板里的东西一条都不该出来。

import { expect, credentials } from 'e2e';
import { test } from '@e2e-dev/web';

test('令牌闸门：没令牌时只看到输入框，填错仍留在闸门页，填对才进面板', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();

  // 闸门在：标题、说明、输入框、按钮都在，面板本身还没出来。
  await expect(screen.getByText('输入访问令牌')).toBeVisible();
  await expect(screen.getByLabel('访问令牌')).toBeVisible();
  await expect(screen.getByRole('button', { name: '进入面板' })).toBeDisabled();
  await expect(screen.getByRole('heading', { name: '总览' })).toBeHidden();

  // 填一个错的：当场说不对，人还在闸门页，面板没被放进来。
  await screen.getByLabel('访问令牌').fill('definitely-not-the-token-0000');
  await screen.getByRole('button', { name: '进入面板' }).click();
  await expect(screen.getByRole('alert')).toBeVisible();
  await expect(screen.getByText('输入访问令牌')).toBeVisible();
  await expect(screen.getByRole('heading', { name: '总览' })).toBeHidden();

  // 换成真的那一份：进面板，落到总览。
  await screen.getByLabel('访问令牌').fill(credentials.user('admin').password);
  await screen.getByRole('button', { name: '进入面板' }).click();
  await expect(screen.getByRole('heading', { name: '总览' })).toBeVisible();
  await expect(screen.getByText('输入访问令牌')).toBeHidden();

  // 令牌存在浏览器这边（只读它有没有、不说值），URL 里不出现它。
  expect(await browser.evaluate<string>('window.localStorage.getItem("buddy.admin.token") ? "yes" : "no"')).toBe('yes');
  expect(await browser.url()).not.toContain('token=');

  // 把令牌清掉再打开面板：又回到闸门（不是带着旧状态直接进去）。
  await browser.evaluate('window.localStorage.removeItem("buddy.admin.token")');
  await browser.goto('/admin/config');
  await expect(screen.getByText('输入访问令牌')).toBeVisible();
  await expect(screen.getByRole('heading', { name: '配置' })).toBeHidden();
});
