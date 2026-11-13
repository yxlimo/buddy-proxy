// tests/panel-model-billing.e2e.ts — 「自定义模型」弹窗里那行只读的「平台报价 …」。
//
// 实现是 `web/src/features/open-platforms/model-billing.ts` 的 billingLine()：
// 目录里这条模型报了计费就摆一行，写不出来就一个字都不摆。这份用例对着假上游
// 回放一份**编出来的**目录（`test/fixtures/panel-e2e/catalog-models-billing.json`，
// 不是实录），同一个平台里三条模型各占一种情形：
//
//   · billing-probe-priced   输入 8 / 输出 28 / 缓存读 2（每百万 token，美元）；
//   · billing-probe-partial  没有缓存读 → 只有前两项；
//   · billing-probe-unpriced 完全没有报价 → 一个字都不摆。
//
// 最后切回有价的再切回没价的：那行跟着选中项走，不是残留在页面上。
//
// 计费描述符按平台行的**id** 认（`lib/catalog-billing.ts` 的 `descriptorFor`）。
// 厂商那几族的描述符随它们的 kind 一起没了，还活着的非方言描述符只剩
// `opencode-go` 这一条（一行 kind=openai、自己的 base_url）——所以这一行就叫
// 那个 id。厂商 kind 已经不在了，建平台用的就是 openai。目录那一趟打在假上游的
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

/** 带计费那份目录里的三条模型（`test/fixtures/panel-e2e/catalog-models-billing.json`）。 */
const PRICED = 'billing-probe-priced';
const PARTIAL = 'billing-probe-partial';
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
 * 没报价那条最容易错成 `$0` —— 把「不知道」说成免费。所以币种符号、单位、
 * 「平台报价」这几个字一个都不许出现。
 */
async function expectNoBilling(dialog: Locator): Promise<void> {
  for (const text of ['¥', '$', '每百万 token', '平台报价']) {
    // exact: false 才是子串匹配（这个框架里字符串默认整段相等）：
    // 不写它，「¥」只配得上文本恰好是 ¥ 的节点，这条断言就空了。
    await expect(dialog.getByText(text, { exact: false })).toHaveCount(0);
  }
}

/**
 * 那行只读文字在：「平台报价」这几个字看得见，且弹窗文本里摆着指定的那串价。
 *
 * 它是渲染出来的文本（getByText 找得到），不是输入框里的值；下面另断言
 * 「倍率」那一格还是空的，两者不合并。
 */
async function expectBillingLine(dialog: Locator, price: string): Promise<void> {
  await expect(dialog.getByText('平台报价', { exact: true })).toBeVisible();
  const text = (await dialog.textContent()) ?? '';
  expect(text).toContain(price);
}

test('自定义模型（上游报了价）：有价的摆一行、没报价的一个字不摆；那行跟着选中项走', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  // 描述符按行的 id 认：这一行就叫 `opencode-go`（见文件开头）。
  const platform = 'opencode-go';
  const label = 'E2E 计费站';
  try {
    await seedPlatform({
      id: platform,
      label,
      kind: 'openai',
      baseUrl: `${UPSTREAM_BASE}/billing/v1`,
    });
    const account = await addAccount(platform, '计费一号');
    await setAccountKey(account, ACCOUNT_KEY);

    await app.open();
    await enterPanel(screen, browser);
    const row = rowOf(screen, label);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(row).toContainText('模型目录：3 个模型');
    expect(
      upstream.hits.filter((hit) => hit.path === '/billing/v1/models'),
    ).toHaveLength(1);

    const dialog = await openModels(screen, label);

    // ── 三个价都在，单位也在 ──────────────────────────────────────
    await pickModel(screen, dialog, PRICED);
    await expectBillingLine(
      dialog,
      '输入 $8 / 输出 $28 / 缓存读 $2 每百万 token',
    );
    const pricedText = (await dialog.textContent()) ?? '';
    expect(pricedText).toContain('$8');
    expect(pricedText).toContain('$28');
    expect(pricedText).toContain('$2');
    expect(pricedText).toContain('每百万 token');
    // 它是只读的一行，不是「倍率」那个输入框：那一格还在、还是空的。
    await expect(dialog.getByLabel('倍率')).toBeVisible();
    await expect(dialog.getByLabel('倍率')).toHaveValue('');

    // ── 没报缓存读：就只有前两项 ───────────────────────────────────
    await pickModel(screen, dialog, PARTIAL);
    await expectBillingLine(dialog, '输入 $3 / 输出 $15 每百万 token');
    const partialText = (await dialog.textContent()) ?? '';
    expect(partialText).not.toContain('缓存读');

    // ── 完全没有报价：一个字都不摆 ───────────────────────────────
    await pickModel(screen, dialog, UNPRICED);
    await expectNoBilling(dialog);

    // ── 跟着选中项走：切回有价的，那行回来；再切回没价的，那行消失 ────
    await pickModel(screen, dialog, PRICED);
    await expectBillingLine(dialog, '输入 $8');
    await pickModel(screen, dialog, UNPRICED);
    await expectNoBilling(dialog);

    // ── 网关那一侧的解析也对得上（界面「不摆」不能是「billing 丢了」）──
    // 有价那条带币种与那三个数；没报价那条是缺键（undefined），不是 0。
    const listed = await adminRpc<{
      models?: Array<{
        id: string;
        billing?: {
          unknown?: boolean;
          currency?: string;
          inputPerMillion?: number;
          outputPerMillion?: number;
        };
      }>;
    }>('ListModels', { upstreamId: platform });
    const models = listed.models ?? [];
    const unpriced = models.find((model) => model.id === UNPRICED);
    expect(unpriced?.billing).toBeUndefined();
    const priced = models.find((model) => model.id === PRICED);
    expect(priced?.billing?.currency).toBe('USD');
    expect(priced?.billing?.inputPerMillion).toBe(8);
    expect(priced?.billing?.outputPerMillion).toBe(28);

    await browser.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await dropPlatform(platform).catch(() => {});
  }
});