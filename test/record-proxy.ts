// test/record-proxy.ts — record the upstream responses.
//
// A reverse proxy that forwards to the real upstream and writes every response
// down, so the fixtures the mock server replays are the real bytes and not
// something written by hand.
//
//   node --experimental-strip-types test/record-proxy.ts [port]
//
// The first path segment picks the upstream:
//
//   /qoder-global/...       api2-v2.qoder.sh        (the new protocol)
//   /qoder-global-legacy/…  api3.qoder.sh           (the legacy protocol)
//   /qoder-cn/...           gateway.qoder.com.cn    (China: legacy only)
//   /openapi-global/...     openapi.qoder.sh
//   /openapi-cn/...         openapi.qoder.com.cn
//   /workbuddy/...          www.workbuddy.cn
//   /minimax/...            the MiniMax Code gateway (MINIMAX_RECORD_BASE)
//   /tokenrhythm/...        tokenrhythm.studio
//
// The fixtures land in test/fixtures/, one file per method and path.

import http from "node:http";

const PORT = Number(process.argv[2] ?? 6699);

const UPSTREAMS: Record<string, string> = {
  "qoder-global": "https://api2-v2.qoder.sh",
  "qoder-global-legacy": "https://api3.qoder.sh",
  "qoder-cn": "https://gateway.qoder.com.cn",
  "openapi-global": "https://openapi.qoder.sh",
  "openapi-cn": "https://openapi.qoder.com.cn",
  workbuddy: "https://www.workbuddy.cn",
  // The gateway's own path is <base>/v1/messages.
  minimax: process.env.MINIMAX_RECORD_BASE ?? "https://agent.minimax.cn/mavis/api/v1/llm",
  tokenrhythm: process.env.TOKENRHYTHM_RECORD_BASE ?? "https://tokenrhythm.studio",
};

import { fixtureName, variantOf, writeFixture, FIXTURE_DIR } from "./fixture-name.ts";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const prefix = parts[0] ?? "";
  const base = UPSTREAMS[prefix];
  if (!base) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no upstream for /${prefix}` }));
    return;
  }
  const route = "/" + parts.slice(1).join("/") + url.search;

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  try {
    // The headers of the hop are not the headers of the upstream: the host
    // and the lengths belong to this proxy.
    const forwarded: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (["host", "content-length", "connection", "accept-encoding", "transfer-encoding"].includes(lower)) continue;
      if (typeof value === "string") forwarded[lower] = value;
    }
    const upstream = await fetch(base + route, {
      method: req.method,
      headers: forwarded,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      // The China region thinks for a long time.
      signal: AbortSignal.timeout(300_000),
    });
    const text = await upstream.text();
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      // The body was already decoded by fetch, so the encoding must not be
      // announced again — and the length does not survive the round trip
      // through a file.
      if (key === "content-length" || key === "content-encoding") return;
      headers[key] = value;
    });

    // The whole path, prefix included: two upstreams can share a path.
    const name = fixtureName(req.method ?? "GET", url.pathname + url.search, variantOf(body));
    writeFixture(name, { upstream: base + route, status: upstream.status, headers, body: text });
    console.log(`recorded ${name} (${upstream.status}, ${text.length} bytes)`);

    res.writeHead(upstream.status, headers);
    res.end(text);
  } catch (e) {
    console.error(`failed ${base + route}:`, (e as Error).message);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`recording proxy on http://127.0.0.1:${PORT} -> ${FIXTURE_DIR}`);
});
