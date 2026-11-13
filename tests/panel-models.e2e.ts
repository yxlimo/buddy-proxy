// tests/panel-models.e2e.ts — 「自定义模型」弹窗。
//
// 弹窗现在的样子（2026-11 那一版重构之后，「是否推理」与「档位模式」两个下拉并成了
// 一个，档位也不再是自由输入的那串逗号文本）：
//
//   · 「是否支持 thinking」一个下拉，三档：不支持 thinking / 固定档位 / 档位可选；
//   · 「是否支持 Tool Call」一个下拉：用原来的值 / 是 / 否；
//   · 选「档位可选」时多出一块「可选档位」——
//       - 目录里那个模型报了档位：摆成勾选框，一档一个（目录说几档就是几档）；
//       - 目录没报：退回「自己填」的输入框；
//   · 选「不支持 thinking」时，「可选档位」整块不渲染。
//
// 两条用例分别走这两条路：
//
//   1. 空目录（平台还没拉过目录）：手填一个 id → 自己填档位 → 存下来。
//      顺带验「选了档位可选却一档都没勾」当场挡住（不是等保存了给一个红条）。
//   2. 目录里报了档位：那一块必须是**目录报的那几档**勾选框，勾哪几档就存哪几档；
//      切走再切回来，摆出来的还是目录那几档，不是这一行上一回留下的那串文本。
//
// 目录那份答复由假上游回放。带档位的那一份**不是实录**：真录到的那份里没有一个
// 模型报档位，而这条路必须由上游报出来才验得到（见 `tests/panel-upstream.ts` 里
// `/efforts/v1/models` 那一段）。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import {
  addAccount,
  adminRpc,
  dropPlatform,
  expectSamePage,
  login,
  markPage,
  seedOpenPlatform,
  seedPlatform,
  setAccountKey,
} from './panel.ts';
import { UPSTREAM_BASE, startPanelUpstream } from './panel-upstream.ts';

/** 弹窗里那条挡住保存的说明（`model-overrides.ts` 的原文）。 */
const EFFORT_PROBLEM = '档位可选，就至少勾一档';

/** 「是否支持 thinking」的三个选项，逐字（契约就写这几个字）。 */
const THINKING_OPTIONS = ['不支持 thinking', '固定档位', '档位可选'] as const;

/** 「是否支持 Tool Call」的三个选项，逐字。 */
const TOOL_OPTIONS = ['用原来的值', '是', '否'] as const;

/** 带档位那份目录里的模型（`test/fixtures/panel-e2e/catalog-models-efforts.json`）。 */
const LARGE = 'effort-probe-large';
const SMALL = 'effort-probe-small';

/** 账号上那把 key —— 编造的样例。 */
const ACCOUNT_KEY = 'sk-E2E-MODELS-TESTONLY'; // privacy:allow — 编造的样例

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
 * 前提：已经在「平台」页（`enterPanel` 过了）。不再走一次闸门 —— 已经登录着的时候
 * 闸门不在了，再找一次就是找空气。
 */
async function openModels(screen: Screen, label: string): Promise<Locator> {
  const row = rowOf(screen, label);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '自定义模型' }).click();
  const dialog = screen.getByRole('dialog', { name: `自定义模型 · ${label}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 下拉里点一个选项（下拉是浮在最上层的一层，选项挂在 screen 上）。 */
async function pickOption(
  screen: Screen,
  combobox: Locator,
  label: string,
): Promise<void> {
  await combobox.click();
  await screen.getByRole('option', { name: label, exact: true }).click();
  await expect(screen.getByRole('option', { name: label, exact: true })).toBeHidden();
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

test('自定义模型（目录空）：一个下拉管 thinking，三档逐字；选不支持的档位整块不摆；档位可选却没勾时挡住并当场说清', async ({
  app,
  screen,
  browser,
}) => {
  // 空的开放平台：目录是空的，所以一进去就是「手填一个 id」那种形态。
  await seedOpenPlatform('e2e-models', 'E2E 模型站');
  try {
    await app.open();
    await enterPanel(screen, browser);
    const dialog = await openModels(screen, 'E2E 模型站');
    await expect(dialog.getByLabel('模型 id')).toBeVisible();

    // 手填一个新 id：这一格就是「要加的模型」，此时还没改任何东西，保存是灰的。
    await dialog.getByLabel('模型 id').fill('my-own-model');
    await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled();

    // 「是否支持 thinking」：一个下拉，三个选项逐字。
    const thinking = dialog.getByRole('combobox', { name: '是否支持 thinking' });
    await expect(thinking).toBeVisible();
    await thinking.click();
    for (const label of THINKING_OPTIONS) {
      await expect(screen.getByRole('option', { name: label, exact: true })).toBeVisible();
    }
    // 换成「档位可选」：目录里没有这一条，所以摆的是「自己填」的输入框。
    await screen.getByRole('option', { name: '档位可选', exact: true }).click();
    const freeText = dialog.getByRole('textbox', { name: '可选档位' });
    await expect(freeText).toBeVisible();
    await expect(dialog.getByText('目录没报这个模型的档位，自己填')).toBeVisible();
    // 目录报了档位的那条路上摆的是勾选框，不是输入框。
    await expect(dialog.getByRole('group', { name: '可选档位' })).toHaveCount(0);

    // 一档都没填：挡住，并在下面说清是哪一条、为什么。
    await expect(dialog.getByRole('alert')).toContainText(EFFORT_PROBLEM);
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();

    // 填上两档：那句话没了，保存又能点了。
    await freeText.fill('low, high');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled();

    // 「是否支持 Tool Call」也是这一版改的名字（原来是「是否工具」）。
    const toolCall = dialog.getByRole('combobox', { name: '是否支持 Tool Call' });
    await expect(toolCall).toBeVisible();
    await toolCall.click();
    for (const label of TOOL_OPTIONS) {
      await expect(screen.getByRole('option', { name: label, exact: true })).toBeVisible();
    }
    await browser.keyboard.press('Escape');
    await expect(screen.getByRole('option', { name: '用原来的值' })).toBeHidden();

    // 换成「不支持 thinking」：档位那一块（连自己填）整块不摆 —— 连「可选档位」
    // 这几个字都不该还在（标签也属于这一块）。
    await pickOption(screen, thinking, '不支持 thinking');
    await expect(dialog.getByRole('textbox', { name: '可选档位' })).toHaveCount(0);
    await expect(dialog.getByRole('group', { name: '可选档位' })).toHaveCount(0);
    await expect(dialog.getByText('可选档位')).toHaveCount(0);

    // 再切回「档位可选」：目录没有档位，填过的那两档还在（这一行自己的）。
    await pickOption(screen, thinking, '档位可选');
    await expect(dialog.getByRole('textbox', { name: '可选档位' })).toHaveValue(
      'low, high',
    );

    await markPage(browser);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    await expectSamePage(browser);

    // 存下来了：服务端那边这一条带着那两档。
    const mine = await savedOverride('e2e-models', 'my-own-model');
    expect(mine).toBeTruthy();
    expect(mine?.effortOptions?.levels).toEqual(['low', 'high']);

    // 再打开弹窗还在（不是只活在这一次渲染里）。
    const row = rowOf(screen, 'E2E 模型站');
    await row.getByRole('button', { name: '自定义模型' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('共 1 个模型')).toBeVisible();
    // 只有这一条模型：下拉的当前值就是它的 id。
    const shown = await dialog
      .getByRole('combobox', { name: '模型 id' })
      .textContent();
    expect(shown).toContain('my-own-model');
    await browser.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await adminRpc('DeleteModelOverride', {
      platformId: 'e2e-models',
      modelId: 'my-own-model',
    }).catch(() => {});
    await dropPlatform('e2e-models').catch(() => {});
  }
});

test('自定义模型（目录报了档位）：档位可选摆的是目录那三档勾选框，勾哪几档存哪几档，切走再切回来仍是目录那几档', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  const platform = 'e2e-model-tiers';
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
    // 先把目录拉进面板（这一颗数据来自假上游那份答复，不是面板自己编的）。
    await enterPanel(screen, browser);
    const row = rowOf(screen, label);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '刷新模型目录' }).click();
    await expect(row).toContainText('模型目录：2 个模型');
    expect(
      upstream.hits.filter((hit) => hit.path === '/efforts/v1/models'),
    ).toHaveLength(1);

    const dialog = await openModels(screen, label);
    // 选目录里那条报了三个档位的模型。
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: LARGE, exact: true }).click();

    // 选「档位可选」：这一块是勾选框（不是「自己填」的输入框），摆的就是目录
    // 报的那三档。
    const thinking = dialog.getByRole('combobox', { name: '是否支持 thinking' });
    await pickOption(screen, thinking, '档位可选');
    const levels = dialog.getByRole('group', { name: '可选档位' });
    await expect(levels).toBeVisible();
    await expect(dialog.getByText('档位来自模型目录')).toBeVisible();
    // 输入框那条路不该同时出现：两条路上只能来一条。
    await expect(dialog.getByRole('textbox', { name: '可选档位' })).toHaveCount(0);
    const boxes = ['low', 'medium', 'high'];
    for (const level of boxes) {
      await expect(
        levels.getByRole('checkbox', { name: level, exact: true }),
      ).toBeVisible();
    }
    // 目录说了几档就是几档：没有第四档。
    await expect(levels.getByRole('checkbox')).toHaveCount(3);

    // 勾得动、也勾得掉：取消第三档，勾选状态真的变。
    const high = levels.getByRole('checkbox', { name: 'high', exact: true });
    await high.click();
    await expect(high).not.toBeChecked();
    await expect(
      levels.getByRole('checkbox', { name: 'low', exact: true }),
    ).toBeChecked();
    // 再勾回来：三档都能勾上。
    await high.click();
    await expect(high).toBeChecked();

    // ── 不拿这一行自己的文本冒充目录 ──
    // 把第三档取消（这一行自己的文本现在只剩两档），切到「不支持 thinking」
    // （整块不摆）再切回「档位可选」：摆出来的还必须是从目录现取的那三档 ——
    // 要是照这一行上回的文本摆，第三档就没了。
    await high.click();
    await expect(high).not.toBeChecked();
    await pickOption(screen, thinking, '不支持 thinking');
    await expect(dialog.getByRole('group', { name: '可选档位' })).toHaveCount(0);
    await expect(dialog.getByText('可选档位')).toHaveCount(0);
    await pickOption(screen, thinking, '档位可选');
    const back = dialog.getByRole('group', { name: '可选档位' });
    await expect(back).toBeVisible();
    await expect(back.getByRole('checkbox')).toHaveCount(3);
    await expect(
      back.getByRole('checkbox', { name: 'high', exact: true }),
    ).toBeVisible();

    // 只留前面两档，存下来。
    await back.getByRole('checkbox', { name: 'high', exact: true }).click();
    await expect(
      back.getByRole('checkbox', { name: 'high', exact: true }),
    ).not.toBeChecked();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    // 存的就是勾上的那两档（顺序按摆出来的顺序）。
    const mine = await savedOverride(platform, LARGE);
    expect(mine?.effortOptions?.levels).toEqual(['low', 'medium']);

    // 再打开：人工条目叠进目录，所以目录现在报的就是那两档（`applyModelOverrides`）。
    // 摆出来的跟着目录走：两档，第三档没了。
    await row.getByRole('button', { name: '自定义模型' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: LARGE, exact: true }).click();
    const again = dialog.getByRole('group', { name: '可选档位' });
    await expect(again).toBeVisible();
    await expect(again.getByRole('checkbox')).toHaveCount(2);
    await expect(
      again.getByRole('checkbox', { name: 'high', exact: true }),
    ).toHaveCount(0);
    await expect(
      again.getByRole('checkbox', { name: 'low', exact: true }),
    ).toBeChecked();

    // 选回「不支持 thinking」：整块不摆。
    const thinkingAgain = dialog.getByRole('combobox', {
      name: '是否支持 thinking',
    });
    await pickOption(screen, thinkingAgain, '不支持 thinking');
    await expect(dialog.getByRole('group', { name: '可选档位' })).toHaveCount(0);
    await expect(dialog.getByText('可选档位')).toHaveCount(0);

    // 换一条目录模型（它没被人工改过）：档位跟着这一条自己的目录值走，不串上一条。
    await dialog.getByRole('combobox', { name: '模型 id' }).click();
    await screen.getByRole('option', { name: SMALL, exact: true }).click();
    await pickOption(
      screen,
      dialog.getByRole('combobox', { name: '是否支持 thinking' }),
      '档位可选',
    );
    const other = dialog.getByRole('group', { name: '可选档位' });
    await expect(other).toBeVisible();
    // 小那条只报两档，而且与上面那条报的两档不是同一对：没有 medium、有 high。
    await expect(other.getByRole('checkbox')).toHaveCount(2);
    await expect(
      other.getByRole('checkbox', { name: 'medium', exact: true }),
    ).toHaveCount(0);
    await expect(
      other.getByRole('checkbox', { name: 'high', exact: true }),
    ).toBeVisible();

    await browser.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await adminRpc('DeleteModelOverride', { platformId: platform, modelId: LARGE }).catch(
      () => {},
    );
    await adminRpc('DeleteModelOverride', { platformId: platform, modelId: SMALL }).catch(
      () => {},
    );
    await dropPlatform(platform).catch(() => {});
  }
});
