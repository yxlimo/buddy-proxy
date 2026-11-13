// tests/panel-platform-actions.e2e.ts — 「平台」页的动作列在窄视口下不被挤出可视区。
//
// 曾经的毛病：1024 视口下表格最小宽 972px > 内容区 724px（侧栏 256px），操作列
// 整个落在屏幕外 —— 编辑 / 刷新模型目录 / 删除 / 新增账号 都看不见也点不到。
//
// 这里量的是「真的能点」：按钮可见、可使能，并且按钮中心点上的元素就是按钮自己
// （elementFromPoint）—— 被别的元素盖住、或者被推出视口，都算点不到。
// 除了量，还要真的点：点开弹窗就是点到了。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Screen } from 'e2e';
import {
  addAccount,
  dropPlatform,
  login,
  seedPlatform,
  setAccountKey,
} from './panel.ts';

/** 平台行上那一组动作按钮。 */
const PLATFORM_ACTIONS = [
  '自定义模型',
  '编辑',
  '刷新模型目录',
  '删除',
  '新增账号',
];

/** 一个按钮的几何与命中情况。 */
type Hit = {
  name: string;
  found: boolean;
  /** 中心点命中的元素就在按钮里（没被盖住、也没被推出视口）。 */
  ok: boolean;
  disabled: boolean;
  /** 命中的那个元素（说清是谁盖住了按钮）。 */
  hit: string | null;
  rect: { x: number; y: number; width: number; height: number } | null;
};

/** 进「平台」页。 */
async function openPlatforms(screen: Screen): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
}

/**
 * 在含有 `rowText` 的那一行里，量这几个按钮。
 *
 * 量的是视口坐标（getBoundingClientRect）与 elementFromPoint —— 后者说的是
 * 「那个点上真正接收事件的是谁」。
 */
async function hitTest(
  browser: Browser,
  rowText: string,
  names: string[],
): Promise<Hit[]> {
  return browser.evaluate<Hit[]>(`(() => {
    // 最里面那一行：展开的平台行套着账号子表，document 顺序上外层在前。
    const innermostRow = (label) => {
      const rows = Array.from(document.querySelectorAll('tr')).filter(
        (r) => (r.textContent || '').includes(label),
      );
      return rows.length ? rows[rows.length - 1] : null;
    };
    const label = ${JSON.stringify(rowText)};
    const names = ${JSON.stringify(names)};
    const row = innermostRow(label);
    if (!row) return names.map((name) => ({
      name, found: false, ok: false, disabled: false, hit: null, rect: null,
    }));
    const buttons = Array.from(row.querySelectorAll('button'));
    return names.map((name) => {
      const button = buttons.find(
        (b) => (b.textContent || '').trim().includes(name),
      );
      if (!button) {
        return { name, found: false, ok: false, disabled: false, hit: null, rect: null };
      }
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === button || button.contains(hit));
      return {
        name,
        found: true,
        ok,
        disabled: button.disabled,
        hit: hit ? hit.tagName + '[' + (hit.textContent || '').trim().slice(0, 12) + ']' : null,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      };
    });
  })()`);
}

/** 全页里量这几个按钮（不限定行）。 */
async function hitTestGlobal(
  browser: Browser,
  names: string[],
): Promise<Hit[]> {
  return browser.evaluate<Hit[]>(`(() => {
    const names = ${JSON.stringify(names)};
    const buttons = Array.from(document.querySelectorAll('button'));
    return names.map((name) => {
      const button = buttons.find(
        (b) => (b.textContent || '').trim().includes(name),
      );
      if (!button) {
        return { name, found: false, ok: false, disabled: false, hit: null, rect: null };
      }
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === button || button.contains(hit));
      return {
        name,
        found: true,
        ok,
        disabled: button.disabled,
        hit: hit ? hit.tagName + '[' + (hit.textContent || '').trim().slice(0, 12) + ']' : null,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      };
    });
  })()`);
}

/** 表格容器的横向溢出（scrollWidth 比 clientWidth 多出来就是溢出）。 */
async function tableOverflow(
  browser: Browser,
  rowText: string,
): Promise<{ scrollWidth: number; clientWidth: number } | null> {
  return browser.evaluate<{ scrollWidth: number; clientWidth: number } | null>(`(() => {
    const innermostRow = (label) => {
      const rows = Array.from(document.querySelectorAll('tr')).filter(
        (r) => (r.textContent || '').includes(label),
      );
      return rows.length ? rows[rows.length - 1] : null;
    };
    const label = ${JSON.stringify(rowText)};
    const row = innermostRow(label);
    if (!row) return null;
    const table = row.closest('table');
    const container = table ? table.parentElement : null;
    if (!container) return null;
    return {
      scrollWidth: container.scrollWidth,
      clientWidth: container.clientWidth,
    };
  })()`);
}

/** 那一行里的动作按钮有几个。 */
async function actionCount(
  browser: Browser,
  rowText: string,
): Promise<number> {
  return browser.evaluate<number>(`(() => {
    const innermostRow = (label) => {
      const rows = Array.from(document.querySelectorAll('tr')).filter(
        (r) => (r.textContent || '').includes(label),
      );
      return rows.length ? rows[rows.length - 1] : null;
    };
    const label = ${JSON.stringify(rowText)};
    const row = innermostRow(label);
    if (!row) return -1;
    const cells = Array.from(row.querySelectorAll('td'));
    const last = cells[cells.length - 1];
    return last ? last.querySelectorAll('button').length : -1;
  })()`);
}

test('1024 视口：平台行的五个动作按钮都可见、可使能、点得到', async ({
  app,
  screen,
  browser,
}) => {
  await seedPlatform({ id: 'e2e-narrow-1024', label: 'E2E 窄屏站1024', kind: 'openai' });
  await app.open();
  await browser.setViewport({ width: 1024, height: 800 });
  await openPlatforms(screen);

  const row = screen.getByRole('row').filter({ hasText: 'E2E 窄屏站1024' });
  await expect(row).toBeVisible();

  // 逐个：可见、可使能。
  for (const name of PLATFORM_ACTIONS) {
    const button = row.getByRole('button', { name });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  }

  // 点得到：中心点上命中的元素得在按钮自己里面。
  const hits = await hitTest(browser, 'E2E 窄屏站1024', PLATFORM_ACTIONS);
  for (const hit of hits) {
    expect(
      hit.found,
      `按钮「${hit.name}」不在这一行里`,
    ).toBe(true);
    expect(
      hit.ok,
      `按钮「${hit.name}」点不到（中心点命中的是 ${hit.hit ?? '什么都没有'}）`,
    ).toBe(true);
    expect(hit.disabled, `按钮「${hit.name}」是禁用的`).toBe(false);
  }

  // 真的点：点开了弹窗就是点到了。
  await row.getByRole('button', { name: '自定义模型' }).click();
  await expect(screen.getByRole('dialog')).toBeVisible();
  await screen.getByRole('button', { name: '取消' }).click();
  await expect(screen.getByRole('dialog')).toBeHidden();

  await row.getByRole('button', { name: '编辑' }).click();
  await expect(
    screen.getByRole('dialog', { name: '改平台 E2E 窄屏站1024' }),
  ).toBeVisible();
  await screen.getByRole('button', { name: '取消' }).click();
  await expect(screen.getByRole('dialog')).toBeHidden();

  await row.getByRole('button', { name: '新增账号' }).click();
  await expect(screen.getByRole('dialog', { name: '新增账号' })).toBeVisible();
  await screen.getByRole('button', { name: '取消' }).click();
  await expect(screen.getByRole('dialog')).toBeHidden();

  await row.getByRole('button', { name: '删除' }).click();
  await expect(screen.getByRole('alertdialog')).toBeVisible();
  await screen.getByRole('alertdialog').getByRole('button', { name: '取消' }).click();
  await expect(screen.getByRole('alertdialog')).toBeHidden();

  await dropPlatform('e2e-narrow-1024');
});

test('900 视口：平台行的五个动作按钮都可见、可使能、点得到', async ({
  app,
  screen,
  browser,
}) => {
  await seedPlatform({ id: 'e2e-narrow-900', label: 'E2E 窄屏站900', kind: 'openai' });
  await app.open();
  await browser.setViewport({ width: 900, height: 800 });
  await openPlatforms(screen);

  const row = screen.getByRole('row').filter({ hasText: 'E2E 窄屏站900' });
  await expect(row).toBeVisible();

  for (const name of PLATFORM_ACTIONS) {
    const button = row.getByRole('button', { name });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  }

  const hits = await hitTest(browser, 'E2E 窄屏站900', PLATFORM_ACTIONS);
  for (const hit of hits) {
    expect(hit.found, `按钮「${hit.name}」不在这一行里`).toBe(true);
    expect(
      hit.ok,
      `按钮「${hit.name}」点不到（中心点命中的是 ${hit.hit ?? '什么都没有'}）`,
    ).toBe(true);
  }

  // 真的点一个：点得动。
  await row.getByRole('button', { name: '编辑' }).click();
  await expect(
    screen.getByRole('dialog', { name: '改平台 E2E 窄屏站900' }),
  ).toBeVisible();
  await screen.getByRole('button', { name: '取消' }).click();
  await expect(screen.getByRole('dialog')).toBeHidden();

  await dropPlatform('e2e-narrow-900');
});

test('1920 视口：五个动作按钮还在一行摆开，表格没有横向溢出', async ({
  app,
  screen,
  browser,
}) => {
  await seedPlatform({ id: 'e2e-wide-1920', label: 'E2E 宽屏站', kind: 'openai' });
  await app.open();
  await browser.setViewport({ width: 1920, height: 900 });
  await openPlatforms(screen);

  const row = screen.getByRole('row').filter({ hasText: 'E2E 宽屏站' });
  await expect(row).toBeVisible();

  for (const name of PLATFORM_ACTIONS) {
    await expect(row.getByRole('button', { name })).toBeVisible();
    await expect(row.getByRole('button', { name })).toBeEnabled();
  }

  // 还是那五个按钮。
  expect(await actionCount(browser, 'E2E 宽屏站')).toBe(PLATFORM_ACTIONS.length);

  // 一行摆开：几个按钮的 y 坐标一样（差值不超过按钮高度的一半）。
  const hits = await hitTest(browser, 'E2E 宽屏站', PLATFORM_ACTIONS);
  const tops = hits.map((hit) => hit.rect?.y ?? 0);
  const heights = hits.map((hit) => hit.rect?.height ?? 0);
  for (const hit of hits) {
    expect(hit.ok, `按钮「${hit.name}」点不到`).toBe(true);
  }
  const minTop = Math.min(...tops);
  const maxTop = Math.max(...tops);
  const maxHeight = Math.max(...heights);
  expect(
    maxTop - minTop,
    `按钮不在同一行：y 坐标 ${JSON.stringify(tops)}`,
  ).toBeLessThan(maxHeight / 2);

  // 没有横向溢出。
  const overflow = await tableOverflow(browser, 'E2E 宽屏站');
  expect(overflow).not.toBeNull();
  expect(
    overflow?.scrollWidth,
    `表格横向溢出：scrollWidth=${overflow?.scrollWidth} clientWidth=${overflow?.clientWidth}`,
  ).toBe(overflow?.clientWidth);

  await dropPlatform('e2e-wide-1920');
});

test('1024 视口：账号子表里的动作按钮也可见、可点', async ({
  app,
  screen,
  browser,
}) => {
  await seedPlatform({ id: 'e2e-accounts', label: 'E2E 账号站', kind: 'openai' });
  const accountId = await addAccount('e2e-accounts', '探针一号');
  await setAccountKey(accountId, 'e2e-probe-key');
  await app.open();
  await browser.setViewport({ width: 1024, height: 800 });
  await openPlatforms(screen);

  const row = screen.getByRole('row').filter({ hasText: 'E2E 账号站' });
  await expect(row).toBeVisible();

  // 展开这一行，账号子表出来。
  await row.getByRole('button', { name: '展开 e2e-accounts 的账号与凭据' }).click();
  const accountRow = screen.getByRole('row').filter({ hasText: '探针一号' }).last();
  await expect(accountRow).toBeVisible();

  // 账号这一行的动作按钮：凭据入口、登录、注销。
  const credentialButton = accountRow.getByRole('button', {
    name: /API Key|凭据/,
  });
  await expect(credentialButton).toBeVisible();
  await expect(credentialButton).toBeEnabled();
  await expect(accountRow.getByRole('button', { name: '登录' })).toBeVisible();
  await expect(
    accountRow.getByRole('button', { name: '注销 探针一号' }),
  ).toBeVisible();

  const hits = await hitTest(browser, '探针一号', [
    'API Key',
    '凭据',
    '登录',
    '注销',
  ]);
  // 凭据入口的文案是「API Key」或「凭据」，两个都算它在。
  const credentialHits = hits.filter(
    (hit) => hit.name === 'API Key' || hit.name === '凭据',
  );
  expect(
    credentialHits.some((hit) => hit.found),
    '账号那一行没有凭据入口按钮',
  ).toBe(true);
  for (const hit of hits) {
    if (!hit.found) continue;
    expect(
      hit.ok,
      `按钮「${hit.name}」点不到（中心点命中的是 ${hit.hit ?? '什么都没有'}）`,
    ).toBe(true);
  }

  // 真的点一个：凭据弹窗开起来就是点到了。
  await credentialButton.click();
  await expect(screen.getByRole('dialog')).toBeVisible();
  await screen.getByRole('button', { name: '取消' }).click();
  await expect(screen.getByRole('dialog')).toBeHidden();

  // 凭据那张表（7 列）里的「试一下」也一样点得到（不点：它会打上游）。
  const probe = screen.getByRole('button', { name: '试一下' });
  await expect(probe).toBeVisible();
  const probeHit = await hitTestGlobal(browser, ['试一下']);
  for (const hit of probeHit) {
    expect(hit.found, '凭据那一行没有「试一下」按钮').toBe(true);
    expect(
      hit.ok,
      `按钮「试一下」点不到（中心点命中的是 ${hit.hit ?? '什么都没有'}）`,
    ).toBe(true);
  }

  await dropPlatform('e2e-accounts');
});
