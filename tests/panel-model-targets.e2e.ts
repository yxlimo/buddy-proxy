// tests/panel-model-targets.e2e.ts — 主路由模型弹窗的「平台目标」排序。
//
// 位次即权重：目标不再手填权重、也没有「启用这个目标」开关 —— 拖动行首把手
// 改顺序，第 1 行的权重 = 目标总数，往下递减（后端按 weight DESC 先试大的）；
// 行尾「上移 / 下移 / 删除」，焦点在行上时 Alt + 上/下箭头。保存时每个目标
// 一律 enabled: true。
//
// 断言的真相有两处：界面上每行只读的「权重 N」，和服务端存下来的
// targets[]（`ListPublishedModels` 回查，权重与顺序都要对上）。
// 目标组的目录是空的（平台没拉过目录），ModelPicker 退回手填输入框，
// 所以「平台模型 id」直接 fill。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import {
  adminRpc,
  dropPlatform,
  expectSamePage,
  login,
  markPage,
} from './panel.ts';

const PLATFORM_ID = 'e2e-targets';
const PLATFORM_LABEL = 'E2E 目标站';
const MODEL_ID = 'e2e-weight-model';

/** 回查服务端存下来的那个模型（targets 按权重从大到小回）。 */
type SavedTarget = {
  groupName: string;
  upstreamModel: string;
  weight: number;
  enabled: boolean;
};

async function savedModel(id: string): Promise<{
  targets: SavedTarget[];
} | undefined> {
  const res = await adminRpc<{
    models?: Array<{ id: string; targets?: SavedTarget[] }>;
  }>('ListPublishedModels', {});
  const model = (res.models ?? []).find((item) => item.id === id);
  return model ? { targets: model.targets ?? [] } : undefined;
}

async function cleanup(): Promise<void> {
  await adminRpc('DeletePublishedModel', { id: MODEL_ID }).catch(() => {});
  await dropPlatform(PLATFORM_ID).catch(() => {});
}

/** 进「主路由模型」页。 */
async function openModelsPage(screen: Screen, browser: Browser): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '主路由模型' }).click();
  await expect(screen.getByRole('heading', { name: '主路由模型' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/models');
}

/** 开「新增主路由模型」弹窗，填好对外 id，切到「平台目标」页。 */
async function openTargetTab(screen: Screen): Promise<Locator> {
  await screen.getByRole('button', { name: '新增' }).click();
  const dialog = screen.getByRole('dialog', { name: '新增主路由模型' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('对外 id').fill(MODEL_ID);
  await dialog.getByRole('tab', { name: '平台目标' }).click();
  await expect(targetList(dialog)).toBeVisible();
  return dialog;
}

/** 目标顺序列表。 */
function targetList(dialog: Locator): Locator {
  return dialog.getByRole('list', { name: '目标顺序' });
}

/** 第 index 行（位次从 0 数，对应 data-target-row；行就是列表里第 index 个 listitem）。 */
function targetRow(dialog: Locator, index: number): Locator {
  return targetList(dialog).getByRole('listitem').nth(index);
}

/** 行数（草稿里摆了几行，含没填全的）。 */
function rowCount(dialog: Locator): Locator {
  return targetList(dialog).getByRole('listitem');
}


/** 行上手填的那个平台模型 id（模型 id 在输入框的 value 里，不在文本里）。 */
async function rowModel(dialog: Locator, index: number): Promise<string> {
  return targetRow(dialog, index).getByLabel('平台模型 id').inputValue();
}
/** 行首拖拽把手（没有可访问名，走 browser 的 CSS 转义口）。 */
function dragHandle(browser: Browser, index: number): Locator {
  return browser.locator(
    `ul[aria-label="目标顺序"] > li[data-target-row="${index}"] [data-drag-handle]`,
  );
}

/** 整行作为拖拽落点（同上，CSS 定位）。 */
function dropRow(browser: Browser, index: number): Locator {
  return browser.locator(
    `ul[aria-label="目标顺序"] > li[data-target-row="${index}"]`,
  );
}

/**
 * 弹窗里选平台组：下拉是浮在最上层的一层，选项挂在 screen 上。
 * 选项文本是「标签（…）」，按标签前缀认。
 */
async function pickGroup(
  screen: Screen,
  row: Locator,
): Promise<void> {
  await row.getByRole('combobox', { name: '平台组' }).click();
  await screen
    .getByRole('option', { name: new RegExp(`^${PLATFORM_LABEL}`) })
    .click();
}

/** 铺满一行：选平台组 + 手填平台模型 id（目录空，ModelPicker 退回输入框）。 */
async function fillRow(
  screen: Screen,
  dialog: Locator,
  index: number,
  modelId: string,
): Promise<void> {
  const row = targetRow(dialog, index);
  await pickGroup(screen, row);
  await row.getByLabel('平台模型 id').fill(modelId);
}

/** 铺三个目标：t1 / t2 / t3（同一平台三个不同的模型 id）。 */
async function seedThreeTargets(
  screen: Screen,
  dialog: Locator,
): Promise<void> {
  await rowCount(dialog).waitFor({ state: 'visible' });
  // 弹窗自带一行空目标，再加两行。
  await dialog.getByRole('button', { name: '加一个目标' }).click();
  await dialog.getByRole('button', { name: '加一个目标' }).click();
  await expect(rowCount(dialog)).toHaveCount(3);
  for (const [index, modelId] of ['t1', 't2', 't3'].entries()) {
    await fillRow(screen, dialog, index, modelId);
  }
}

/** 行上只读的权重文字（「权重 N」）。 */
function shownWeight(row: Locator): Promise<string | null> {
  return row.getByText(/^权重 /).textContent();
}

async function save(dialog: Locator, browser: Browser): Promise<void> {
  await markPage(browser);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  // 保存走的是面板的 mutation，不是刷新：页面没重载也要存进去。
  await expectSamePage(browser);
}

test('顺序即权重：三个目标权重 3/2/1，拖第 3 个到第 1 位后按新顺序重排，保存后服务端一致', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    // 行的骨架：把手可拖、行可聚焦、行 aria 带位次。把手没有可访问名，
    // 用 CSS 定位（e2e 的 Locator 没有子元素选择，走 browser 的转义口）。
    for (const index of [0, 1, 2]) {
      const row = targetRow(dialog, index);
      await expect(row).toHaveAttribute('aria-label', `目标 ${index + 1}`);
      await expect(row).toHaveAttribute('tabindex', '0');
      await expect(dragHandle(browser, index)).toHaveAttribute('draggable', 'true');
    }
    // 权重只读地摆着：第 1 行 = 总数，往下递减。
    expect(await shownWeight(targetRow(dialog, 0))).toBe('权重 3');
    expect(await shownWeight(targetRow(dialog, 1))).toBe('权重 2');
    expect(await shownWeight(targetRow(dialog, 2))).toBe('权重 1');

    // 拖第 3 行（t3）到第 1 行：拖的是行首把手，落点是整行。dragstart 只在
    // 把手（唯一 draggable 的元素）上，从行上拖不出发不了。
    await dragHandle(browser, 2).dragTo(dropRow(browser, 0));

    // 换位立刻生效：t3 到第 1 位，权重跟着位次重算 —— 还是 3/2/1，
    // 但归属换了（总数 - 位次 + 1）。
    expect(await rowModel(dialog, 0)).toBe('t3');
    expect(await rowModel(dialog, 1)).toBe('t1');
    expect(await rowModel(dialog, 2)).toBe('t2');
    expect(await shownWeight(targetRow(dialog, 0))).toBe('权重 3');
    expect(await shownWeight(targetRow(dialog, 1))).toBe('权重 2');
    expect(await shownWeight(targetRow(dialog, 2))).toBe('权重 1');

    await save(dialog, browser);

    // 服务端存的就是界面上的顺序与权重：weights DESC，第一位最大。
    const mine = await savedModel(MODEL_ID);
    expect(mine).toBeTruthy();
    expect(mine?.targets.map((t) => t.upstreamModel)).toEqual(['t3', 't1', 't2']);
    expect(mine?.targets.map((t) => t.weight)).toEqual([3, 2, 1]);
  } finally {
    await cleanup();
  }
});

test('键盘与按钮：Alt+ArrowDown 换位，行尾「下移」也换位，首行「上移」不可用；保存后顺序一致', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    // 首行的「上移」没有上一行可去：不可用。
    await expect(
      targetRow(dialog, 0).getByRole('button', { name: '上移目标 1' }),
    ).toBeDisabled();

    // 键盘：焦点在第 2 行（t2），Alt+ArrowDown 把它挪到第 3 位。
    await targetRow(dialog, 1).focus();
    await targetRow(dialog, 1).press('Alt+ArrowDown');
    expect(await rowModel(dialog, 2)).toBe('t2');
    expect(await rowModel(dialog, 1)).toBe('t3');
    // 权重跟着位次走：t2 从「权重 2」变成「权重 1」。
    expect(await shownWeight(targetRow(dialog, 2))).toBe('权重 1');
    expect(await shownWeight(targetRow(dialog, 1))).toBe('权重 2');

    // 行尾按钮：把第 3 行（t2）用「下移」挪不回去（已是最后一行），改用
    // 第 2 行（t3）的「下移」——t3 落到最后，恢复 t1/t2/t3 的原序。
    await expect(
      targetRow(dialog, 2).getByRole('button', { name: '下移目标 3' }),
    ).toBeDisabled();
    await targetRow(dialog, 1)
      .getByRole('button', { name: '下移目标 2' })
      .click();
    expect(await rowModel(dialog, 0)).toBe('t1');
    expect(await rowModel(dialog, 1)).toBe('t2');
    expect(await rowModel(dialog, 2)).toBe('t3');
    expect(await shownWeight(targetRow(dialog, 0))).toBe('权重 3');
    expect(await shownWeight(targetRow(dialog, 2))).toBe('权重 1');

    await save(dialog, browser);
    const mine = await savedModel(MODEL_ID);
    expect(mine?.targets.map((t) => t.upstreamModel)).toEqual(['t1', 't2', 't3']);
    expect(mine?.targets.map((t) => t.weight)).toEqual([3, 2, 1]);
  } finally {
    await cleanup();
  }
});

test('删除目标：删掉中间一个后权重重新紧凑（2/1），保存结果里没有它', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    // 删中间那行（t2）。
    await targetRow(dialog, 1)
      .getByRole('button', { name: '删除目标 2' })
      .click();
    await expect(rowCount(dialog)).toHaveCount(2);
    // 剩下两行的权重重新紧凑：总数变成 2，第 1 行权重 2、第 2 行权重 1。
    expect(await rowModel(dialog, 0)).toBe('t1');
    expect(await rowModel(dialog, 1)).toBe('t3');
    expect(await shownWeight(targetRow(dialog, 0))).toBe('权重 2');
    expect(await shownWeight(targetRow(dialog, 1))).toBe('权重 1');

    await save(dialog, browser);
    const mine = await savedModel(MODEL_ID);
    expect(mine?.targets.map((t) => t.upstreamModel)).toEqual(['t1', 't3']);
    expect(mine?.targets.map((t) => t.weight)).toEqual([2, 1]);
  } finally {
    await cleanup();
  }
});

test('没有「启用这个目标」开关：目标行里没有任何开关，保存后所有目标 enabled 都是 true', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    // 目标顺序列表里：没有开关、没有勾选框、也没有「启用这个目标」这类字样。
    await expect(targetList(dialog).getByRole('switch')).toHaveCount(0);
    await expect(targetList(dialog).getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByText('启用这个目标')).toHaveCount(0);
    await expect(dialog.getByText(/启用这个目标/)).toHaveCount(0);

    await save(dialog, browser);
    const mine = await savedModel(MODEL_ID);
    expect(mine?.targets).toHaveLength(3);
    for (const target of mine?.targets ?? []) {
      expect(target.enabled).toBe(true);
    }
  } finally {
    await cleanup();
  }
});

test('没有权重输入框：每行只有一个可编辑输入（平台模型 id），「权重 N」是只读文字', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    for (const index of [0, 1, 2]) {
      const row = targetRow(dialog, index);
      // 权重没有输入框：没有叫「权重」的 textbox，行上的 input 只有
      // 平台模型 id 那一格（平台组是下拉，不是 input）。
      await expect(dialog.getByRole('textbox', { name: /权重/ })).toHaveCount(0);
      await expect(row.getByRole('textbox')).toHaveCount(1);
      await expect(row.getByLabel('平台模型 id')).toHaveValue(
        ['t1', 't2', 't3'][index],
      );
      // 权重是一段只读文字，不是控件。
      await expect(row.getByText(/^权重 /)).toBeVisible();
    }
    // 顺手存一条，保证上面这些断言不是在保存被挡住的状态下看的。
    await save(dialog, browser);
    expect((await savedModel(MODEL_ID))?.targets.map((t) => t.weight)).toEqual([
      3, 2, 1,
    ]);
  } finally {
    await cleanup();
  }
});
