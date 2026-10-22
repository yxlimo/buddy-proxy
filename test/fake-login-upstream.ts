// test/fake-login-upstream.ts — 假的上游：只回答登录那几条路。
//
//   node --experimental-strip-types test/fake-login-upstream.ts [port]
//
// 面板的登录对话框有四种形态（device / browser / password / token）。
// 这一轮不真的登录任何平台：起一个假的上游，答 device code、答授权状态、
// 答轮询（一直 pending），再故意让 Qoder 的轮询失败、Koder 的密码登录失败，
// 好把对话框的四种样子与失败提示都看一遍。
//
// 什么都不会出机器。

import http from "node:http";

const PORT = Number(process.argv[2] ?? 6793);

/** 假上游收到过的请求（调试用）。 */
export const seen: string[] = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  seen.push(`${req.method} ${path}`);

  const json = (status: number, payload: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  // ── MiniMax：device 流 ──────────────────────────────────────────────
  if (path === "/oauth2/device/code") {
    json(200, {
      device_code: "FAKE-DEVICE-CODE-MUST-NOT-LEAK",
      user_code: "WXYZ-1234",
      verification_uri: "https://example.invalid/authorize",
      verification_uri_complete: "https://example.invalid/authorize?user_code=WXYZ-1234",
      expires_in: 300,
      interval: 3,
    });
    return;
  }
  // MiniMax 的轮询：一直 pending（用户在浏览器里还没点同意）。
  if (path === "/oauth2/token") {
    json(200, { status: "pending" });
    return;
  }

  // ── Qoder：轮询被拒 → 登录失败 ───────────────────────────────────────
  if (path.startsWith("/qoder-openapi/api/v1/deviceToken/poll")) {
    json(401, { errorCode: "E_AUTH_REJECTED" });
    return;
  }

  // ── WorkBuddy：浏览器流 ──────────────────────────────────────────────
  if (path.startsWith("/workbuddy/v2/plugin/auth/state")) {
    json(200, {
      code: 0,
      data: { state: "FAKE-STATE", authUrl: "https://example.invalid/workbuddy-login?state=FAKE-STATE" },
    });
    return;
  }
  // WorkBuddy 的轮询：一直 pending。
  if (path.startsWith("/workbuddy/v2/plugin/auth/token")) {
    json(200, { code: 11217, msg: "还在等用户同意" });
    return;
  }

  // ── SenseNova：密码登录，慢一点失败 ──────────────────────────────────
  if (path.startsWith("/sensenova/")) {
    // 慢一点，好让面板上的「提交中」看得见。
    await new Promise((r) => setTimeout(r, 2500));
    json(500, { error: "upstream_error", message: "假上游不让人登录" });
    return;
  }

  // ── intern-ai：SSO 的地址只是给人看的 ────────────────────────────────
  if (path.startsWith("/intern-ai/")) {
    json(500, { error: "upstream_error", message: "假上游不让人登录" });
    return;
  }

  json(404, { error: `no fake route for ${req.method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake login upstream on http://127.0.0.1:${PORT}`);
});
