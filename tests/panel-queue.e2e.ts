// tests/panel-queue.e2e.ts — 「排队中」：上游把模型停进队列，面板上那一格不再是绿的。
//
// Qoder 的排队答复只存在于真上游：「200 的流里第一帧就是错误」，模型没排上才
// 会有。录下来的那一份在 `test/fixtures/panel-e2e/qoder-queue-frame.json`，由
// `tests/panel-upstream.ts` 原样回放；网关的推理地址（`QODER_CN_INFER_BASE`）由
// `test/panel-e2e-app.sh` 指到那个假上游，所以这一趟请求真的出了网关、真的经过
// 了路由与协议编码，只是对面是本机。
//
// 这一条要验的是**设计**，不只是「变黄了」：
//
//   · 一次排队不算：第一次请求之后平台**仍然**是「就绪」（偶发一次排队是正常
//     的，见 lib/admin/platform-state.ts 的 QUEUE_MIN_ATTEMPTS）；
//   · 两次之后才是「排队中」，状态说明里说的是「排队」，不是「冷却」「限流」
//     —— 排队不冷却账号、不改选号，说成冷却会把人引到无关的地方去；
//   · 上游收到的确实是我们铺的那个模型（老协议正文里解出来的 key）。
//
// 排队等待那一次是关掉的（`QODER_SKIP_QUEUE_WAIT`，面板上的热设置）：录下来的
// 答复说等 60 秒，等完还是排队（见 lib/qoder/queue.ts），这一条不花那一分钟。

import { execFileSync } from 'node:child_process';
import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import { BASE, addAccount, adminRpc, dataDir, login } from './panel.ts';
import { FIXTURE, startPanelUpstream } from './panel-upstream.ts';

/** 平台那一行（预置的模拟客户端，名字照抄 lib/platform-catalog.ts）。 */
const PLATFORM = 'qoder-cn';
const LABEL = 'Qoder（中国区）';

/** 客户端问的那个模型：中国区目录里有它，老协议里叫 `dmodel`。 */
const MODEL = 'deepseek-v4-pro';
const UPSTREAM_KEY = 'dmodel';

/** 平台那一行。 */
function rowOf(screen: Screen, text: string): Locator {
  return screen.getByRole('row').filter({ hasText: text });
}

/** 那一行现在说的是什么（整行的可见文字）。 */
async function rowText(screen: Screen): Promise<string> {
  return String(await rowOf(screen, LABEL).textContent());
}

/**
 * 重新进一次「平台」页，读那一行。
 *
 * 状态是服务端算的（判定在 lib/admin/platform-state.ts），面板只是把它画出来：
 * 这里的两次请求不是面板发的，所以再读之前要让面板重新取一次。整页重新加载是
 * 面板上最干脆的一次「重新取」——不是客户端路由跳转（那样还有 10 秒的
 * staleTime，看到的可能还是上一次的答案）。
 */
async function rereadState(screen: Screen, browser: Browser): Promise<string> {
  await browser.goto('/admin/upstreams');
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  return rowText(screen);
}

/**
 * 等面板上那一行变成某个状态（最多十秒）。
 *
 * 会话是刚铺进库的，而网关把会话读进缓存要过几秒才会再读一次（`QODER_AUTH_CACHE_MS`），
 * 所以开始那几下可能还写着「没登录」。等到就是等到 —— 不拿一个 sleep 赌。
 */
async function waitForState(
  screen: Screen,
  browser: Browser,
  wanted: string,
): Promise<string> {
  let text = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    text = await rereadState(screen, browser);
    if (text.includes(wanted)) return text;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return text;
}

/**
 * 客户端发一次请求（真的从网关出去）。
 *
 * 断言的是「上游把这个模型排进队列」这条路：网关自己回 429，正文里那句话说清
 * 了现在该做什么（换上游/换模型，或稍后再试）。
 */
async function sendOnce(): Promise<{ status: number; body: string }> {
  const answer = await fetch(`${BASE}/${PLATFORM}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: '排上队了吗' }],
    }),
  });
  return { status: answer.status, body: await answer.text() };
}

test('排队中：第一次排队之后仍是「就绪」，两次之后才是「排队中」且说的是排队不是冷却；上游收到的是那个模型', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startPanelUpstream();
  upstream.reset();

  // 排队等待那一次关掉：这一条不花录下来那 60 秒（面板上的热设置）。
  await adminRpc('SetConfig', { key: 'QODER_SKIP_QUEUE_WAIT', value: 'true' });

  const account = await addAccount(PLATFORM, '排队一号');
  try {
    // 会话铺进去（登录要人点同意，那份答复没录；见 tests/seed-session.ts）。
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'tests/seed-session.ts', PLATFORM, account],
      { env: { ...process.env, BUDDY_DATA_DIR: dataDir() }, stdio: 'pipe' },
    );

    await app.open();
    await login(screen);
    await screen.getByRole('link', { name: '平台' }).click();
    await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();

    // 前置：这个平台能接请求（绿的那个「就绪」）——没有这一步，后面的「变黄」
    // 说明不了是排队造成的。
    const ready = await waitForState(screen, browser, '就绪');
    expect(ready).toContain('就绪');

    // 第一次：上游把这个模型排进队列，网关交出去的是一条「稍后再来」。
    const first = await sendOnce();
    expect(first.status).toBe(429);
    expect(first.body).toContain('排队');

    // 一次不算：偶发一次排队是正常的，面板上仍然写着「就绪」。
    const afterOne = await rereadState(screen, browser);
    expect(afterOne).toContain('就绪');
    expect(afterOne).not.toContain('排队中');

    // 第二次：还是排队。这下「最近每次请求都被排进队列」成立了。
    const second = await sendOnce();
    expect(second.status).toBe(429);

    const afterTwo = await waitForState(screen, browser, '排队中');
    // 徽章说的是排队，状态说明说的是「排进队列」。
    expect(afterTwo).toContain('排队中');
    expect(afterTwo).toContain('排进队列');
    // 不是冷却、也不是限流：排队不冷却账号（那会把同一个账号别的模型一起带走）。
    expect(afterTwo).not.toContain('冷却中');
    expect(afterTwo).not.toContain('限流');
    // 绿色那个「就绪」没了。
    expect(afterTwo).not.toContain('就绪');

    // 上游那边：两次请求都到了老协议那个地址，回的都是那份实录，模型是铺的那个。
    const legacy = upstream.hits.filter((hit) => hit.path.endsWith('/agent_chat_generation'));
    expect(legacy).toHaveLength(2);
    for (const hit of legacy) {
      expect(hit.fixture).toBe(FIXTURE.queue);
      expect(hit.model).toBe(UPSTREAM_KEY);
      // 老协议的鉴权是那套 COSY 签名（会话在里面），不是明文 key。
      expect(hit.authorization).toContain('Bearer COSY.');
    }
  } finally {
    await adminRpc('SetConfig', { key: 'QODER_SKIP_QUEUE_WAIT', clear: true }).catch(() => {});
    await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});
