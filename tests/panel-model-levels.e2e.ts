// tests/panel-model-levels.e2e.ts — 「可选档位」那一块的三入口同场。
//
// 面板现在的形态（web/src/features/open-platforms/models-dialog.tsx）：
//
//   · 目录报的档位：勾选框组（`group[aria-label="目录报的档位"]`），目录说几档
//     就是几档 —— 建议值，不是唯一取值；
//   · 手工加的档位：每档一个 chip，带一个「移除档位 <档位>」的按钮
//     （`group[aria-label="手工加的档位"]`）；
//   · 「加一档」：`textbox[aria-label="新档位"]` + 「添加」按钮 —— **任何时候都在**
//     （空值、重复档位时按钮禁用；回车等同点添加）。
//
// 三样东西同场，不是二选一：目录报了档位也能自己加，自己加的那档也能删。
// 写回 `effort_options` 的顺序由目录在前、手工在后决定（`orderedLevels`）。
//
// 四条用例：
//
//   1. 目录报了档位的模型：勾选框与「加一档」同时在场；勾掉一档、手工加一档、
//      再把它移除；存下去是那一串；重开弹窗仍是它。
//   2. 目录没报档位的模型：照样能自己加档位（这正是用户报的原始问题 —— 手改
//      之后不能增删）。
//   3. 「不支持 thinking」：勾选框、加一档、手工 chip 三样都不存在（整块不渲染）。
//   4. 空输入或重复档位时「添加」是禁用的（不许存进重复档位）。
//
// 目录那份答复由假上游回放：带档位的那一份不是实录，真录到的那份里没有一个模型
// 报档位（见 `tests/panel-upstream.ts` 里 `/efforts/v1/models` 那一段）。

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
import { UPSTREAM_BASE, readFixture, startPanelUpstream } from './panel-upstream.ts';

/** 带档位那份目录里的模型（`test/fixtures/panel-e2e/catalog-models-efforts.json`）。 */
const LARGE = 'effort-probe-large';

/** 目录没报档位那份目录里的模型（`test/fixtures/panel-e2e/catalog-models.json`）。 */
const PLAIN = 'glm-4.5';

/** 那份目录里的模型条数（面板上「模型目录：N 个模型」那个 N）。 */
function plainCatalogSize(): number {
  const fixture = readFixture('catalog-models');
  const body = JSON.parse(fixture.body) as { data?: unknown[] };
  return (body.data ?? []).length;
}

/** 账号上那把 key —— 编造的样例。 */
const ACCOUNT_KEY = 'sk-E2E-LEVELS-TESTONLY'; // privacy:allow — 编造的样例

/** 平台那一行。 */
function rowOf(screen: Screen, text: string): Locator {
  return screen.getByRole('row').filter({ hasText: text });
}

/** 进面板的「平台」页（每个测试开头走一次：每个 attempt 都是新浏览器）。 */
async function enterPanel(screen: Screen, browser: Browser): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/upstreams');
}

/**
 * 点某个平台那一行的「自定义模型」，返回弹窗。
 *
 * 前提：已经在「平台」页（`enterPanel` 过了）。
 */
async function openModels(screen: Screen, label: string): Promise<Locator> {
  const row = rowOf(screen, label);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '自定义模型' }).click();
  const dialog = screen.getByRole('dialog', { name: `自定义模型 · ${label}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 下拉里点一个选项（下拉浮在最上层，选项挂在 screen 上）。 */
async function pickOption(
  screen: Screen,
  combobox: Locator,
  label: string,
): Promise<void> {
  await combobox.click();
  await screen.getByRole('option', { name: label, exact: true }).click();
  await expect(screen.getByRole('option', { name: label, exact: true })).toBeHidden();
}

/** 目录报的档位那一组勾选框。 */
function catalogBoxes(dialog: Locator): Locator {
  return dialog.getByRole('group', { name: '目录报的档位' });
}

/** 手工加的那几档（chip 组）。 */
function manualChips(dialog: Locator): Locator {
  return dialog.getByRole('group', { name: '手工加的档位' });
}

/** 「加一档」那一格。 */
function newLevelInput(dialog: Locator): Locator {
  return dialog.getByRole('textbox', { name: '新档位' });
}

/** 「添加」按钮。 */
function addButton(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: '添加', exact: true });
}

/** 弹窗里那一条模型的人工元数据（服务端存下来的样子）。 */
async function savedOverride(
  platformId: string,
  modelId: string,
): Promise<{ effortOptions?: { levels?: string[] }; thinking?: string } | undefined> {
  const saved = await adminRpc<{
    overrides?: Array<{
      id: string;
      thinking?: string;
      effortOptions?: { levels?: string[] };
    }>;
  }>('ListModelOverrides', { platformId });
  return (saved.overrides ?? []).find((item) => item.id === modelId);
}

test('档位（目录报了）：勾选框与「加一档」同场，勾掉一档、手工加一档再移除，存下去是那一串，重开仍是它', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  const platform = 'e2e-levels-tiers';
  const label = 'E2E 档位站';
  try {
    // 平台的地址就是假上游那条「带档位的目录」的路由。
    await seedPlatform({
      id: platform,
      label,
      kind: 'openai',
      baseUrl: `${UPSTREAM_BASE}/efforts/v1`,
    });
    const account = await addAccount(platform, '档位一号');
    await setAccountKey(account, ACCOUNT_KEY);

    await app.open();
    await enterPanel(screen, browser);
    const row = rowOf(screen, label);
    await expect(row).toBeVisible();
    // 先把目录拉进面板（这一颗数据来自假上游那份答复，不是面板自己编的）。
    await row.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(row).toContainText('模型目录：2 个模型');

    const dialog = await openModels(screen, label);
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: LARGE, exact: true }).click();

    // 选「档位可选」。
    await pickOption(
      screen,
      dialog.getByRole('combobox', { name: '是否支持 thinking' }),
      '档位可选',
    );

    // 两样东西同时在场：目录报的勾选框 + 「加一档」那一格。
    const boxes = catalogBoxes(dialog);
    await expect(boxes).toBeVisible();
    await expect(newLevelInput(dialog)).toBeVisible();
    // 目录说了几档就是几档：勾选框里正好是目录报的那三档，一档不多一档不少。
    for (const level of ['low', 'medium', 'high']) {
      await expect(
        boxes.getByRole('checkbox', { name: level, exact: true }),
      ).toBeVisible();
    }
    await expect(boxes.getByRole('checkbox')).toHaveCount(3);
    // 目录那三档默认都勾着（它们是建议值）。
    await expect(
      boxes.getByRole('checkbox', { name: 'low', exact: true }),
    ).toBeChecked();
    // 还没有手工加的档位：chip 组不存在。
    await expect(manualChips(dialog)).toHaveCount(0);

    // 勾掉一档：它不再是选着的。
    await boxes.getByRole('checkbox', { name: 'high', exact: true }).click();
    await expect(
      boxes.getByRole('checkbox', { name: 'high', exact: true }),
    ).not.toBeChecked();
    await expect(
      boxes.getByRole('checkbox', { name: 'low', exact: true }),
    ).toBeChecked();

    // 自己加一档：它进的是「手工加的档位」那一组，带一个移除按钮。
    await newLevelInput(dialog).fill('xhigh');
    await expect(addButton(dialog)).toBeEnabled();
    await addButton(dialog).click();
    const chips = manualChips(dialog);
    await expect(chips).toBeVisible();
    await expect(
      chips.getByRole('button', { name: '移除档位 xhigh' }),
    ).toBeVisible();
    // 手工加的那档不是目录的建议：不在勾选框里。
    await expect(
      boxes.getByRole('checkbox', { name: 'xhigh', exact: true }),
    ).toHaveCount(0);
    await expect(boxes.getByRole('checkbox')).toHaveCount(3);
    // 输入框清空了，可以接着加下一档。
    await expect(newLevelInput(dialog)).toHaveValue('');

    // 加错了能删：移除按钮点掉，这一档就没了。
    await chips.getByRole('button', { name: '移除档位 xhigh' }).click();
    await expect(manualChips(dialog)).toHaveCount(0);

    // 存下去：目录那两档，按目录的顺序。
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    const mine = await savedOverride(platform, LARGE);
    expect(mine).toBeTruthy();
    expect(mine?.effortOptions?.levels).toEqual(['low', 'medium']);

    // 重开弹窗：仍是它。人工那份叠回目录，目录现在报的就是这两档。
    await row.getByRole('button', { name: '自定义模型' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: LARGE, exact: true }).click();
    const again = catalogBoxes(dialog);
    await expect(again).toBeVisible();
    await expect(again.getByRole('checkbox')).toHaveCount(2);
    await expect(
      again.getByRole('checkbox', { name: 'high', exact: true }),
    ).toHaveCount(0);
    for (const level of ['low', 'medium']) {
      await expect(
        again.getByRole('checkbox', { name: level, exact: true }),
      ).toBeChecked();
    }
    // 「加一档」那一格还在（任何时候都在）。
    await expect(newLevelInput(dialog)).toBeVisible();

    // 再手工加一档并存下去：目录那几档在前，手工加的排在后面。
    await newLevelInput(dialog).fill('xhigh');
    await addButton(dialog).click();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    const withManual = await savedOverride(platform, LARGE);
    expect(withManual?.effortOptions?.levels).toEqual(['low', 'medium', 'xhigh']);
  } finally {
    await adminRpc('DeleteModelOverride', { platformId: platform, modelId: LARGE }).catch(
      () => {},
    );
    await dropPlatform(platform).catch(() => {});
  }
});

test('档位（目录没报）：照样能自己加档位，也能删掉 —— 手改之后不能增删的老问题', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  const platform = 'e2e-levels-plain';
  const label = 'E2E 无档位站';
  try {
    // 这条路由回放的是那份没报档位的目录：模型在，但一档都没报。
    await seedPlatform({
      id: platform,
      label,
      kind: 'openai',
      baseUrl: `${UPSTREAM_BASE}/v1`,
    });
    const account = await addAccount(platform, '无档位一号');
    await setAccountKey(account, ACCOUNT_KEY);

    await app.open();
    await enterPanel(screen, browser);
    const row = rowOf(screen, label);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(row).toContainText(`模型目录：${plainCatalogSize()} 个模型`);

    const dialog = await openModels(screen, label);
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: PLAIN, exact: true }).click();
    await pickOption(
      screen,
      dialog.getByRole('combobox', { name: '是否支持 thinking' }),
      '档位可选',
    );

    // 目录一档都没报：没有建议可勾，但「加一档」照样在。
    await expect(catalogBoxes(dialog)).toHaveCount(0);
    await expect(newLevelInput(dialog)).toBeVisible();
    await expect(manualChips(dialog)).toHaveCount(0);
    // 一档都没留：保存是禁用的（这是「至少留一档」那条校验）。
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();

    // 自己加一档：它进的是手工那一组。
    await newLevelInput(dialog).fill('xhigh');
    await addButton(dialog).click();
    const chips = manualChips(dialog);
    await expect(chips).toBeVisible();
    await expect(
      chips.getByRole('button', { name: '移除档位 xhigh' }),
    ).toBeVisible();
    // 留了一档，保存就能点了。
    await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled();

    // 存下去：那一档写回服务端。
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    const mine = await savedOverride(platform, PLAIN);
    expect(mine).toBeTruthy();
    expect(mine?.effortOptions?.levels).toEqual(['xhigh']);

    // 重开弹窗：那一档还在。
    await row.getByRole('button', { name: '自定义模型' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: PLAIN, exact: true }).click();
    await expect(
      dialog.getByRole('checkbox', { name: 'xhigh', exact: true }),
    ).toBeChecked();
    await expect(newLevelInput(dialog)).toBeVisible();
  } finally {
    await adminRpc('DeleteModelOverride', { platformId: platform, modelId: PLAIN }).catch(
      () => {},
    );
    await dropPlatform(platform).catch(() => {});
  }
});

test('档位（不支持 thinking）：勾选框、加一档、手工 chip 三样都不存在', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  const platform = 'e2e-levels-none';
  const label = 'E2E 不支持档位站';
  try {
    await seedPlatform({
      id: platform,
      label,
      kind: 'openai',
      baseUrl: `${UPSTREAM_BASE}/efforts/v1`,
    });
    const account = await addAccount(platform, '档位二号');
    await setAccountKey(account, ACCOUNT_KEY);

    await app.open();
    await enterPanel(screen, browser);
    const row = rowOf(screen, label);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(row).toContainText('模型目录：2 个模型');

    const dialog = await openModels(screen, label);
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: LARGE, exact: true }).click();

    // 先摆出来：三样都在场。
    await pickOption(
      screen,
      dialog.getByRole('combobox', { name: '是否支持 thinking' }),
      '档位可选',
    );
    await expect(catalogBoxes(dialog)).toBeVisible();
    await expect(newLevelInput(dialog)).toBeVisible();

    // 换成「不支持 thinking」：整块不渲染 —— 不是灰掉，是不存在。
    await pickOption(
      screen,
      dialog.getByRole('combobox', { name: '是否支持 thinking' }),
      '不支持 thinking',
    );
    await expect(catalogBoxes(dialog)).toHaveCount(0);
    await expect(manualChips(dialog)).toHaveCount(0);
    await expect(newLevelInput(dialog)).toHaveCount(0);
    await expect(addButton(dialog)).toHaveCount(0);
    await expect(dialog.getByText('可选档位')).toHaveCount(0);
  } finally {
    await dropPlatform(platform).catch(() => {});
  }
});

test('档位（加一档）：空输入或重复档位时「添加」是禁用的', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  const platform = 'e2e-levels-dup';
  const label = 'E2E 重复档位站';
  try {
    await seedPlatform({
      id: platform,
      label,
      kind: 'openai',
      baseUrl: `${UPSTREAM_BASE}/efforts/v1`,
    });
    const account = await addAccount(platform, '档位三号');
    await setAccountKey(account, ACCOUNT_KEY);

    await app.open();
    await enterPanel(screen, browser);
    const row = rowOf(screen, label);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(row).toContainText('模型目录：2 个模型');

    const dialog = await openModels(screen, label);
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: LARGE, exact: true }).click();
    await pickOption(
      screen,
      dialog.getByRole('combobox', { name: '是否支持 thinking' }),
      '档位可选',
    );
    await expect(catalogBoxes(dialog)).toBeVisible();

    // 空输入：加不了。
    await expect(addButton(dialog)).toBeDisabled();

    // 目录已经勾着的那一档：不能重复加。
    await newLevelInput(dialog).fill('low');
    await expect(addButton(dialog)).toBeDisabled();

    // 一个目录里没有的档位：能加。
    await newLevelInput(dialog).fill('xhigh');
    await expect(addButton(dialog)).toBeEnabled();
    await addButton(dialog).click();
    await expect(manualChips(dialog)).toBeVisible();

    // 刚加的那一档：也不能重复加。
    await newLevelInput(dialog).fill('xhigh');
    await expect(addButton(dialog)).toBeDisabled();

    // 清空以后又是禁用（空值不算一档）。
    await newLevelInput(dialog).fill('');
    await expect(addButton(dialog)).toBeDisabled();
  } finally {
    await dropPlatform(platform).catch(() => {});
  }
});
