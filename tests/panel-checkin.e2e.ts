// tests/panel-checkin.e2e.ts — 签到页的端到端：一个平台一行、默认收起、点开看
// 明细、没签到的平台占一行写「没有签到记录」、侧栏入口与总览的签到卡、立即签到。
//
// 数据从哪来：行集合是平台清单（ListUpstreams），签到结论是真问回来的 ——
// 网关的 GetBenefitStatus 读签到跑腿器上次的结果，RunBenefitNow 真的跑一遍。
// 对面是 tests/panel-upstream.ts 里那个假上游：WorkBuddy 的会话由
// tests/seed-session.ts 铺（令牌是编造的），workbuddyCheckinControl 开了之后
// 它才认签到状态那一条路径，其余路径照旧 404 —— 报告的每一行都是假上游
// 的答复推出来的固定文本，一个真上游都不碰。
//
// 平台清单是那 6 条预置行（lib/platform-catalog.ts），加上用例自己加的。
// 整个运行里网关是同一个实例，所以每个用例收尾都要把自己加的账号删掉；
// 签到跑腿器的结果留在网关进程里，但只对开着账号的 benefits 类平台可见，
// 账号删掉就不出现在任何一行上。

import { execFileSync } from 'node:child_process';
import { expect } from 'e2e';
import type { Locator, Screen } from 'e2e';
import { test } from '@e2e-dev/web';
import { addAccount, adminRpc, dataDir, dropPlatform, login, seedOpenPlatform } from './panel.ts';
import { startPanelUpstream, workbuddyCheckinControl } from './panel-upstream.ts';

/** 现在的平台清单（签到页的行集合与次序都跟着它走）。 */
async function listedPlatforms(): Promise<string[]> {
  const answer = await adminRpc<{ upstreams: { id: string }[] }>('ListUpstreams');
  return answer.upstreams.map((upstream) => upstream.id);
}

/** 签到页上平台那一行（行容器的 aria-label 恒为 `<平台id> 签到行`）。 */
function rowOf(screen: Screen, id: string): Locator {
  return screen.getByLabel(`${id} 签到行`, { exact: true });
}

/** 行上的开合按钮（`aria-label="<平台id> 签到"`，带 aria-expanded）。 */
function rowButton(screen: Screen, id: string): Locator {
  return screen.getByRole('button', { name: `${id} 签到`, exact: true });
}

/** 展开区（`role=region`，收起时不挂载）。 */
function detailOf(screen: Screen, id: string): Locator {
  return screen.getByRole('region', { name: `${id} 签到明细` });
}

/** 进签到页。 */
async function openCheckin(screen: Screen, app: { open(): Promise<void> }): Promise<void> {
  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '签到' }).click();
  await expect(screen.getByRole('heading', { name: '签到' })).toBeVisible();
}

/**
 * 给 workbuddy-cn 铺一个带会话的账号。
 *
 * 会话是铺进去的（形状与 test/fake-sessions.ts 那份一致），令牌是编造的：
 * 假上游不看它们，签到的每一条请求都落在假上游上。
 */
async function seedWorkBuddyAccount(alias: string): Promise<string> {
  const account = await addAccount('workbuddy-cn', alias);
  // 新装的账号默认是关着的；签到跑腿器只看开着的账号（benefitUpstreams），
  // 不打开它就没有任何一行有结论、总览的签到卡也不出现。
  await adminRpc('SetAccountEnabled', { accountId: account, enabled: true });
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', 'tests/seed-session.ts', 'workbuddy-cn', account],
    { env: { ...process.env, BUDDY_DATA_DIR: dataDir() }, stdio: 'pipe' },
  );
  return account;
}

/**
 * 跑一遍签到（admin RPC 直接点网关的 RunBenefitNow），返回本次的逐条结果。
 *
 * 假上游开着、签到控制不开：签到状态那条 404，报告是它推出来的固定文本。
 * 逐条结果的形状是 `[<账号id>] <报告>`，账号id 是播种时拿到的那个。
 */
async function runBenefitsOnce(): Promise<string[]> {
  const answer = await adminRpc<{ lines: string[] }>('RunBenefitNow');
  return answer.lines ?? [];
}

test('签到页一个平台一行：行的集合与次序跟着平台清单走，没结论的写「没有签到记录」', async ({
  app,
  screen,
}) => {
  await startPanelUpstream();
  const added = ['checkin-mike', 'checkin-alpha'];
  const accounts: string[] = [];
  try {
    // 一家有签到结论的（workbuddy-cn 名下两个账号真跑了一遍），两家开放平台没有。
    // 签到是账号的事：同一平台下的每个账号都签，行的结论是这一家平台合起来的。
    accounts.push(await seedWorkBuddyAccount('签到了的那家甲'));
    accounts.push(await seedWorkBuddyAccount('签到了的那家乙'));
    await runBenefitsOnce();
    await seedOpenPlatform(added[0], '签到测试甲');
    await seedOpenPlatform(added[1], '签到测试乙');

    await openCheckin(screen, app);

    const list = screen.getByLabel('平台签到');
    // 一行一个平台，次序 = 平台清单的次序（页面照清单原样摆）。
    const expected = await listedPlatforms();
    await expect(list.getByRole('listitem')).toHaveCount(expected.length);
    const labels: string[] = [];
    for (let index = 0; index < expected.length; index += 1) {
      labels.push(String(await list.getByRole('listitem').nth(index).getAttribute('aria-label')));
    }
    expect(labels).toEqual(expected.map((id) => `${id} 签到行`));

    // 有结论的那家不再写「没有签到记录」；没结论的两家写「没有签到记录」，不是 0。
    // 【等修复】后端 BenefitStatus.upstreamId 现在装的是账号 id，面板拿平台 id
    // 去 join 永远不中（缺陷定位见交付记录）；be-admin 改完 proto 这条才转绿。
    await expect(rowOf(screen, 'workbuddy-cn')).not.toContainText('没有签到记录');
    for (const id of added) {
      await expect(rowOf(screen, id)).toContainText('没有签到记录');
      await expect(rowOf(screen, id)).not.toContainText('0');
    }
  } finally {
    workbuddyCheckinControl.reset();
    for (const account of accounts) {
      await adminRpc('DeleteAccount', { id: account }).catch(() => {});
    }
    for (const id of added) await dropPlatform(id).catch(() => {});
  }
});

test('默认收起，点开看明细，再收起明细区从 DOM 消失', async ({ app, screen }) => {
  await startPanelUpstream();
  const accounts: string[] = [];
  try {
    // 同一平台下两个账号、各自有签到结论：展开后要能看到两条账号明细。
    const aliasA = '要点开看明细的那家甲';
    const aliasB = '要点开看明细的那家乙';
    accounts.push(await seedWorkBuddyAccount(aliasA));
    accounts.push(await seedWorkBuddyAccount(aliasB));
    await runBenefitsOnce();
    // 每个账号一条（`[<账号id>] <报告>`）：两条都要落到明细里。明细区里
    // 逐条记录按账号分开（能看出是哪个账号），报告本身是假上游 404 推出来的
    // 固定文本，两个账号一样 —— 所以拿别名认账号，拿报告文本认内容。
    const report = '查签到状态失败（HTTP 404）';

    await openCheckin(screen, app);

    const button = rowButton(screen, 'workbuddy-cn');
    const detail = detailOf(screen, 'workbuddy-cn');

    // 收起：aria-expanded 是 false，明细区根本不挂载。
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(detail).toHaveCount(0);
    // 收起态摘要在行上。
    await expect(screen.getByLabel('workbuddy-cn 签到摘要', { exact: true })).toBeVisible();

    // 点开：明细区出现，两个账号的逐条明细都在（【等修复】同用例 1 的 join 缺陷，
    // be-admin 改完 proto 才转绿）。
    await button.click();
    await expect(detail).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    // 两个账号各自的明细都在（【等修复】无：join 已修，这条随修复转绿）。
    await expect(detail).toContainText(aliasA);
    await expect(detail).toContainText(aliasB);
    await expect(detail).toContainText(report);

    // 再收起：明细区从 DOM 消失（不是 hidden），aria-expanded 回到 false。
    await button.click();
    await expect(detail).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  } finally {
    workbuddyCheckinControl.reset();
    for (const account of accounts) {
      await adminRpc('DeleteAccount', { id: account }).catch(() => {});
    }
  }
});

test('空状态：没有签到结论的平台占一行，写「没有签到记录」，不带数字', async ({
  app,
  screen,
}) => {
  await openCheckin(screen, app);

  // zcode 不发积分、这一趟也没有它的账号：没有签到结论，但行还在。
  const row = rowOf(screen, 'zcode');
  await expect(row).toBeVisible();
  await expect(row).toContainText('没有签到记录');
  const text = String(await row.textContent());
  expect(/\d/.test(text)).toBe(false);
});

test('侧栏入口：签到到 /checkin，总览的签到卡还在', async ({ app, screen, browser }) => {
  await startPanelUpstream();
  let account = '';
  try {
    // 总览的签到卡在「没有登记签到的账号」时整块不出现；铺一个签到账号让它
    // 现身，再验它没被签到页分走 —— 这是回归保护，不是功能用例。
    account = await seedWorkBuddyAccount('总览卡还在的那家');
    await runBenefitsOnce();

    await app.open();
    await login(screen);

    await expect(screen.getByText('每日签到')).toBeVisible();

    await screen.getByRole('link', { name: '签到' }).click();
    await expect(screen.getByRole('heading', { name: '签到' })).toBeVisible();
    await expect(browser).toHaveURL('/admin/checkin');
  } finally {
    workbuddyCheckinControl.reset();
    if (account) await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

test('立即签到：按钮停在「签到中…」，结束摆出本次的逐条结果', async ({ app, screen }) => {
  const upstream = await startPanelUpstream();
  let account = '';
  try {
    account = await seedWorkBuddyAccount('立即签到的那家');
    // 假上游拖着才答签到状态：按钮能稳定停在「签到中…」。
    workbuddyCheckinControl.enabled = true;
    workbuddyCheckinControl.delayMs = 1500;

    await openCheckin(screen, app);

    await screen.getByRole('button', { name: '立即签到' }).click();
    await expect(screen.getByRole('button', { name: '签到中…' })).toBeDisabled();

    // 结束后「本次签到」摆出假上游推出来的逐条结果（固定文本）。
    const result = screen.getByLabel('本次签到', { exact: true });
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('今日已签到（连签 3 天）');
    // 按钮回到可点的那一档。
    await expect(screen.getByRole('button', { name: '立即签到' })).toBeVisible();

    // 这一趟真的走过网关打到了假上游：请求是发出去的，不是面板自己编的。
    const paths = upstream.hits.map((hit) => hit.path);
    expect(paths).toContain('/v2/billing/meter/checkin-activity-status');
  } finally {
    workbuddyCheckinControl.reset();
    if (account) await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});
