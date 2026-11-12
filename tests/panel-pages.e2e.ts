// tests/panel-pages.e2e.ts — 面板的六个页面、深链接、静态托管、控制台报错。
//
// 这一份验的是「面板自己立得住」：每一页都打开得出来、标题是它自己的、深链接
// 刷新之后还在那一页、静态文件按该有的方式答（存在 200、不存在 404、/admin
// 跳到 /admin/），以及全程一条报错都没有。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import { BASE, consoleErrors, login, watchConsole } from './panel.ts';

/** 侧栏那一列：点进去之后该看到的标题与地址。 */
const PAGES = [
  { link: '总览', heading: '总览', path: '/admin/' },
  { link: '平台', heading: '平台', path: '/admin/upstreams' },
  { link: '额度', heading: '额度', path: '/admin/balance' },
  { link: '用量', heading: '用量', path: '/admin/usage' },
  { link: '主路由模型', heading: '主路由模型', path: '/admin/models' },
  { link: '配置', heading: '配置', path: '/admin/config' },
] as const;

test('侧栏六个页面都进得去，每页有自己的标题，没有白屏', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await login(screen);

  for (const page of PAGES) {
    await screen.getByRole('link', { name: page.link }).click();
    await expect(screen.getByRole('heading', { name: page.heading })).toBeVisible();
    await expect(browser).toHaveURL(page.path);
    // 不是白屏：除了标题，页面上还得有真正的内容（空状态也算内容 ——
    // 「额度」页在没有账号时就只有一句空状态）。
    const text = await browser.evaluate<string>('document.body.innerText');
    expect(text.length).toBeGreaterThan(80);
    expect(text).toContain(page.heading);
  }
});

test('深链接：直接打开 /admin/balance，刷新之后还是额度页', async ({
  app,
  screen,
  browser,
}) => {
  // 先过一次闸门，令牌存进 localStorage：之后直接开深链接就是「刷新」那种情形。
  await app.open();
  await login(screen);

  await browser.goto('/admin/balance');
  await expect(screen.getByRole('heading', { name: '额度' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/balance');

  await browser.reload();
  // 没被踢回闸门、也不是 404：还是额度页。
  await expect(screen.getByRole('heading', { name: '额度' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/balance');
  await expect(screen.getByText('输入访问令牌')).toBeHidden();
});

test('静态托管：/admin 跳到 /admin/，存在的资源 200、不存在的 404，深链接回面板本身', async () => {
  const root = await fetch(`${BASE}/admin`, { redirect: 'manual' });
  expect(root.status).toBe(302);
  expect(root.headers.get('location')).toBe('/admin/');

  const index = await fetch(`${BASE}/admin/`);
  expect(index.status).toBe(200);
  expect(index.headers.get('content-type')).toContain('text/html');
  const html = await index.text();
  const asset = /\/admin\/assets\/[^"']+\.js/.exec(html)?.[0];
  expect(asset).toBeTruthy();

  const script = await fetch(`${BASE}${asset}`);
  expect(script.status).toBe(200);
  expect(script.headers.get('content-type')).toContain('javascript');

  const missing = await fetch(`${BASE}/admin/assets/does-not-exist.js`);
  expect(missing.status).toBe(404);

  // 深链接是前端路由，服务端要把它交回 index.html（200），不能 404。
  const deep = await fetch(`${BASE}/admin/config`);
  expect(deep.status).toBe(200);
  expect(deep.headers.get('content-type')).toContain('text/html');
});

test('控制台：走完六个页面、开了两个弹窗，全程 0 条报错', async ({
  app,
  screen,
  browser,
}) => {
  await watchConsole(browser);
  await app.open();
  await login(screen);

  for (const page of PAGES) {
    await screen.getByRole('link', { name: page.link }).click();
    await expect(screen.getByRole('heading', { name: page.heading })).toBeVisible();
  }

  // 两个最容易炸的弹窗：新增平台（下拉里两组长清单）与改配置（热设置的写入）。
  await screen.getByRole('link', { name: '平台' }).click();
  await screen.getByRole('button', { name: '新增平台' }).click();
  await expect(screen.getByRole('dialog', { name: '新增平台' })).toBeVisible();
  // 弹窗里那份模板清单很长，底部的按钮在滚动区外面：用 Esc 关，跟按了「取消」一样。
  await browser.keyboard.press('Escape');
  await expect(screen.getByRole('dialog', { name: '新增平台' })).toBeHidden();

  await screen.getByRole('link', { name: '配置' }).click();
  await screen.getByRole('tab', { name: /网关/ }).click();
  await screen
    .getByRole('row')
    .filter({ hasText: '流空闲上限' })
    .getByRole('button', { name: '改' })
    .click();
  await expect(screen.getByRole('dialog')).toBeVisible();
  await browser.keyboard.press('Escape');
  await expect(screen.getByRole('dialog')).toBeHidden();

  // 断言的是条数，不是「页面没崩」：一条 console.error 都算失败。
  expect(await consoleErrors(browser)).toEqual([]);
});
