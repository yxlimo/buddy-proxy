// tests/panel-model-billing-override.e2e.ts — 「自定义模型」弹窗里计费的人工覆盖。
//
// 实现分两半，这条链两端都要走到：
//
//   · 界面（web/src/features/open-platforms/models-dialog.tsx 的 BillingFields）：
//     「计费方式」四档（不设置 / 不收费 / 按倍率 / 按 token），按 token 出币种与
//     三个单价输入，按倍率出计费倍率；
//   · 合成（lib/catalog-billing.ts 的 overrideBilling，经 lib/model-overrides.ts
//     在目录上生效）：人工那份盖掉上游报的那份，`overridden` 说明来处。
//
// 目录对着假上游回放 `test/fixtures/panel-e2e/catalog-models-billing.json`（编造的，
// 不是实录），同一个平台里三条模型：PRICED（USD 8/28/2）、PARTIAL、UNPRICED（一个
// 字没报）。上游没报的那条正是最需要手填的场景，所以好几个用例落在它身上。
//
// 六条用例：
//
//   1. 上游没报也能填：UNPRICED 选「按 token」、币种 CNY、填 8/28/2，保存重开仍在，
//      来源是「人工填写」；
//   2. 人工盖上游：PRICED 目录报的是 USD 8/28/2，人工写成 CNY 8/28/2 —— 数字相同
//      币种不同，`overridden` 不比数值，回显必须是人工那份（¥，不是 $）；
//   3. 按倍率：填 1.5，回显「倍率 ×1.5」，按 token 那几个输入不出现；
//   4. 不收费 ≠ 不设置：不收费回显「不收费」；不设置回到上游报价，库里那格也没了；
//   5. 校验：单价填负数保存被挡，提示指名是哪一格，机器码不上界面；
//   6. 0 是免费：输入 0、输出 5，保存后回显输入是 ¥0，不是「未填写」。
//
// 计费描述符按平台行的 **id** 认（lib/catalog-billing.ts 的 descriptorFor），
// 现存的非方言描述符只有 `opencode-go` 一条，所以每个用例的平台都得叫这个 id。
// 删平台不清 platform_model_override 表（DeletePlatform 没碰它），同 id 重建会把
// 上一条用例的人工条目带回来 —— 所以每条用例开头先把残留清干净。
//
// 回显那行只读文字是「来源 span + 正文」拼的一段，两个文本节点连着：整行的断言
// 按 `textContent` 判（短的那几个来源词可以直接 getByText）。目录那一趟打在假上游
// 的 `/billing/v1/models` 上（tests/panel-upstream.ts），不碰真上游。

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

/** 带计费那份目录里的模型（`test/fixtures/panel-e2e/catalog-models-billing.json`）。 */
const PRICED = 'billing-probe-priced';
const UNPRICED = 'billing-probe-unpriced';

/** 账号上那把 key —— 编造的样例。 */
const ACCOUNT_KEY = 'sk-E2E-BILLING-OVERRIDE-TESTONLY'; // privacy:allow — 编造的样例

/** 平台那一行。 */
function rowOf(screen: Screen, text: string): Locator {
  return screen.getByRole('row').filter({ hasText: text });
}

/**
 * 清掉这个平台名下残留的人工条目。
 *
 * 删平台不动这张表：同 id 的平台重建时，上一轮写下的条目会跟着回来（弹窗里那条
 * 模型带着「已改」，单价也还是上一次的）。不清，用例之间就互相串场。
 */
async function clearLeftoverOverrides(platformId: string): Promise<void> {
  const listed = await adminRpc<{
    overrides?: Array<{ id?: string }>;
  }>('ListModelOverrides', { platformId });
  for (const item of listed.overrides ?? []) {
    await adminRpc('DeleteModelOverride', {
      platformId,
      modelId: item.id,
    }).catch(() => {});
  }
}

/**
 * 起一个带计费目录的平台：假上游 + 清残留 + 账号 + 打开面板 + 刷新模型目录。
 *
 * 返回平台那一行（还在「平台」页上），调用方接着点「自定义模型」。
 */
async function seedBillingPlatform(
  app: { open(): Promise<void> },
  screen: Screen,
  browser: Browser,
  label: string,
): Promise<Locator> {
  const upstream = await startPanelUpstream();
  upstream.reset();
  await seedPlatform({
    id: 'opencode-go',
    label,
    kind: 'openai',
    baseUrl: `${UPSTREAM_BASE}/billing/v1`,
  });
  await clearLeftoverOverrides('opencode-go');
  const account = await addAccount('opencode-go', '计费一号');
  await setAccountKey(account, ACCOUNT_KEY);

  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  const row = rowOf(screen, label);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '刷新模型目录' }).click();
  await expect(row).toContainText('模型目录：3 个模型');
  return row;
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
 * 选完要等弹窗内容重新可读：「倍率」那一格总是渲染的，它看得见就说明这一条
 * 模型的字段已经摆出来了。
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

/** 在任意一个下拉里点一个选项（下拉浮在最上层，选项挂在 screen 上）。 */
async function pickOption(
  screen: Screen,
  combobox: Locator,
  label: string,
): Promise<void> {
  await combobox.click();
  await screen.getByRole('option', { name: label, exact: true }).click();
  await expect(screen.getByRole('option', { name: label, exact: true })).toBeHidden();
}

/** 选「计费方式」的那一档。 */
async function pickMode(
  screen: Screen,
  dialog: Locator,
  label: string,
): Promise<void> {
  await pickOption(
    screen,
    dialog.getByRole('combobox', { name: '计费方式' }),
    label,
  );
}

/** 「币种」那一格选一个币种。 */
async function pickCurrency(
  screen: Screen,
  dialog: Locator,
  label: string,
): Promise<void> {
  await pickOption(
    screen,
    dialog.getByRole('combobox', { name: '币种' }),
    label,
  );
}

/** 按 token 的三个单价输入，按标签找（三个格子都带「每百万 token」）。 */
function priceField(dialog: Locator, which: '输入' | '输出' | '缓存读'): Locator {
  return dialog.getByLabel(`${which} 每百万 token`, { exact: true });
}

/** 「计费倍率」那一格。 */
function multiplierField(scope: Locator): Locator {
  return scope.getByLabel('计费倍率', { exact: true });
}

/** 「保存」按钮。 */
function saveButton(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: '保存' });
}

/**
 * 保存并等弹窗收起来。
 *
 * 保存成功弹窗自己关（onOpenChange(false)）：等它真的没了再继续，否则重开时
 * 旧的那份还在动画里，新的开不出来。
 */
async function saveAndClose(dialog: Locator): Promise<void> {
  await saveButton(dialog).click();
  await expect(dialog).toBeHidden();
}

/**
 * 那行只读文字：来源写的是 source，正文里摆着 price。
 *
 * 整行是「来源 span + 正文」连着的一段（两个文本节点），所以正文按弹窗全文判。
 */
async function expectBillingLine(
  dialog: Locator,
  source: '人工填写' | '平台报价',
  price?: string,
): Promise<void> {
  await expect(dialog.getByText(source, { exact: true })).toBeVisible();
  const text = (await dialog.textContent()) ?? '';
  if (price !== undefined) expect(text).toContain(price);
}

/** 服务端存下来的这一条人工元数据（没有就是 undefined）。 */
async function savedOverride(
  platformId: string,
  modelId: string,
): Promise<
  | {
      billingMode?: string;
      billingCurrency?: string;
      billingInputPerMillion?: number;
      billingOutputPerMillion?: number;
      billingCacheReadPerMillion?: number;
      billingMultiplier?: number;
    }
  | undefined
> {
  const listed = await adminRpc<{
    overrides?: Array<Record<string, unknown>>;
  }>('ListModelOverrides', { platformId });
  return (listed.overrides ?? []).find(
    (item) => (item as { id?: string }).id === modelId,
  ) as Awaited<ReturnType<typeof savedOverride>>;
}

test('上游没报也能填：UNPRICED 选按 token，CNY 8/28/2，保存重开仍在，来源人工填写', async ({
  app,
  screen,
  browser,
}) => {
  const label = 'E2E 人工计费站';
  const row = await seedBillingPlatform(app, screen, browser, label);
  try {
    const dialog = await openModels(screen, label);
    await pickModel(screen, dialog, UNPRICED);

    // 上游一个字没报，计费那一格照样在 —— 那正是最需要手填的场景。
    await expect(
      dialog.getByRole('combobox', { name: '计费方式' }),
    ).toBeVisible();

    await pickMode(screen, dialog, '按 token');
    await pickCurrency(screen, dialog, 'CNY');
    await priceField(dialog, '输入').fill('8');
    await priceField(dialog, '输出').fill('28');
    await priceField(dialog, '缓存读').fill('2');
    await expect(saveButton(dialog)).toBeEnabled();
    await saveAndClose(dialog);

    // 库里存的是人工那份：方式、币种、三个单价都在。
    const saved = await savedOverride('opencode-go', UNPRICED);
    expect(saved?.billingMode).toBe('token');
    expect(saved?.billingCurrency).toBe('CNY');
    expect(saved?.billingInputPerMillion).toBe(8);
    expect(saved?.billingOutputPerMillion).toBe(28);
    expect(saved?.billingCacheReadPerMillion).toBe(2);

    // 重开仍在，来源写「人工填写」，不是上游报价。
    const reopened = await openModels(screen, label);
    await pickModel(screen, reopened, UNPRICED);
    await expectBillingLine(
      reopened,
      '人工填写',
      '输入 ¥8 / 输出 ¥28 / 缓存读 ¥2 每百万 token',
    );
    await expect(priceField(reopened, '输入')).toHaveValue('8');
    await expect(priceField(reopened, '输出')).toHaveValue('28');
    await expect(priceField(reopened, '缓存读')).toHaveValue('2');
    await expect(row).toBeVisible();
  } finally {
    // 删平台不清人工条目那张表：走之前把这一轮写下的清掉，别串给下一轮。
    await clearLeftoverOverrides('opencode-go').catch(() => {});
    await dropPlatform('opencode-go').catch(() => {});
  }
});

test('人工盖上游：目录报 USD 8/28/2，人工写成 CNY 8/28/2，回显是人工那份', async ({
  app,
  screen,
  browser,
}) => {
  const label = 'E2E 盖价站';
  await seedBillingPlatform(app, screen, browser, label);
  try {
    const dialog = await openModels(screen, label);
    await pickModel(screen, dialog, PRICED);
    // 先看见上游那份：来源「平台报价」，美元符号。
    await expectBillingLine(
      dialog,
      '平台报价',
      '输入 $8 / 输出 $28 / 缓存读 $2 每百万 token',
    );

    // 数字照抄上游、只换币种：`overridden` 不比数值，写下去就是人工的。
    await pickMode(screen, dialog, '按 token');
    await pickCurrency(screen, dialog, 'CNY');
    await priceField(dialog, '输入').fill('8');
    await priceField(dialog, '输出').fill('28');
    await priceField(dialog, '缓存读').fill('2');
    await saveAndClose(dialog);

    const reopened = await openModels(screen, label);
    await pickModel(screen, reopened, PRICED);
    // 是人工那份，不是上游那份：来源换了，币种符号也换了。
    await expectBillingLine(
      reopened,
      '人工填写',
      '输入 ¥8 / 输出 ¥28 / 缓存读 ¥2 每百万 token',
    );
    const text = (await reopened.textContent()) ?? '';
    expect(text).not.toContain('$8');
    expect(text).not.toContain('平台报价');

    const saved = await savedOverride('opencode-go', PRICED);
    expect(saved?.billingMode).toBe('token');
    expect(saved?.billingCurrency).toBe('CNY');
    expect(saved?.billingInputPerMillion).toBe(8);
  } finally {
    // 删平台不清人工条目那张表：走之前把这一轮写下的清掉，别串给下一轮。
    await clearLeftoverOverrides('opencode-go').catch(() => {});
    await dropPlatform('opencode-go').catch(() => {});
  }
});

test('按倍率：填 1.5，回显倍率 ×1.5，按 token 那几个输入不出现', async ({
  app,
  screen,
  browser,
}) => {
  const label = 'E2E 倍率计费站';
  await seedBillingPlatform(app, screen, browser, label);
  try {
    const dialog = await openModels(screen, label);
    await pickModel(screen, dialog, PRICED);
    await pickMode(screen, dialog, '按倍率');
    // 选「按倍率」后只有倍率那一格，按 token 的币种与三个单价都不在。
    await expect(multiplierField(dialog)).toBeVisible();
    await expect(priceField(dialog, '输入')).toHaveCount(0);
    await expect(
      dialog.getByRole('combobox', { name: '币种' }),
    ).toHaveCount(0);
    await multiplierField(dialog).fill('1.5');
    await saveAndClose(dialog);

    const saved = await savedOverride('opencode-go', PRICED);
    expect(saved?.billingMode).toBe('multiplier');
    expect(saved?.billingMultiplier).toBe(1.5);

    const reopened = await openModels(screen, label);
    await pickModel(screen, reopened, PRICED);
    await expectBillingLine(reopened, '人工填写', '倍率 ×1.5');
    // 回显还是按倍率那档：按 token 的输入不回来。
    await expect(priceField(reopened, '输入')).toHaveCount(0);
    await expect(
      reopened.getByRole('combobox', { name: '币种' }),
    ).toHaveCount(0);
    await expect(multiplierField(reopened)).toHaveValue('1.5');
  } finally {
    // 删平台不清人工条目那张表：走之前把这一轮写下的清掉，别串给下一轮。
    await clearLeftoverOverrides('opencode-go').catch(() => {});
    await dropPlatform('opencode-go').catch(() => {});
  }
});

test('不收费 ≠ 不设置：不收费回显「不收费」；不设置回到上游报价，库里那格也没了', async ({
  app,
  screen,
  browser,
}) => {
  const label = 'E2E 不收费站';
  await seedBillingPlatform(app, screen, browser, label);
  try {
    const dialog = await openModels(screen, label);
    await pickModel(screen, dialog, PRICED);
    await pickMode(screen, dialog, '不收费');
    await saveAndClose(dialog);

    let saved = await savedOverride('opencode-go', PRICED);
    expect(saved?.billingMode).toBe('none');

    // 重开：明确说了不收费 —— 是「不收费」三个字（人工那份），不是 0，也不是空白。
    let reopened = await openModels(screen, label);
    await pickModel(screen, reopened, PRICED);
    await expectBillingLine(reopened, '人工填写', '不收费');
    const charged = (await reopened.textContent()) ?? '';
    expect(charged).not.toContain('$8');

    // 改成「不设置」：人工那份整个不写，目录回到上游报的 USD 那三个价。
    await pickMode(screen, reopened, '不设置');
    await saveAndClose(reopened);

    saved = await savedOverride('opencode-go', PRICED);
    expect(saved?.billingMode).toBeUndefined();
    expect(saved?.billingCurrency).toBeUndefined();
    expect(saved?.billingInputPerMillion).toBeUndefined();

    reopened = await openModels(screen, label);
    await pickModel(screen, reopened, PRICED);
    await expectBillingLine(
      reopened,
      '平台报价',
      '输入 $8 / 输出 $28 / 缓存读 $2 每百万 token',
    );
    // 「不收费」那三个字不再在：两档不能混成一个「不显示」。（Radix 收起的下拉
    // 选项还在 DOM 里，判可见的那几个，把藏起来的排除掉。）
    await expect(
      reopened.getByText('不收费', { exact: true, visible: true }),
    ).toHaveCount(0);
  } finally {
    // 删平台不清人工条目那张表：走之前把这一轮写下的清掉，别串给下一轮。
    await clearLeftoverOverrides('opencode-go').catch(() => {});
    await dropPlatform('opencode-go').catch(() => {});
  }
});

test('校验：单价填负数保存被挡，提示指名是哪一格，机器码不上界面', async ({
  app,
  screen,
  browser,
}) => {
  const label = 'E2E 校验计费站';
  await seedBillingPlatform(app, screen, browser, label);
  try {
    const dialog = await openModels(screen, label);
    await pickModel(screen, dialog, UNPRICED);
    await pickMode(screen, dialog, '按 token');
    await priceField(dialog, '输入').fill('-1');
    await priceField(dialog, '输出').fill('28');

    // 保存被挡：提示带着是哪一格（带模型 id 与格名），不是笼统的「格式不对」，
    // 也不把机器码（MODEL_BILLING_INVALID）当人话摆出来。
    const alert = dialog.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('输入单价：不能是负数');
    await expect(alert).toContainText(UNPRICED);
    const text = (await dialog.textContent()) ?? '';
    expect(text).not.toContain('MODEL_BILLING_INVALID');
    await expect(saveButton(dialog)).toBeDisabled();

    // 改成正数：这一格的毛病没了，保存能用。
    await priceField(dialog, '输入').fill('8');
    await expect(alert).toBeHidden();
    await expect(saveButton(dialog)).toBeEnabled();
  } finally {
    // 删平台不清人工条目那张表：走之前把这一轮写下的清掉，别串给下一轮。
    await clearLeftoverOverrides('opencode-go').catch(() => {});
    await dropPlatform('opencode-go').catch(() => {});
  }
});

test('0 是免费：输入 0、输出 5，保存成功，回显输入是 ¥0 不是未填写', async ({
  app,
  screen,
  browser,
}) => {
  const label = 'E2E 零价计费站';
  await seedBillingPlatform(app, screen, browser, label);
  try {
    const dialog = await openModels(screen, label);
    await pickModel(screen, dialog, UNPRICED);
    await pickMode(screen, dialog, '按 token');
    await pickCurrency(screen, dialog, 'CNY');
    await priceField(dialog, '输入').fill('0');
    await priceField(dialog, '输出').fill('5');
    await saveAndClose(dialog);

    const saved = await savedOverride('opencode-go', UNPRICED);
    expect(saved?.billingInputPerMillion).toBe(0);
    expect(saved?.billingOutputPerMillion).toBe(5);

    // 回显：0 摆出来是 ¥0 —— 0 是免费，不是「没填」。
    const reopened = await openModels(screen, label);
    await pickModel(screen, reopened, UNPRICED);
    await expectBillingLine(
      reopened,
      '人工填写',
      '输入 ¥0 / 输出 ¥5 每百万 token',
    );
    await expect(priceField(reopened, '输入')).toHaveValue('0');
    await expect(priceField(reopened, '输出')).toHaveValue('5');
  } finally {
    // 删平台不清人工条目那张表：走之前把这一轮写下的清掉，别串给下一轮。
    await clearLeftoverOverrides('opencode-go').catch(() => {});
    await dropPlatform('opencode-go').catch(() => {});
  }
});
