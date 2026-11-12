// tests/panel-catalog.e2e.ts — 「刷新模型目录」：面板上按一下，走的是上游的
// /v1/models，回到面板上的目录就是那份答复。
//
// 应答是录下来的实录（`test/fixtures/panel-e2e/catalog-models.json`，七牛云那
// 一条 /v1/models），由 `tests/panel-upstream.ts` 回放。平台的地址是**数据**
// （建平台时填的那一格），所以这一条不需要改任何设置：把那一格填成假上游的
// 地址就行。
//
// 断言要能证明目录真的来自上游，而不是一张空表：
//   · 条数 = 实录里的条数；
//   · 面板上摆出来的模型里，有一条是实录里的具体 id（下拉里那一条只在答复里存在，
//     面板自己编不出这个名字）；
//   · 假上游真的收到了 GET /v1/models，且带的是账号上那把 key。
//
// 实录里有这条 id 是**前提**，不是断言：拿 fixture 的内容去比这个常量，验不到产品
// （改 fixture 两边一起变）。所以它是 `throw`，不是 `expect`。
//
// 第二次按：仍然打上游，这是代码里写明的（lib/admin/service.ts 的
// refreshPlatformModels 传 force: true —— 人手动点的那一次穿透失败退避）。
// 所以这里断言「两次按 = 两次请求」，而不是「第二次走缓存」。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import {
  addAccount,
  dropPlatform,
  login,
  seedPlatform,
  setAccountKey,
} from './panel.ts';
import {
  FIXTURE,
  UPSTREAM_BASE,
  readFixture,
  startPanelUpstream,
} from './panel-upstream.ts';

/** 账号上那把 key —— 编造的样例，只用来证明请求带上的是它。 */
const ACCOUNT_KEY = 'sk-E2E-CATALOG-TESTONLY'; // privacy:allow — 编造的样例

/** 实录里那条具体的模型 id（断言面板上摆的是它）。 */
const SAMPLE_MODEL = 'z-ai/glm-5.3';

/** 实录里的模型 id，按它自己的顺序。 */
function fixtureModels(): string[] {
  const fixture = readFixture(FIXTURE.catalog);
  const body = JSON.parse(fixture.body) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((entry) => String(entry.id ?? ''));
}

/** 平台那一行。 */
function rowOf(screen: Screen, text: string): Locator {
  return screen.getByRole('row').filter({ hasText: text });
}

test('刷新模型目录：按一下真的去上游拉，条数与具体 id 都来自那份答复；再按一下仍然打上游（人点的刷新穿透退避）', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  const ids = fixtureModels();
  // 前提：实录里确实有那条 id。不是断言 —— 它比的是 fixture 内容与测试常量，
  // 改 fixture 两边一起变，验不到产品。要断言的是它到了面板上（下面那个 option）。
  if (!ids.includes(SAMPLE_MODEL)) {
    throw new Error(`fixture 里没有 ${SAMPLE_MODEL}，测试的前提没了`);
  }

  const platform = 'e2e-catalog';
  const label = 'E2E 目录站';
  try {
    await seedPlatform({
      id: platform,
      label,
      kind: 'openai',
      baseUrl: `${UPSTREAM_BASE}/v1`,
    });
    const account = await addAccount(platform, '目录一号');
    await setAccountKey(account, ACCOUNT_KEY);

    await app.open();
    await login(screen);
    await screen.getByRole('link', { name: '平台' }).click();
    await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();

    const row = rowOf(screen, label);
    await expect(row).toBeVisible();
    // 还没拉过：条数是 0，时刻说「没拉过」（不是 1970）。
    await expect(row).toContainText('模型目录：0 个模型');
    await expect(row).toContainText('上次拉取：没拉过');

    // 按一下「刷新模型目录」。
    await row.getByRole('button', { name: '刷新模型目录' }).click();

    // 面板自己按拉回来的条数说这一句（答复里的 models）。
    await expect(row).toContainText(`刷新：已刷新，${ids.length} 个模型`);
    // 平台那一行的目录也跟着变成同一个数（这颗数据来自服务端，面板不自己留）。
    await expect(row).toContainText(`模型目录：${ids.length} 个模型`);
    // 时刻不再是「没拉过」：这一次真的拉到了。
    await expect(row).not.toContainText('上次拉取：没拉过');

    // 假上游收到的就是一次 /v1/models，带的是账号上那把 key。
    const calls = upstream.hits.filter((hit) => hit.path === '/v1/models');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fixture).toBe(FIXTURE.catalog);
    expect(calls[0]?.authorization).toContain(ACCOUNT_KEY);

    // 目录里的东西真的到了面板上：自定义模型那个弹窗里摆着这一份。
    await row.getByRole('button', { name: '自定义模型' }).click();
    const dialog = screen.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`共 ${ids.length} 个模型`)).toBeVisible();
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    // 具体那一条 id：它只可能来自那份答复（面板自己编不出这个名字）。
    await expect(screen.getByRole('option', { name: SAMPLE_MODEL })).toBeVisible();
    // 下拉是浮在最上层的一层：它开着的时候弹窗在它下面（看不见）。所以先用
    // Escape 把这个下拉收起来，等弹窗重新露出来，再关弹窗自己。
    await browser.keyboard.press('Escape');
    await expect(screen.getByRole('option', { name: SAMPLE_MODEL })).toBeHidden();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();

    // 再按一下：还是打上游（force），不是缓存。
    await row.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(row).toContainText(`刷新：已刷新，${ids.length} 个模型`);
    await expect
      .poll(() => upstream.hits.filter((hit) => hit.path === '/v1/models').length)
      .toBe(2);
  } finally {
    await dropPlatform(platform).catch(() => {});
  }
});
