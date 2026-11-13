// tests/panel-model-billing.e2e.ts — 「自定义模型」弹窗里那行只读的「上游报价 …」。
//
// 实现是 `web/src/features/open-platforms/model-billing.ts` 的 billingLine()：
// 目录里这条模型报了计费就摆一行，写不出来就一个字都不摆。这份用例对着假上游
// 回放一份**编出来的**目录（`test/fixtures/panel-e2e/catalog-models-billing.json`，
// 不是实录），同一个平台里四条模型各占一种情形：
//
//   · billing-probe-cny      CNY，输入 8 / 输出 28 / 缓存读 2（每百万 token）；
//   · billing-probe-usd      USD，没有缓存读 → 只有前两项，符号是 $；
//   · billing-probe-zero     全 0、没币种没单位 → 上游说的是「不知道」，不是免费：
//                            一个字都不摆（¥、$、每百万 token、上游报价 四条逐个断言）；
//   · billing-probe-unpriced 完全没有 pricing → 同样一个字都不摆。
//
// 最后切回有价的再切回没价的：那行跟着选中项走，不是残留在页面上。
//
// 平台建为 kind `tokenrhythm`：计费描述符按 kind 认（lib/catalog-billing.ts），
// 这一族的 pricing 形状就是夹具里编的那种。目录那一趟打在假上游的
// `/billing/v1/models` 上（tests/panel-upstream.ts），不碰真上游。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import {
  addAccount,
  adminRpc,
  dropPlatform,
  login,
  seedPlatform,
  setAccountKey,
} from './panel.ts';
import { UPSTREAM_BASE, startPanelUpstream } from './panel-upstream.ts';

/** 带计费那份目录里的四条模型（`test/fixtures/panel-e2e/catalog-models-billing.json`）。 */
const CNY = 'billing-probe-cny';
const USD = 'billing-probe-usd';
const ZERO = 'billing-probe-zero';
const UNPRICED = 'billing-probe-unpriced';

/** 账号上那把 key —— 编造的样例。 */
const ACCOUNT_KEY = 'sk-E2E-BILLING-TESTONLY'; // privacy:allow — 编造的样例

/** 平台那一行。 */
function rowOf(screen: Screen, text: string): Locator {
  return screen.getByRole('row').filter({ hasText: text });
}

/** 进面板的「平台」页（每个 attempt 都是新浏览器，所以每个测试都要走一遍）。 */
async function enterPanel(screen: Screen, browser: Browser): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/upstreams');
}

/** 点某个平台那一行的「自定义模型」，返回弹窗（前提：已经在「平台」页）。 */
async function openModels(screen: Screen, label: string): Promise<Locator> {
  const row = rowOf(screen, label);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '自定义模型' }).click();
  const dialog = screen.getByRole('dialog', { name: `自定义模型 · ${label}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * 在弹窗的「模型 id」下拉里选一条目录模型。
 *
 * 选完要等弹窗内容重新可读：下拉开着的那一段（含收起动画）弹窗主体不在
 * 可访问性树里，不等就断言「什么都不摆」会空过 —— 那一段里本来就什么都查不到。
 * 「倍率」那一格总是渲染的，它看得见就说明这一条模型的字段已经摆出来了。
 */
async function pickModel(
  screen: Screen,
  dialog: Locator,
  id: string,
): Promise<void> {
  await dialog.getByRole('combobox', { name: '模型 id' }).click();
  await screen.getByRole('option', { name: id, exact: true }).click();
  await expect(dialog.getByLabel('倍率')).toBeVisible();
}

/**
 * 「什么都不摆」：四条逐个断言，不是只查一个元素。
 *
 * 全 0 没币种那条最容易错成 ¥0 —— 把「不知道」说成免费。所以币种符号、单位、
 * 「上游报价」这几个字一个都不许出现。
 */
async function expectNoBilling(dialog: Locator): Promise<void> {
  for (const text of ['¥', '$', '每百万 token', '上游报价']) {
    // exact: false 才是子串匹配（这个框架里字符串默认整段相等）：
    // 不写它，「¥」只配得上文本恰好是 ¥ 的节点，这条断言就空了。
    await expect(dialog.getByText(text, { exact: false })).toHaveCount(0);
  }
}

/**
 * 那行只读文字在：「上游报价」这几个字看得见，且弹窗文本里摆着指定的那串价。
 *
 * 它是渲染出来的文本（getByText 找得到），不是输入框里的值；下面另断言
 * 「倍率」那一格还是空的，两者不合并。
 */
async function expectBillingLine(dialog: Locator, price: string): Promise<void> {
  await expect(dialog.getByText('上游报价')).toBeVisible();
  const text = (await dialog.textContent()) ?? '';
  expect(text).toContain(price);
}

test('自定义模型（上游报了价）：CNY/USD 各摆各的；全 0 没币种与没报价的一条字都不摆；那行跟着选中项走', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  const platform = 'e2e-model-billing';
  const label = 'E2E 计费站';
  try {
    // kind tokenrhythm：计费描述符按 kind 认这一族的 pricing 形状。
    // 地址指到假上游那条「带计费的目录」的路由。
    await seedPlatform({
      id: platform,
      label,
      kind: 'tokenrhythm',
      baseUrl: `${UPSTREAM_BASE}/billing/v1`,
    });
    const account = await addAccount(platform, '计费一号');
    await setAccountKey(account, ACCOUNT_KEY);

    await app.open();
    await enterPanel(screen, browser);
    const row = rowOf(screen, label);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(row).toContainText('模型目录：4 个模型');
    expect(
      upstream.hits.filter((hit) => hit.path === '/billing/v1/models'),
    ).toHaveLength(1);

    const dialog = await openModels(screen, label);

    // ── CNY：三个价都在，单位也在 ──────────────────────────────────────
    await pickModel(screen, dialog, CNY);
    await expectBillingLine(dialog, '输入 ¥8 / 输出 ¥28 / 缓存读 ¥2 每百万 token');
    const cnyText = (await dialog.textContent()) ?? '';
    expect(cnyText).toContain('¥8');
    expect(cnyText).toContain('¥28');
    expect(cnyText).toContain('¥2');
    expect(cnyText).toContain('每百万 token');
    // 它是只读的一行，不是「倍率」那个输入框：那一格还在、还是空的，两者不合并。
    await expect(dialog.getByLabel('倍率')).toBeVisible();
    await expect(dialog.getByLabel('倍率')).toHaveValue('');

    // ── USD：符号是 $，没有缓存读就只有前两项 ──────────────────────────
    await pickModel(screen, dialog, USD);
    await expectBillingLine(dialog, '输入 $3 / 输出 $15 每百万 token');
    const usdText = (await dialog.textContent()) ?? '';
    expect(usdText).not.toContain('缓存读');
    expect(usdText).not.toContain('¥');

    // ── 全 0、没币种没单位：上游说的是「不知道」，一个字都不摆 ─────────
    await pickModel(screen, dialog, ZERO);
    await expectNoBilling(dialog);

    // ── 完全没有 pricing：同样一个字都不摆 ─────────────────────────────
    await pickModel(screen, dialog, UNPRICED);
    await expectNoBilling(dialog);

    // ── 跟着选中项走：切回有价的，那行回来；再切回没价的，那行消失 ─────
    await pickModel(screen, dialog, CNY);
    await expectBillingLine(dialog, '输入 ¥8');
    await pickModel(screen, dialog, ZERO);
    await expectNoBilling(dialog);

    // ── 网关那一侧的解析也对得上（界面「不摆」不能是「billing 丢了」）──
    // 全 0 那条必须带着 unknown: true 上来 —— 它是结论，不是缺键；没有
    // pricing 那条才是缺键。两者在界面上都不摆，但原因不同，这里分开钉住。
    const listed = await adminRpc<{
      models?: Array<{
        id: string;
        billing?: { unknown?: boolean; currency?: string; inputPerMillion?: number };
      }>;
    }>('ListModels', { upstreamId: platform });
    const models = listed.models ?? [];
    const zero = models.find((model) => model.id === ZERO);
    expect(zero?.billing?.unknown).toBe(true);
    const unpriced = models.find((model) => model.id === UNPRICED);
    expect(unpriced?.billing).toBeUndefined();
    const cny = models.find((model) => model.id === CNY);
    expect(cny?.billing?.currency).toBe('CNY');
    expect(cny?.billing?.inputPerMillion).toBe(8);

    await browser.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await dropPlatform(platform).catch(() => {});
  }
});