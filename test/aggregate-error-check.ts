// test/aggregate-error-check.ts — 聚合路由：给客户端看哪一个错。
//
//   node --experimental-strip-types test/aggregate-error-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 根路由后面有多个 target 时，客户端看到的是哪一个错？不该是最后一个：
// 前面那个可能是「这个账号没额度」，最后那个是「这个上游没有这个模型」——
// 客户端拿到后者就会去改模型名，而真正该做的是等额度恢复。
//
//   503（额度/冷却/凭据） > 其它 5xx > 4xx，同一档里取第一个。

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = "/buddy.admin.v1.AdminService";
/** 假上游对它答 400（这个上游没有这个模型）。 */
const MODEL_A = "MiniMax-M3.1-Flash";
/** 假上游对它答 404。 */
const MODEL_B = "MiniMax-M3";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    const url = req.url ?? "";
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.includes("/model/v1/chat/completions")) {
      // Qoder：模型在排队。上游的 429 是「等一会儿」，网关报 503。
      json(429, { error: { message: "the model is queued", type: "rate_limit_error" } });
      return;
    }
    if (url.includes("/messages")) {
      const model = String(body.model ?? "");
      if (model === MODEL_B) {
        json(404, { type: "error", error: { type: "invalid_request_error", message: "model-B-missing" } });
        return;
      }
      json(400, { type: "error", error: { type: "invalid_request_error", message: "model-A-missing" } });
      return;
    }
    // 别的路径（面板要的那些）：这个自测不用它们。
    json(404, { error: { message: "not a route the test uses" } });
  });
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as any).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

interface Gateway {
  base: string;
  token: string;
  stop: () => void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function startGateway(): Promise<Gateway> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-error-"));
  const child = spawn(process.execPath, ["router-proxy.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      BUDDY_DATA_DIR: dataDir,
      ROUTER_PORT: String(port),
      BENEFITS_DISABLED: "1",
      // 定时器关着：不换令牌、不签到、不扫余额 —— 自测不碰任何平台。
      PERIODIC_ENABLED: "false",
      MINIMAX_BASE_URL: upstreamBase,
      MINIMAX_API_BASE: upstreamBase,
      MINIMAX_REGION: "cn",
      QODER_GLOBAL_INFER_BASE: upstreamBase,
      QODER_GLOBAL_OPENAPI_BASE: upstreamBase,
      // 上游说在排队时网关会等一下再试。自测不等。
      QODER_MAX_ATTEMPTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (c: Buffer) => {
    log += c.toString();
  });
  child.stderr?.on("data", (c: Buffer) => {
    log += c.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        await res.text();
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    child.kill("SIGTERM");
    console.log(log.slice(-1500));
    throw new Error("网关没起来");
  }

  const tokenFile = path.join(dataDir, "admin-token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";

  // 两个账号：一个 MiniMax Code（答 400），一个 Qoder（上游说在排队）。
  const seed = new DatabaseSync(path.join(dataDir, "buddy.db"));
  seed.exec("PRAGMA busy_timeout = 5000");
  const insertSecret = seed.prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  const now = Date.now();
  const gw: Gateway = {
    base,
    token,
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* 已经走了 */
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };

  const minimax = await call(gw, "AddAccount", { platform: "minimax", alias: "MiniMax" });
  const minimaxId = String(minimax.body?.id ?? "");
  check("MiniMax 的账号建出来了", Boolean(minimaxId), JSON.stringify(minimax.body));
  insertSecret.run(
    `session:provider:${minimaxId}`,
    "session",
    JSON.stringify({
      schemaVersion: 1,
      clientId: "minimax-code",
      audience: "minimax",
      scopes: [],
      region: "cn",
      accessToken: "tok-1",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAtMs: now + 3600_000,
      generation: 1,
      loginAtMs: now,
      refreshedAtMs: now,
    }),
    now,
  );

  const qoder = await call(gw, "AddAccount", { platform: "qoder", alias: "Qoder" });
  const qoderId = String(qoder.body?.id ?? "");
  check("Qoder 的账号建出来了", Boolean(qoderId), JSON.stringify(qoder.body));
  insertSecret.run(
    `session:provider:${qoderId}`,
    "session",
    JSON.stringify({
      schemaVersion: 1,
      region: "global",
      clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
      accessToken: "dt-test-token",
      refreshToken: "drt-test-token",
      userId: "test-user",
      expiresAtMs: now + 365 * 24 * 3600 * 1000,
      refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
      machineId: "test-machine",
      machineToken: "test-machine-token",
      machineType: "test",
      generation: 1,
      loginAtMs: now,
      refreshedAtMs: now,
    }),
    now,
  );
  seed.close();
  return gw;
}

/** 打一个面板的方法（Connect over HTTP）。 */
async function call(gw: Gateway, method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}${SERVICE}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gw.token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** 打根路由：模型名是发布出来的那个。 */
async function ask(gw: Gateway, model: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${gw.base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "public" },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "say ok" }],
    }),
  });
  return { status: res.status, text: await res.text() };
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

console.log("");
console.log("场景一：503 与 400 —— 客户端拿到 503");

{
  const gw = await startGateway();
  try {
    const saved = await call(gw, "SavePublishedModel", {
      model: {
        id: "pub-mixed",
        displayName: "混着的",
        enabled: true,
        strategy: "fallback",
        targets: [
          // 权重大的先试：Qoder 在排队（网关报 503）。
          { groupName: "qoder", upstreamModel: "glm-5.3", weight: 2, enabled: true },
          // MiniMax 说没有这个模型（400）。
          { groupName: "minimax", upstreamModel: MODEL_A, weight: 1, enabled: true },
        ],
      },
    });
    check("发布模型成功了", saved.body?.ok === true, JSON.stringify(saved.body));

    const answered = await ask(gw, "pub-mixed");
    check("客户端拿到 503", answered.status === 503, `${answered.status} ${answered.text.slice(0, 200)}`);
    check(
      "错的是排队那个（503），不是没有这个模型（400）",
      !answered.text.includes("model-A-missing"),
      answered.text.slice(0, 300),
    );
  } finally {
    gw.stop();
  }
}

console.log("");
console.log("场景二：两个都是 4xx —— 客户端拿到第一个的错");

{
  const gw = await startGateway();
  try {
    const saved = await call(gw, "SavePublishedModel", {
      model: {
        id: "pub-both",
        displayName: "两个 4xx",
        enabled: true,
        strategy: "fallback",
        targets: [
          // 先试的这个答 400。
          { groupName: "minimax", upstreamModel: MODEL_A, weight: 2, enabled: true },
          // 后试的这个答 404。
          { groupName: "minimax", upstreamModel: MODEL_B, weight: 1, enabled: true },
        ],
      },
    });
    check("发布模型成功了", saved.body?.ok === true, JSON.stringify(saved.body));

    const answered = await ask(gw, "pub-both");
    check("客户端拿到 4xx", answered.status === 400, `${answered.status} ${answered.text.slice(0, 200)}`);
    check(
      "是第一个 target 的错",
      answered.text.includes("model-A-missing"),
      answered.text.slice(0, 300),
    );
    check(
      "不是最后一个 target 的错",
      !answered.text.includes("model-B-missing"),
      answered.text.slice(0, 300),
    );
  } finally {
    gw.stop();
  }
}

upstream.close();

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
