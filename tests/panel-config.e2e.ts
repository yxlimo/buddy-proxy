// tests/panel-config.e2e.ts — 「配置」页：界面上的配置项与接口给的清单一致、
// 分组的中文名、热设置的生效。
//
// 先问接口，再对界面：用例开头调 ListConfig（面板自己也会调的那个 RPC）拿到
// 真实的配置项清单，然后断言界面上画的就是那些 —— 一项不多、一项不少，每组
// 的条数、名字、分组都对得上。后端加一项、改名、改分组，这条用例自动仍然绿
// （只要页面没画坏）；页面漏画、多画、把组名画成英文，才会红。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import { adminRpc, login } from './panel.ts';

/**
 * 分组键的中文名。
 *
 * 服务端给的 group 是英文的键（general、gateway……），面板翻成中文，翻不出
 * 来的原样显示。这里只列已知的翻译；新冒出来的组走 fallback，不需要改用例。
 */
const GROUP_LABELS: Record<string, string> = {
  general: '常规',
  gateway: '网关',
  benefits: '签到',
  qoder: 'Qoder',
};

/** 一项在接口里的样子（ListConfig 回的，字段是 camelCase）。 */
interface RpcItem {
  key: string;
  label: string;
  group: string;
}

/**
 * 从接口给的清单推出「界面应该长什么样」：按分组合并，组名用中文。
 *
 * 顺序照面板的画法：general、gateway 这两个固定的排前面，其余的组按清单里
 * 出现的先后接在后面（web/src/features/config/index.tsx 的 GROUP_ORDER）。
 */
function expectedGroups(items: RpcItem[]): Array<{
  tab: string;
  items: RpcItem[];
}> {
  const map = new Map<string, RpcItem[]>();
  for (const item of items) {
    const group = item.group || 'general';
    const list = map.get(group) ?? [];
    list.push(item);
    map.set(group, list);
  }
  const known = ['general', 'gateway'].filter((group) => map.has(group));
  const extra = [...map.keys()].filter((group) => !['general', 'gateway'].includes(group));
  return [...known, ...extra].map((group) => ({
    tab: GROUP_LABELS[group] ?? group,
    items: map.get(group) ?? [],
  }));
}

/** 「网关 (7)」→ { name: '网关', count: 7 }。 */
function parseTab(text: string): { name: string; count: number } {
  const match = /^(.*?)\s*\((\d+)\)/.exec(text.trim());
  if (!match) throw new Error(`tab 上的字看不懂：${text}`);
  return { name: match[1].trim(), count: Number(match[2]) };
}

test('配置页：界面上的项与 ListConfig 给的清单一致，分组 tab 是中文名（不是 gateway / benefits / qoder）', async ({
  app,
  screen,
  browser,
}) => {
  // 先问接口：面板启动时本来就会调 ListConfig，这里要同一份清单当基准。
  const listed = await adminRpc<{
    items?: RpcItem[];
  }>('ListConfig');
  const items = listed.items ?? [];
  expect(items.length).toBeGreaterThan(0);
  const groups = expectedGroups(items);

  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '配置' }).click();
  await expect(screen.getByRole('heading', { name: '配置' })).toBeVisible();

  const tabs = (await screen.getByRole('tab').allTextContents()).map(parseTab);
  // 分组与顺序：接口给出的每一组都在，先后也一致。服务端给的是英文的键，
  // 面板要翻译过来 —— 翻译漏了就会看见 gateway / benefits / qoder。
  expect(tabs.map((tab) => tab.name)).toEqual(groups.map((group) => group.tab));
  // 每组括号里的条数与接口给的那一组一致。
  expect(tabs.map((tab) => tab.count)).toEqual(groups.map((group) => group.items.length));
  // 英文的组名一个都不该露在界面上。
  for (const english of ['gateway', 'benefits', 'qoder', 'general']) {
    await expect(screen.getByRole('tab', { name: english })).toHaveCount(0);
  }

  // 打开就停在第一组（不是空白的一屏，也不是最后点过的那一组）。
  await expect(screen.getByRole('tab').first()).toBeSelected();

  // 面板不该露出来的内部设置：上游地址、端口、轮询窗口这些改了也没用 ——
  // 露出来只会让人改出坏状态。键名与短名字都不该出现。
  for (const internal of [
    'ROUTER_PORT',
    'MINIMAX_API_BASE',
    'QODER_POLL_INTERVAL_MS',
    'HEALTH_CACHE_MS',
  ]) {
    await expect(screen.getByText(internal, { exact: true })).toHaveCount(0);
  }

  // 每一项都在它那一组里：点进去，接口给的每个名字都要在，行数不多不少。
  for (const [index, group] of groups.entries()) {
    await screen.getByRole('tab').nth(index).click();
    for (const item of group.items) {
      await expect(screen.getByText(item.label, { exact: true })).toBeVisible();
    }
    // 表头一行 + 这一组的每一项：多出来的行就是界面自己编的项。
    await expect(screen.getByRole('row')).toHaveCount(group.items.length + 1);
  }

  await expect(browser).toHaveURL('/admin/config');
});

test('热设置：改「流空闲上限」立刻生效，弹窗不说要重启，能清回默认值', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '配置' }).click();
  await screen.getByRole('tab', { name: /网关/ }).click();

  const row = screen.getByRole('row').filter({ hasText: '流空闲上限' });
  await expect(row).toBeVisible();
  // 热设置：整页那句说的是「立刻生效」，不是「要重启」。
  await expect(
    screen.getByText('改动写进数据库，改完立刻生效。'),
  ).toBeVisible();

  await row.getByRole('button', { name: '改' }).click();
  const dialog = screen.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('新值')).toHaveValue('180000');
  await expect(dialog.getByLabel('新值')).toBeVisible();
  await dialog.getByLabel('新值').fill('5000');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();

  // 这一行立刻是新值，来源变成数据库覆盖。
  await expect(row).toContainText('5000');
  await expect(row).toContainText('数据库覆盖');

  // 服务端那边生效的也是这个值（面板上看到的不只是本地状态）。
  const listed = await adminRpc<{
    items?: Array<{ key: string; value: string; source: string }>;
  }>('ListConfig');
  const item = (listed.items ?? []).find(
    (entry) => entry.key === 'ROUTER_STREAM_IDLE_MS',
  );
  expect(item?.value).toBe('5000');
  expect(item?.source).toBe('database');

  // 再打开弹窗：新值在，且这一项说的是「立即生效」。热设置不该说要重启 ——
  // 说了会让人以为得重启一次才算，实际下一个请求就是新值。
  await row.getByRole('button', { name: '改' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('新值')).toHaveValue('5000');
  await expect(dialog.getByText('写入数据库后立即生效。')).toBeVisible();
  await expect(dialog.getByText('重启', { exact: false })).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();

  // 收拾干净：清回默认值，别把这一轮的值留给这次的其余测试。
  await row.getByRole('button', { name: '清回默认' }).click();
  await expect(row).toContainText('180000');
  await expect(row).toContainText('默认值');

  await expect(browser).toHaveURL('/admin/config');
});
