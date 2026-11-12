// tests/panel-model-publish.e2e.ts — 面板上加一个主路由模型，客户端用它发请求。
//
// 用户说的那条链路，一步不少：
//
//   面板上加一个主路由模型 → 发布出去 → 客户端用它发请求 → 请求真的走到那个
//   平台 → 回来的 model 是客户端问的那个对外 id。
//
// 「那个平台」是本次运行临时在测试进程里起的一个假上游（OpenAI 方言，只答
// chat/completions 与 models），地址由 admin RPC 写成平台行的 base_url —— 网关
// 是按平台的那一格去连的，所以这一趟请求真的出了网关、真的经过了路由改写，
// 只是对面是假上游，不碰任何平台、不花 token。

import { createServer } from 'node:http';
import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import {
  BASE,
  addAccount,
  adminRpc,
  dropPlatform,
  expectSamePage,
  login,
  markPage,
  seedPlatform,
  setAccountKey,
} from './panel.ts';

/** 面板上那个对外的 id。 */
const MODEL_ID = 'e2e-published';

/** 平台那一侧的模型名（假上游认的名字）。 */
const UPSTREAM_MODEL = 'fake-model-a';

/** 账号上那把 key —— 编造的样例，只用来证明它真的被带到了上游。 */
const ACCOUNT_KEY = 'sk-E2E-TESTONLY-0001'; // privacy:allow — 编造的样例

/** 假上游收到过的一次推理请求。 */
interface UpstreamCall {
  path: string;
  model: string;
  authorization: string;
}

/**
 * 起一个假上游，答 OpenAI 方言的 chat/completions 与 models。
 *
 * 收下来的每次请求都留着：断言要证明的是「上游收到的是目标模型名与那把 key」，
 * 光看网关的答复证明不了请求到底走到哪儿去了。
 */
async function startFakeUpstream(): Promise<{
  base: string;
  seen: UpstreamCall[];
  close: () => Promise<void>;
}> {
  const seen: UpstreamCall[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
    seen.push({
      path: req.url ?? '',
      model: String(body.model ?? ''),
      authorization: String(
        req.headers.authorization ?? req.headers['x-api-key'] ?? '',
      ),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion',
        model: String(body.model ?? ''),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 客户端看到的模型目录（OpenAI 方言的 /v1/models）。 */
async function clientCatalog(): Promise<string[]> {
  const res = await fetch(`${BASE}/v1/models`);
  const payload = (await res.json()) as { data?: Array<{ id: string }> };
  return (payload.data ?? []).map((model) => model.id);
}

test('主路由模型：面板上加一个模型发布出去，客户端用它发请求真的走到那个平台，回来的 model 是面板上那个对外 id', async ({
  app,
  screen,
  browser,
}) => {
  const upstream = await startFakeUpstream();
  const platform = 'e2e-publish';
  let saved = false;
  try {
    await seedPlatform({
      id: platform,
      label: 'E2E 发布站',
      kind: 'openai',
      baseUrl: `${upstream.base}/v1`,
    });
    const account = await addAccount(platform, '发布一号');
    await setAccountKey(account, ACCOUNT_KEY);

    await app.open();
    await login(screen);
    await screen.getByRole('link', { name: '主路由模型' }).click();
    await expect(screen.getByRole('heading', { name: '主路由模型' })).toBeVisible();

    // 新建：对外 id 是必填的那一格，目标在另一个分组里。
    await screen.getByRole('button', { name: '新增' }).click();
    const dialog = screen.getByRole('dialog', { name: '新增主路由模型' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('对外公布一个 id，背后挂一个或多个平台模型。'),
    ).toBeVisible();
    await dialog.getByLabel('对外 id').fill(MODEL_ID);
    await dialog.getByLabel('显示名').fill('E2E 发布');

    // 目标一格里什么都没有时，保存是灰的，并说清缺什么。
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();
    await dialog.getByRole('tab', { name: /平台目标/ }).click();
    await expect(
      dialog.getByText('至少要有一个填全的目标：平台组和平台模型 id 都要填。'),
    ).toBeVisible();

    // 平台组：下拉里是我们刚铺的那个平台。
    await dialog.getByLabel('平台组').click();
    await screen.getByRole('option', { name: /E2E 发布站/ }).click();

    // 平台模型 id：这个平台的目录是空的（没拉过），面板退回手填，并说明原因。
    const upstreamModel = dialog.getByRole('textbox', { name: '平台模型 id' });
    await expect(upstreamModel).toBeVisible();
    await upstreamModel.fill(UPSTREAM_MODEL);

    // 填全了就能存；存之前记一下「这一页没刷新过」。
    await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled();
    await markPage(browser);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    saved = true;

    // 列表里立刻有这一行，目标写成「平台 → 平台模型」。
    const row = screen.getByRole('row').filter({ hasText: MODEL_ID });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`${platform} → ${UPSTREAM_MODEL}`);
    // 没被标成「未公布」：有账号、有 key、目标填全了，根路由该公布它。
    await expect(row.getByText('未公布', { exact: false })).toHaveCount(0);
    await expectSamePage(browser);

    // 客户端的目录里有它。
    expect(await clientCatalog()).toContain(MODEL_ID);

    // 客户端用它发请求：真的走到那个平台，回来的模型名是它问的那个对外 id。
    const answer = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: 'user', content: 'say ok' }],
      }),
    });
    expect(answer.status).toBe(200);
    const payload = (await answer.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    expect(payload.choices?.[0]?.message?.content).toBe('ok');
    // 回来的不是上游内部的名字：对外 id 与平台模型名是两件事。
    expect(payload.model).toBe(MODEL_ID);

    // 上游那边收到的才是平台模型名，且带上了账号上那把 key。
    const calls = upstream.seen.filter((entry) =>
      entry.path.endsWith('/chat/completions'),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(UPSTREAM_MODEL);
    expect(calls[0]?.authorization).toContain(ACCOUNT_KEY);

    // 面板记的请求数也是 1（服务端真的把这次算在这个目标上）。
    const listed = await adminRpc<{
      models?: Array<{ id: string; targets?: Array<{ requests?: string }> }>;
    }>('ListPublishedModels');
    const published = (listed.models ?? []).find((entry) => entry.id === MODEL_ID);
    expect(Number(published?.targets?.[0]?.requests ?? 0)).toBe(1);

    // 重新进一次这一页（整页重新加载，不是客户端路由跳转）：面板的查询有
    // 10 秒的 staleTime，刚看过的数据不会重新取，跳一圈回来还是那个 0。
    await browser.goto('/admin/models');
    await expect(screen.getByRole('heading', { name: '主路由模型' })).toBeVisible();
    await expect(row).toContainText('1 次');

    // 删掉：确认框说清结果，删完列表立刻没有，客户端目录里也没有。
    await row.getByRole('button', { name: '删除' }).click();
    const confirm = screen.getByRole('dialog', { name: '确认删除该模型？' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('删除后客户端将无法看到该模型。');
    await confirm.getByRole('button', { name: '删除' }).click();
    await expect(confirm).toBeHidden();
    await expect(row).toHaveCount(0);
    saved = false;
    expect(await clientCatalog()).not.toContain(MODEL_ID);
  } finally {
    if (saved) {
      await adminRpc('DeletePublishedModel', { id: MODEL_ID }).catch(() => {});
    }
    await upstream.close();
    await dropPlatform(platform).catch(() => {});
  }
});
