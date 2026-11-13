// tests/panel-usage-top.e2e.ts — 用量页「按主会话 / 按子代理 / 按会话」三块卡片只摆前 10。
//
// 实现：`web/src/features/usage/index.tsx` 的 BreakdownCard（截断由调用方做，
// 「按会话」直接 slice，「按主会话」「按子代理」走 `top-buckets.ts` 的
// topBuckets），说明文案「共 N 条，显示前 10」只在超过 10 条时摆出来。
//
// 数据是铺进去的（tests/seed-usage.ts）：事件走 `lib/usage.ts` 的
// `recordUsage` 落库，面板照常从 GetUsageSummary 聚出来。每个用例用自己
// 的 upstreamId 记账，再用地址参数 `/admin/usage?upstream=<id>` 把页面筛
// 到这一份上 —— 签到跑腿那种会记账的用例留下的用量混不进来。
//
// 播种时每个事件的令牌数都不一样（序号越大越少），分桶按令牌从大到小排
// （`lib/admin/usage.ts` 的 byTokens），所以「截的是排序后的前 10」才有
// 确定的答案可以断言。展开/翻页不在这一份的范围里。

import { execFileSync } from 'node:child_process';
import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import { consoleErrors, dataDir, login, watchConsole } from './panel.ts';
import type { Screen } from 'e2e';

/** 一张 BreakdownCard 摆出来的东西：说明文案 + 每行的桶 key 与右侧统计。 */
interface CardView {
  description: string;
  rows: { key: string; stat: string }[];
}

/** evaluate 的返回值要能当 JSON 搬回来，卡片视图按行数组走，正好够用。 */
type CardRows = { title: string | null; description: string; rows: { key: string; stat: string }[] }[];

async function readCard(browser: Browser, title: string): Promise<CardView> {
  const view = await browser.evaluate<CardRows>(
    `(function(){
  const cards = document.querySelectorAll('[data-slot="card"]');
  const out = [];
  for (const card of cards) {
    const t = card.querySelector('[data-slot="card-title"]');
    if (!t) continue;
    const rows = Array.from(
      card.querySelectorAll('[data-slot="card-content"] > div.flex.items-center'),
    ).map(function (r) {
      return {
        key: r.children[0] ? r.children[0].textContent : '',
        stat: r.children[1] ? r.children[1].textContent : '',
      };
    });
    out.push({
      title: t.textContent,
      description: card.querySelector('[data-slot="card-description"]')
        ? card.querySelector('[data-slot="card-description"]').textContent
        : '',
      rows: rows,
    });
  }
  return out;
})()`,
  );
  const card = view.find((item) => item.title === title);
  if (!card) throw new Error(`页面上没有找到「${title}」这张卡片`);
  return card;
}

/** 每个用例自己的记账口径：播种与筛选用同一个 id。 */
const UPSTREAM_12 = 'e2e-usage-top-12';
const UPSTREAM_3 = 'e2e-usage-top-3';
const UPSTREAM_10 = 'e2e-usage-top-10';
const UPSTREAM_4 = 'e2e-usage-top-4';

/** 铺一份用量事件（形状见 tests/seed-usage.ts）。 */
function seedUsage(preset: string, upstreamId: string): void {
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', 'tests/seed-usage.ts', preset, upstreamId],
    { env: { ...process.env, BUDDY_DATA_DIR: dataDir() }, stdio: 'pipe' },
  );
}

/** 进面板再跳到这一份用量的深链接（每个 attempt 都是新浏览器）。 */
async function openUsage(browser: Browser, screen: Screen, upstreamId: string): Promise<void> {
  await watchConsole(browser);
  await login(screen);
  await browser.goto(`/admin/usage?upstream=${upstreamId}`);
  // 分桶在 GetUsageSummary 回来之后才渲染；等卡片标题出现再去读，否则读到的
  // 是加载态（只有「正在加载用量…」，没有卡片）。
  await expect(screen.getByText('按会话')).toBeVisible();
}

/** 12 个序号从小到大（1 → 12）的两位数；播种时序号越大令牌越少，正好是分桶的顺序。 */
function countUp(): number[] {
  return Array.from({ length: 12 }, (_, i) => i + 1);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

test('按会话超过 10 条：正好摆 10 行，说明写「共 12 条，显示前 10」，截的是排序后的前 10', async ({
  app,
  screen,
  browser,
}) => {
  seedUsage('sessions-12', UPSTREAM_12);
  await app.open();
  await openUsage(browser, screen, UPSTREAM_12);

  const card = await readCard(browser, '按会话');
  expect(card.rows.length).toBe(10);
  expect(card.description).toBe('共 12 条，显示前 10');
  // 排序后的前 10：令牌多的排前面（播种时 1 号最多、12 号最少），
  // 落下的正好是最少的 11 号与 12 号。
  expect(card.rows.map((r) => r.key)).toEqual(
    countUp().slice(0, 10).map((n) => `e2e-top e2etop-s${pad2(n)}`),
  );
  // 每行左侧是桶 key、右侧是「N 次 · 入 X / 出 Y」的统计，两边都有内容。
  for (const row of card.rows) {
    expect(row.key).not.toBe('');
    expect(row.stat).toMatch(/1 次 · 入 .+ \/ 出 .+/);
  }
  expect(await consoleErrors(browser)).toEqual([]);
});

test('按会话不足 10 条：3 条全摆，没有那句说明', async ({ app, screen, browser }) => {
  seedUsage('sessions-3', UPSTREAM_3);
  await app.open();
  await openUsage(browser, screen, UPSTREAM_3);

  const card = await readCard(browser, '按会话');
  expect(card.rows.map((r) => r.key)).toEqual([
    'e2e-top e2etop3-s01',
    'e2e-top e2etop3-s02',
    'e2e-top e2etop3-s03',
  ]);
  expect(card.description).toBe('');
  expect(await consoleErrors(browser)).toEqual([]);
});

test('按会话正好 10 条：10 条全摆，没有那句说明（截断的边界）', async ({ app, screen, browser }) => {
  seedUsage('sessions-10', UPSTREAM_10);
  await app.open();
  await openUsage(browser, screen, UPSTREAM_10);

  const card = await readCard(browser, '按会话');
  expect(card.rows.length).toBe(10);
  expect(card.rows.map((r) => r.key)).toEqual(
    Array.from({ length: 10 }, (_, i) => `e2e-top e2etop10-s${pad2(i + 1)}`),
  );
  expect(card.description).toBe('');
  expect(await consoleErrors(browser)).toEqual([]);
});

test('同一次播种里三块卡片的截断一致：12 个子代理，按会话 / 按主会话 / 按子代理都只摆前 10', async ({
  app,
  screen,
  browser,
}) => {
  seedUsage('subagents-12', UPSTREAM_4);
  await app.open();
  await openUsage(browser, screen, UPSTREAM_4);

  // 按会话：12 桶。子代理的会话名带 agent 名（sessionLabel 优先用它），
  // key 是「agent 名 · 短 id」。
  const sessions = await readCard(browser, '按会话');
  expect(sessions.rows.map((r) => r.key)).toEqual(
    countUp().map((n) => `w${pad2(n)} · e2e4-s${pad2(n)}`).slice(0, 10),
  );
  expect(sessions.description).toBe('共 12 条，显示前 10');

  // 按主会话：每个子代理各有自己的父会话，12 桶；主会话自己没发过请求，
  // 这一档的名字是子代理带上去的那个（countName 记的是档内出现过的名字），
  // key 是「agent 名 · 父会话短 id」。
  const parents = await readCard(browser, '按主会话');
  expect(parents.rows.map((r) => r.key)).toEqual(
    countUp().map((n) => `w${pad2(n)} · e2e4-p${pad2(n)}`).slice(0, 10),
  );
  expect(parents.description).toBe('共 12 条，显示前 10');

  // 按子代理：key 是「agent 名 @ 父会话」。
  const subagents = await readCard(browser, '按子代理');
  expect(subagents.rows.map((r) => r.key)).toEqual(
    countUp().map((n) => `w${pad2(n)} @ ses_e2e4-p${pad2(n)}`).slice(0, 10),
  );
  expect(subagents.description).toBe('共 12 条，显示前 10');

  expect(await consoleErrors(browser)).toEqual([]);
});
