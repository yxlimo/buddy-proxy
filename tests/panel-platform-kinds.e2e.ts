// tests/panel-platform-kinds.e2e.ts — 「新增平台」的类型下拉：只给得出该建的那几类。
//
// 下拉的内容是服务端给的（`ListPlatformKinds`），面板照答案渲染，不自己筛。所以
// 这些用例验的是「服务端报上来的那一份」：厂商专用的那几种 kind 不再出现在能建
// 的清单里，而方言两种与预置的模拟客户端照旧在。
//
// 老平台行是另一件事：厂商那几种 kind 已经从代码里拿掉了，库里从前建的那些行
// 由一次性数据迁移转成 `openai`（地址落进行里、额度插件保留）。所以这里验的是
// 「转过来的那一行照旧好用」：显示、编辑、保存、凭据栏两段都还在。
//
// 行由 admin 接口铺（`tests/panel.ts` 的 `seedPlatform`），铺的就是迁移后的
// 形状：`kind: "openai"` + 地址 + 原来那个额度插件（额度那一段凭据归插件，不归
// kind）。

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
  seedPlatform,
} from './panel.ts';

/**
 * 厂商专用的那几种 kind：它们不再出现在「新增平台」的类型下拉里。
 *
 * 名字照服务端 `PLATFORM_KIND_OPTIONS` 里给过的标签抄（面板显示的就是它）—— 与
 * 下拉里那些被留下的条目逐字比对，不靠模糊匹配。
 */
const VENDOR_ONLY = ['七牛云', '讯飞星火', 'TokenRhythm', 'SenseNova', '书生·端砚'];

/** 下拉里留下来的方言两种（分组「开放平台」）。 */
const DIALECT = ['OpenAI 兼容', 'Anthropic 兼容'];

/** 找到平台上那一行（按名字或 id）。 */
function rowOf(screen: Screen, text: string): Locator {
  return screen.getByRole('row').filter({ hasText: text });
}

/** 进「平台」页。 */
async function openPlatforms(screen: Screen, browser: Browser): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/upstreams');
}

/** 打开「新增平台」弹窗，展开类型下拉，把它交回去。 */
async function openKindDropdown(screen: Screen): Promise<Locator> {
  await screen.getByRole('button', { name: '新增平台' }).click();
  const dialog = screen.getByRole('dialog', { name: '新增平台' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: '类型' }).click();
  return dialog;
}

/** 服务端现在认的那一行（断言库里的状态，不只看这一页把它画成什么）。 */
async function rowInStore(id: string): Promise<
  | { id: string; label: string; kind: string; quotaPlugin: string }
  | undefined
> {
  const list = await adminRpc<{
    upstreams?: Array<{
      id: string;
      label: string;
      kind: string;
      quotaPlugin: string;
    }>;
  }>('ListUpstreams');
  return (list.upstreams ?? []).find((item) => item.id === id);
}

/**
 * 凭据栏里每一行的「类型」列。
 *
 * 按「指纹」列认那张表：账号表里也有一列叫「凭据」（那一格是条数），按列名认会
 * 撞上外层那张表。
 */
async function credentialBadges(screen: Screen): Promise<string[]> {
  const table = screen
    .getByRole('table')
    .filter({ has: screen.getByRole('columnheader', { name: '指纹' }) })
    .filter({ hasNot: screen.getByRole('columnheader', { name: '账号' }) });
  const rows = await table
    .getByRole('row')
    .filter({ has: screen.getByRole('cell') })
    .all();
  const out: string[] = [];
  for (const row of rows) {
    out.push(String(await row.getByRole('cell').nth(1).textContent()).trim());
  }
  return out;
}

test('新增平台的类型下拉：五个厂商专用 kind 一个都不在，方言两种与模拟客户端都在', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await openPlatforms(screen, browser);

  await openKindDropdown(screen);

  // 先证明下拉真的展开了：选项渲染出来、两组都在。少了这一步，下面那一串
  // 「不存在」在「下拉根本没开」的时候也会全绿 —— 那验的是空白，不是结果。
  const openGroup = screen.getByRole('group', { name: '开放平台' });
  const simulatedGroup = screen.getByRole('group', { name: '模拟客户端' });
  await expect(openGroup).toBeVisible();
  await expect(simulatedGroup).toBeVisible();
  expect(await screen.getByRole('option').count()).toBeGreaterThan(2);

  // 该留的两种方言在。
  for (const label of DIALECT) {
    await expect(openGroup.getByRole('option', { name: label })).toBeVisible();
  }
  // 预置的模拟客户端照旧能建（名字以目录里的为准，挑一条认出就行）。
  await expect(simulatedGroup.getByRole('option', { name: 'MiniMax Code' })).toBeVisible();

  // 厂商专用的那几种一个都不在。
  for (const label of VENDOR_ONLY) {
    await expect(screen.getByRole('option', { name: label })).toHaveCount(0);
  }
});

test('新增平台：选「OpenAI 兼容」建得出来，列表里立刻有这一行', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await openPlatforms(screen, browser);

  const dialog = screen.getByRole('dialog', { name: '新增平台' });
  await screen.getByRole('button', { name: '新增平台' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: '类型' }).click();
  await screen
    .getByRole('group', { name: '开放平台' })
    .getByRole('option', { name: 'OpenAI 兼容' })
    .click();

  await dialog.getByLabel('平台 id').fill('e2e-kind-openai');
  await dialog.getByLabel('名字').fill('E2E 方言站');
  await dialog.getByLabel('地址').fill('https://probe.example/v1');

  // 记住「这一页没刷新过」：过滤如果把该留的也滤掉了，这里就没有行可看。
  await markPage(browser);
  await dialog.getByRole('button', { name: '加上' }).click();
  await expect(dialog).toBeHidden();

  await expect(rowOf(screen, 'E2E 方言站')).toBeVisible();
  await expectSamePage(browser);

  // 库里的那一行也真是这一种：面板画得出来不等于服务端收下了。
  const created = await rowInStore('e2e-kind-openai');
  expect(created?.kind).toBe('openai');
  expect(created?.label).toBe('E2E 方言站');

  await dropPlatform('e2e-kind-openai');
});

test('迁移过来的老平台行：openai 形状照旧好用 —— 能显示、能编辑、能保存，凭据栏仍是推理 Key + 额度 Cookie', async ({
  app,
  screen,
  browser,
}) => {
  // 迁移后的形状：厂商 kind 已经没了，老行改成 kind=openai，地址落进行里，额度
  // 插件仍是原来那一格（七牛云资源包）。
  await seedPlatform({
    id: 'e2e-migrated',
    label: 'E2E 迁移站',
    kind: 'openai',
    baseUrl: 'https://legacy.example/v1',
    quotaPlugin: 'qiniu',
  });
  const account = await addAccount('e2e-migrated', '迁移一号');
  // 两段凭据按位置写：推理 Key，然后是额度插件要的那一格（七牛的门户 cookie）。
  // 两段都是编造的样例值：推理 Key 与插件那一格（七牛的门户 cookie）。
  const migratedKey = 'sk-e2e-migrated-key'; // privacy:allow — 编造的样例
  await adminRpc('SetProviderKeys', {
    upstreamId: account,
    keys: [migratedKey, 'e2e-portal-cookie'],
  });

  await app.open();
  await openPlatforms(screen, browser);

  const row = rowOf(screen, 'E2E 迁移站');
  await expect(row).toBeVisible();
  // 额度插件那一格写在平台行上，不写在 kind 里：换 kind 不该把它弄丢。
  await expect(row).toContainText('七牛云资源包');

  // 编辑能打开，改名字能保存（迁移后的行与自建的那行一样能改）。
  await row.getByRole('button', { name: '编辑' }).click();
  const dialog = screen.getByRole('dialog', { name: '改平台 E2E 迁移站' });
  await expect(dialog).toBeVisible();
  // 类型建完就改不了：只摆一行只读的，而且说的是清单里那一类的名字（清单
  // 给的就是下拉里那个标签）。
  await expect(dialog.getByText('类型：OpenAI 兼容')).toBeVisible();
  await expect(dialog.getByLabel('名字')).toHaveValue('E2E 迁移站');

  await dialog.getByLabel('名字').fill('E2E 迁移站改名');
  await markPage(browser);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();

  await expect(rowOf(screen, 'E2E 迁移站改名')).toBeVisible();
  await expectSamePage(browser);

  // 展开看凭据栏：迁移只换 kind，不动凭据，也不动额度插件 —— 两段都还在。
  await screen
    .getByRole('button', { name: '展开 e2e-migrated 的账号与凭据' })
    .click();
  await expect(
    screen.getByRole('button', { name: '收起 e2e-migrated 的账号与凭据' }),
  ).toBeVisible();
  const badges = await credentialBadges(screen);
  expect(badges).toHaveLength(2);
  expect(badges).toContain('推理 Key');
  expect(badges).toContain('额度 Cookie');

  // 库里那一行也真是这个形状：kind 换成 openai、额度插件还是原来那个。
  const saved = await rowInStore('e2e-migrated');
  expect(saved?.label).toBe('E2E 迁移站改名');
  expect(saved?.kind).toBe('openai');
  expect(saved?.quotaPlugin).toBe('qiniu');

  await dropPlatform('e2e-migrated');
});
