// tests/panel-config.e2e.ts — 「配置」页：十二个设置、分组的中文名、热设置的生效。
//
// 数的是「面板上有几项」：分组 tab 上括号里的数是服务端给的那一组的条数，加起来
// 必须等于 `lib/admin/config.ts` 里 USER_FACING 的十二条。少一条、多一条、把某一组
// 画成英文名，都算这个页面说错了话。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import { adminRpc, login } from './panel.ts';

/** 面板能改的设置，按分组列（`lib/admin/config.ts` 的 LABELS）。 */
const GROUPS: Array<{ tab: string; labels: string[] }> = [
  { tab: '常规', labels: ['允许的跨域来源'] },
  {
    tab: '网关',
    labels: [
      '是否开启 API KEY 验证',
      '用量保留天数',
      '等首帧时限',
      '流空闲上限',
      '重试总时限',
      '后台定时任务',
      '快照刷新间隔',
    ],
  },
  { tab: '签到', labels: ['关闭签到与领奖', '签到间隔'] },
  { tab: 'Qoder', labels: ['排队重试间隔', '排队时不等待'] },
];

/** 十二个设置 —— 就这么多个，不多不少。 */
const TOTAL = GROUPS.reduce((sum, group) => sum + group.labels.length, 0);

/** 「网关 (7)」→ { name: '网关', count: 7 }。 */
function parseTab(text: string): { name: string; count: number } {
  const match = /^(.*?)\s*\((\d+)\)/.exec(text.trim());
  if (!match) throw new Error(`tab 上的字看不懂：${text}`);
  return { name: match[1].trim(), count: Number(match[2]) };
}

test('配置页：十二个设置都在，分组 tab 是中文名（不是 gateway / benefits / qoder）', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '配置' }).click();
  await expect(screen.getByRole('heading', { name: '配置' })).toBeVisible();

  const tabs = (await screen.getByRole('tab').allTextContents()).map(parseTab);
  // 分组名就是这四个中文词。服务端给的是英文的键，面板要翻译过来 ——
  // 翻译漏了就会看见 gateway / benefits / qoder。
  expect(tabs.map((tab) => tab.name)).toEqual(
    GROUPS.map((group) => group.tab),
  );
  // 十二个设置：每组自己说的条数加起来要对得上。
  expect(tabs.reduce((sum, tab) => sum + tab.count, 0)).toBe(TOTAL);
  expect(TOTAL).toBe(12);
  // 英文的组名一个都不该露在界面上。
  for (const english of ['gateway', 'benefits', 'qoder', 'general']) {
    await expect(screen.getByRole('tab', { name: english })).toHaveCount(0);
  }

  // 打开就停在「常规」那一组（不是空白的一屏，也不是最后点过的那一组）。
  await expect(screen.getByRole('tab', { name: /^常规/ })).toBeSelected();

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

  // 每一项都在它那一组里：点进去看名字（值是人看的短名字，不是 env 的键名）。
  for (const [index, group] of GROUPS.entries()) {
    await screen.getByRole('tab').nth(index).click();
    expect(tabs[index]?.count).toBe(group.labels.length);
    for (const label of group.labels) {
      await expect(screen.getByText(label, { exact: true })).toBeVisible();
    }
    // 表头一行 + 这一组的每一项。
    await expect(screen.getByRole('row')).toHaveCount(group.labels.length + 1);
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
