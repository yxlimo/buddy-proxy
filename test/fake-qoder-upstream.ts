// test/fake-qoder-upstream.ts — 假的上游：一个能回答的 Qoder。
//
//   node --experimental-strip-types test/fake-qoder-upstream.ts [port]
//
// 它说的是 Qoder 的那一套（CLI 自己的 COSY 协议）：请求的正文是按 Qoder 的
// base64 编好的，key 在 model_config.key 里（gmodel 是 GLM-5.3，dmodel 是
// DeepSeek-V4-Pro，kmodel 是 Kimi-K2.8-Preview，mmodel 是 MiniMax-M3.1-Flash）；
// 答复是 `data:{"headers":…,"body":"<json>"}` 那种帧。签名不查（那是网关的事，
// 这里要的是「网关发了什么、拿到什么」）。
//
// gmodel 与 dmodel 答得上，kmodel 与 mmodel 故意失败（500），好让 fallback
// 有东西可退。
//
// 什么都不会出机器。

import http from "node:http";
import { decodeLegacyBody, legacyChunk, legacyEnd, legacyModelKey } from "./legacy-wire.ts";

export interface FakeQoder {
  /** 假上游的地址。 */
  base: string;
  /** 收到过的推理请求：上游的模型名，与正文里最后一条消息。 */
  seen: { model: string; stream: boolean; messages: unknown[] }[];
  /** 忘掉收到过什么。 */
  reset(): void;
  /** 停下来。 */
  close(): void;
}

/** 这些上游的模型名一律失败。 */
export const FAILING_MODELS = new Set(["kmodel", "mmodel"]);

/** 起一个假的上游。 */
export async function startFakeQoder(port = 0): Promise<FakeQoder> {
  const seen: { model: string; stream: boolean; messages: unknown[] }[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any = {};
    try {
      body = decodeLegacyBody(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* 不是这个协议的正文：还是回一句，让测试看见差别 */
    }
    const model = legacyModelKey(body);
    seen.push({
      model,
      stream: body.stream === true,
      messages: Array.isArray(body.messages) ? body.messages : [],
    });

    if (FAILING_MODELS.has(model)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `the fake upstream refuses ${model}`, type: "server_error" },
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(legacyChunk("ok") + legacyEnd());
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  const actual = (server.address() as { port: number }).port;

  return {
    base: `http://127.0.0.1:${actual}`,
    seen,
    reset() {
      seen.length = 0;
    },
    close() {
      server.close();
    },
  };
}

// 直接跑起来的时候：起一个固定端口的假上游。
if (process.argv[1] && process.argv[1].endsWith("fake-qoder-upstream.ts")) {
  const port = Number(process.argv[2] ?? 6794);
  const fake = await startFakeQoder(port);
  console.log(`fake qoder upstream on ${fake.base}`);
}
