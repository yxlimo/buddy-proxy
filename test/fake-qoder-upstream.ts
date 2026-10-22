// test/fake-qoder-upstream.ts — 假的上游：一个能回答的 Qoder。
//
//   node --experimental-strip-types test/fake-qoder-upstream.ts [port]
//
// 它说的是 Qoder 的新协议（OpenAI 方言）：请求的 model 是上游的 key
// （gmodel 是 GLM-5.3，dmodel 是 DeepSeek-V4-Pro，kmodel 是 Kimi-K2.8-Preview，
// mmodel 是 MiniMax-M3.1-Flash）。gmodel 与 dmodel 答得上，kmodel 与 mmodel
// 故意失败（500），好让 fallback 有东西可退。
//
// 什么都不会出机器。

import http from "node:http";

export interface FakeQoder {
  /** 假上游的地址。 */
  base: string;
  /** 收到过的推理请求：上游的模型名。 */
  seen: { model: string; stream: boolean }[];
  /** 忘掉收到过什么。 */
  reset(): void;
  /** 停下来。 */
  close(): void;
}

/** 这些上游的模型名一律失败。 */
export const FAILING_MODELS = new Set(["kmodel", "mmodel"]);

/** 起一个假的上游。 */
export async function startFakeQoder(port = 0): Promise<FakeQoder> {
  const seen: { model: string; stream: boolean }[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    const model = String(body.model ?? "");
    const path = req.url ?? "";
    if (path.includes("/model/v1/chat/completions")) {
      seen.push({ model, stream: body.stream === true });
    }

    if (FAILING_MODELS.has(model)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `the fake upstream refuses ${model}`, type: "server_error" },
        }),
      );
      return;
    }

    const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      frame({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 1700000000,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      });
      frame({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 1700000000,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 1700000000,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage,
      }),
    );
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
