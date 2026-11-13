// tests/panel-balance.e2e.ts — 额度页的端到端：一个平台一行、默认收起、收起只摆
// 前 5 条、空额度不隐藏、额度不许相加、没回来不是「没有额度」。
//
// 数据从哪来：额度是真问回来的 —— 网关的 GetBalance 走一遍真的探测链路
// （lib/qoder/credits.ts 的 /api/v2/quota/usage 与 /api/v3/user/status），
// 对面是 tests/panel-upstream.ts 里那个假上游（qoderQuotaControl 打开之后它
// 才认这两条路径，其余用例照旧 404）。哪个账号剩多少按 Authorization 的
// token 认：会话由 tests/seed-session.ts 铺（第三段给令牌）。
//
// 平台清单是那 6 条预置行（lib/platform-catalog.ts），加上用例自己加的。
// 整个运行里网关是同一个实例，所以每个用例收尾都要把自己加的平台与账号删掉。

import { execFileSync } from 'node:child_process';
import { expect } from 'e2e';
import type { Locator, Screen } from 'e2e';
import { test } from '@e2e-dev/web';
import {
  addAccount,
  adminRpc,
  dataDir,
  dropPlatform,
  login,
  seedPlatform,
} from './panel.ts';
import { qiniuQuotaControl, qoderQuotaControl, startPanelUpstream, UPSTREAM_BASE } from './panel-upstream.ts';

/** 现在的平台清单（额度页的行集合与次序都跟着它走）。 */
async function listedPlatforms(): Promise<string[]> {
  const answer = await adminRpc<{ upstreams: { id: string }[] }>('ListUpstreams');
  return answer.upstreams.map((upstream) => upstream.id);
}

/** 额度页上平台那一行（行容器的 aria-label 恒为 `<平台id> 额度行`）。 */
function rowOf(screen: Screen, id: string): Locator {
  return screen.getByLabel(`${id} 额度行`, { exact: true });
}

/** 收起态下 `ul[aria-label="平台额度"]` 里的行，按页面上摆的先后。 */
function visibleRows(screen: Screen): Locator {
  return screen.getByLabel('平台额度').getByRole('listitem');
}

/** 行上的开合按钮（整行都可点，按钮里是标题与摘要）。 */
function rowButton(row: Locator): Locator {
  return row.getByRole('button');
}

/** 进额度页。 */
async function openBalance(screen: Screen, app: { open(): Promise<void> }): Promise<void> {
  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '额度' }).click();
  await expect(screen.getByRole('heading', { name: '额度' })).toBeVisible();
}

/**
 * 给 qoder-cn 铺一个带会话的账号。
 *
 * 会话令牌是假上游认账号的钥匙：qoderQuotaControl.remaining 照它报数。
 */
async function seedQoderAccount(alias: string, token?: string): Promise<string> {
  const account = await addAccount('qoder-cn', alias);
  const args = ['--experimental-strip-types', 'tests/seed-session.ts', 'qoder-cn', account];
  if (token) args.push(token);
  execFileSync(process.execPath, args, {
    env: { ...process.env, BUDDY_DATA_DIR: dataDir() },
    stdio: 'pipe',
  });
  return account;
}

/**
 * 平台多于 5 家时点开「展开全部」；返回收起态下的行数（收起只摆前 5 条）。
 */
async function expandAll(screen: Screen, total: number): Promise<void> {
  if (total > 5) {
    await screen.getByRole('button', { name: `展开全部 ${total} 个平台` }).click();
  }
}

test('额度没回来：那一行是「正在读取」，绝不是「没有额度」', async ({
  app,
  screen,
}) => {
  const upstream = await startPanelUpstream();
  let account = '';
  try {
    account = await seedQoderAccount('慢的那家');
    // 假上游拖着不答额度：面板那一条查询就停在「正在读取」。
    qoderQuotaControl.enabled = true;
    qoderQuotaControl.delayMs = 5000;

    await openBalance(screen, app);

    const pending = screen.getByLabel('qoder-cn 额度行 正在读取', { exact: true });
    await expect(pending).toBeVisible();
    await expect(pending).toContainText('正在读取');
    await expect(pending).not.toContainText('没有额度');
    // 那个平台此刻没有别的行形态：既不是数据行，也不是报错行。
    await expect(rowOf(screen, 'qoder-cn')).toHaveCount(0);
    await expect(screen.getByLabel('qoder-cn 额度行 没问出来', { exact: true })).toHaveCount(0);

    // 答复到了，行换回数据形态（同一个位置，不是多了或者少了一行）。
    await expect(rowOf(screen, 'qoder-cn')).toBeVisible({ timeout: 15000 });
    await expect(rowOf(screen, 'qoder-cn')).toContainText('剩 100 点');
    await expect(screen.getByLabel('qoder-cn 额度行 正在读取', { exact: true })).toHaveCount(0);
    upstream.reset();
  } finally {
    qoderQuotaControl.reset();
    if (account) await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

test('额度页一个平台一行：行的集合与次序跟着平台清单走，标题用显示名', async ({
  app,
  screen,
}) => {
  await startPanelUpstream();
  const added = ['balance-mike', 'balance-alpha', 'balance-zulu'];
  try {
    await seedPlatform({ id: 'balance-mike', label: '迈克平台', kind: 'openai' });
    await seedPlatform({ id: 'balance-alpha', label: '阿尔法平台', kind: 'openai' });
    await seedPlatform({ id: 'balance-zulu', label: '祖鲁平台', kind: 'openai' });

    await openBalance(screen, app);

    const expected = await listedPlatforms();
    // 收起只摆前 5 条：先摆出全部再验集合与次序（前 5 条那条有专门的用例）。
    await expandAll(screen, expected.length);
    // 一行一个平台：行数 = 清单条数。
    await expect(visibleRows(screen)).toHaveCount(expected.length);
    // 次序 = 清单次序（不是我们自己排的）。
    const labels: string[] = [];
    for (let index = 0; index < expected.length; index += 1) {
      labels.push((await visibleRows(screen).nth(index).getAttribute('aria-label')) ?? '');
    }
    expect(labels).toEqual(expected.map((id) => `${id} 额度行`));

    // 行标题是显示名，不是 id。
    await expect(rowOf(screen, 'balance-zulu')).toContainText('祖鲁平台');
    await expect(rowOf(screen, 'balance-alpha')).toContainText('阿尔法平台');
  } finally {
    for (const id of added) await dropPlatform(id).catch(() => {});
  }
});

test('左连接：没有账号的平台也在，行上写「没有账号 · 没有额度」，展开有那份说明', async ({
  app,
  screen,
}) => {
  await startPanelUpstream();
  await openBalance(screen, app);

  // minimax 是预置行，这次运行里没有账号 —— 它照样占一行。
  const row = rowOf(screen, 'minimax');
  await expect(row).toBeVisible();
  await expect(row).toContainText('没有账号');
  await expect(row).toContainText('没有额度');

  // 展开后明细区里摆的是那份 role="note" 的「没有额度」，不是 0。
  await rowButton(row).click();
  const detail = screen.getByLabel('minimax 额度明细');
  await expect(detail).toBeVisible();
  const notice = detail.getByLabel('没有额度');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText('没有额度');
});

test('默认收起，点开才展开；再点收起，明细区从 DOM 里拿掉（不是 hidden）', async ({
  app,
  screen,
}) => {
  await startPanelUpstream();
  let account = '';
  try {
    account = await seedQoderAccount('展开甲');
    // 假上游认这两条额度路径，按那份令牌报 100 点。
    qoderQuotaControl.enabled = true;
    await openBalance(screen, app);
    // 网关实例在用例间共用：强制重问，免得拿到别的用例刚刷过的缓存快照。
    await screen.getByRole('button', { name: '刷新额度' }).click();

    const row = rowOf(screen, 'qoder-cn');
    // 额度回来了（不是骨架）：摘要里是那个账号的 100 点。
    await expect(row).toContainText('剩 100 点', { timeout: 15000 });

    // 收起是默认态：按钮 aria-expanded=false，明细区根本不挂载。
    await expect(rowButton(row)).toHaveAttribute('aria-expanded', 'false');
    await expect(screen.getByLabel('qoder-cn 额度明细')).toHaveCount(0);

    await rowButton(row).click();
    const detail = screen.getByLabel('qoder-cn 额度明细');
    await expect(detail).toBeVisible();
    await expect(rowButton(row)).toHaveAttribute('aria-expanded', 'true');
    await expect(detail.getByLabel('账号额度').getByRole('listitem')).toHaveCount(1);
    await expect(detail.getByLabel('账号 展开甲 的额度')).toContainText('剩余 100 点');

    // 再点收起：明细区从 DOM 里消失 —— 再查一遍，一个都数不到。
    await rowButton(row).click();
    await expect(screen.getByLabel('qoder-cn 额度明细')).toHaveCount(0);
    await expect(rowButton(row)).toHaveAttribute('aria-expanded', 'false');
  } finally {
    if (account) await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

test('收起只摆前 5 条；「展开全部」之后全都在；「收起」回到 5 条', async ({
  app,
  screen,
}) => {
  await startPanelUpstream();
  try {
    // 预置 6 条，再加两条凑过 5。
    await seedPlatform({ id: 'aa-extra1', label: '多出来的一家', kind: 'openai' });
    await seedPlatform({ id: 'aa-extra2', label: '再多家的一家', kind: 'openai' });

    await openBalance(screen, app);

    const total = (await listedPlatforms()).length;
    expect(total).toBeGreaterThan(5);

    // 收起态正好 5 行，而且是清单里的前 5 条。
    await expect(visibleRows(screen)).toHaveCount(5);
    const expected = await listedPlatforms();
    const first = (await visibleRows(screen).nth(0).getAttribute('aria-label')) ?? '';
    expect(first).toBe(`${expected[0]} 额度行`);

    await screen.getByRole('button', { name: `展开全部 ${total} 个平台` }).click();
    await expect(visibleRows(screen)).toHaveCount(total);
    const last = (await visibleRows(screen).nth(total - 1).getAttribute('aria-label')) ?? '';
    expect(last).toBe(`${expected[total - 1]} 额度行`);
    await expect(screen.getByRole('button', { name: '收起' })).toBeVisible();

    await screen.getByRole('button', { name: '收起' }).click();
    await expect(visibleRows(screen)).toHaveCount(5);
    await expect(
      screen.getByRole('button', { name: `展开全部 ${total} 个平台` }),
    ).toBeVisible();
  } finally {
    await dropPlatform('aa-extra1').catch(() => {});
    await dropPlatform('aa-extra2').catch(() => {});
  }
});

test('同一个平台的几个账号额度不相加：各显各的数，页面上找不到加出来的和', async ({
  app,
  screen,
  browser,
}) => {
  await startPanelUpstream();
  const accounts: string[] = [];
  try {
    // 三把令牌三个账号：100、130、用光。假上游照 Authorization 报数。
    qoderQuotaControl.enabled = true;
    qoderQuotaControl.remaining.set('dt-E2E-TESTONLY-jia', 100); // privacy:allow — 编造的样例
    qoderQuotaControl.remaining.set('dt-E2E-TESTONLY-yi', 130); // privacy:allow — 编造的样例
    qoderQuotaControl.remaining.set('dt-E2E-TESTONLY-bing', 0); // privacy:allow — 编造的样例
    accounts.push(await seedQoderAccount('额度甲', 'dt-E2E-TESTONLY-jia')); // privacy:allow — 编造的样例
    accounts.push(await seedQoderAccount('额度乙', 'dt-E2E-TESTONLY-yi')); // privacy:allow — 编造的样例
    accounts.push(await seedQoderAccount('额度丙', 'dt-E2E-TESTONLY-bing')); // privacy:allow — 编造的样例

    await openBalance(screen, app);

    // 同一个网关实例在用例之间是共用的：别的用例刚刷过 qoder-cn 的话，这一趟
    // 会拿缓存里的快照（里面还没有这三个账号）。「刷新额度」是强制重问，
    // 问回来的数写回缓存，行接着换上新数。
    await screen.getByRole('button', { name: '刷新额度' }).click();

    const row = rowOf(screen, 'qoder-cn');
    await expect(row).toContainText('剩 100 点', { timeout: 15000 });

    await rowButton(row).click();
    const detail = screen.getByLabel('qoder-cn 额度明细');
    await expect(detail.getByLabel('账号额度').getByRole('listitem')).toHaveCount(3);
    await expect(detail.getByLabel('账号 额度甲 的额度')).toContainText('剩余 100 点');
    await expect(detail.getByLabel('账号 额度乙 的额度')).toContainText('剩余 130 点');
    // 用光的那份就是 0：摆在面上，不藏也不算进别的账号。
    await expect(detail.getByLabel('账号 额度丙 的额度')).toContainText('剩余 0 点');

    // 整页找不到 100 + 130 加出来的那个数。
    const text = await browser.evaluate<string>('document.body.innerText');
    expect(text).not.toContain('230');
  } finally {
    for (const account of accounts) {
      await adminRpc('DeleteAccount', { id: account }).catch(() => {});
    }
  }
});

test('额度服务挂了：那一行照旧有归属与结论，不会悄悄变成 0 或者消失', async ({
  app,
  screen,
}) => {
  const upstream = await startPanelUpstream();
  let account = '';
  const platform = 'balance-portal-down';
  try {
    // 七牛插件那条路：额度接口地址是平台行上的（openai 类没有默认门户），
    // 指到本机就是可控制的。探测挂了要给出结论，走插件的快照桶 —— 没有
    // 插件的种类探测失败拿不到结论，那是另一件事（见交付记录）。
    await seedPlatform({
      id: platform,
      label: '门户挂了的站',
      kind: 'openai',
      baseUrl: `${UPSTREAM_BASE}/portal/`,
      quotaPlugin: 'qiniu',
    });
    account = await addAccount(platform, '挂了的那家');
    await adminRpc('SetProviderKeys', {
      upstreamId: account,
      keys: ['sk-e2e-portal-key', 'e2e-portal-cookie-down'], // privacy:allow — 编造的样例
    });
    qiniuQuotaControl.enabled = true;
    qiniuQuotaControl.mode = 'error';

    await openBalance(screen, app);

    // 探测失败是快照里的一条结论（state unknown）：行还在，账号还在，
    // 给的是那句话 —— 不写成 0，也不消失。
    const row = screen.getByLabel(`${platform} 额度行`, { exact: true });
    await expect(row).toBeVisible();
    await expect(row).toContainText('1 个账号');
    await expect(row).toContainText('未知');
    await expect(row).not.toContainText('没有账号');
    await expect(row).not.toContainText('剩 0 点');
    upstream.reset();
  } finally {
    qiniuQuotaControl.reset();
    if (account) await adminRpc('DeleteAccount', { id: account }).catch(() => {});
    await dropPlatform(platform).catch(() => {});
  }
});
