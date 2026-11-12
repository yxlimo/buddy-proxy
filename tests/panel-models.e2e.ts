// tests/panel-models.e2e.ts — 「自定义模型」弹窗。
//
// 验两件事：加一条模型存得下来（再打开还在），以及档位选「指定」却一档都没填时
// 被挡住、并且当场说清为什么（不是等保存了给一个红条）。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import {
  adminRpc,
  dropPlatform,
  expectSamePage,
  login,
  markPage,
  seedOpenPlatform,
} from './panel.ts';

/** 弹窗里那条挡住保存的说明（`model-overrides.ts` 里的原文）。 */
const EFFORT_PROBLEM = '选了指定档位，就至少填一档';

test('自定义模型：加一条模型能存下来，档位选「指定」却没填时挡住并当场说清', async ({
  app,
  screen,
  browser,
}) => {
  // 空的开放平台：目录是空的，所以一进去就是「手填一个 id」那种形态。
  await seedOpenPlatform('e2e-models', 'E2E 模型站');
  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();

  const row = screen.getByRole('row').filter({ hasText: 'E2E 模型站' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '自定义模型' }).click();

  const dialog = screen.getByRole('dialog', { name: '自定义模型 · E2E 模型站' });
  await expect(dialog).toBeVisible();
  // 目录是空的：一进去就是手填 id 那一格（下面那几格是给这一条写的元数据）。
  await expect(dialog.getByLabel('模型 id')).toBeVisible();

  // 手填一个新 id：这一格就是「要加的模型」，此时还没改任何东西，保存是灰的。
  await dialog.getByLabel('模型 id').fill('my-own-model');
  await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled();

  // 档位选「指定档位」，一档都不填：挡住，并在下面说清是哪一条、为什么。
  await dialog.getByRole('combobox', { name: '档位模式' }).click();
  await screen.getByRole('option', { name: '指定档位' }).click();
  await expect(dialog.getByLabel('可选档位')).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText(EFFORT_PROBLEM);
  await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();

  // 填上两档：那句话没了，保存又能点了。
  await dialog.getByLabel('可选档位').fill('low, high');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled();

  await markPage(browser);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expectSamePage(browser);

  // 存下来了：服务端那边这一条带着那两档。
  const saved = await adminRpc<{
    overrides?: Array<{ id: string; effortOptions?: { levels?: string[] } }>;
  }>('ListModelOverrides', { platformId: 'e2e-models' });
  const mine = (saved.overrides ?? []).find((item) => item.id === 'my-own-model');
  expect(mine).toBeTruthy();
  expect(mine?.effortOptions?.levels).toEqual(['low', 'high']);

  // 再打开弹窗还在（不是只活在这一次渲染里）。
  await row.getByRole('button', { name: '自定义模型' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('共 1 个模型')).toBeVisible();
  // 只有这一条模型：下拉的当前值就是它的 id。
  const shown = await dialog.getByRole('combobox', { name: '模型 id' }).textContent();
  expect(shown).toContain('my-own-model');
  await browser.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await adminRpc('DeleteModelOverride', {
    platformId: 'e2e-models',
    modelId: 'my-own-model',
  });
  await dropPlatform('e2e-models');
});
