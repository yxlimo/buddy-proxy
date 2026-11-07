// test/mock-server.ts — serve the recorded upstream responses.
//
// The counterpart of record-proxy.ts: the same routes, but the answers come
// from the fixtures instead of the upstream. The router cannot tell the
// difference, so the whole pipeline — the dialect conversion, the usage, the
// error handling — is exercised without spending a token.
//
//   node --experimental-strip-types test/mock-server.ts [port]
//
// A request that has no fixture answers 404 with the list of the ones that do,
// which is what a missing recording looks like.

import fs from "node:fs";
import http from "node:http";
import { fixtureName, readFixture, variantOf, type Fixture, FIXTURE_DIR } from "./fixture-name.ts";

const PORT = Number(process.argv[2] ?? 6699);

function load(method: string, route: string, variant: string): Fixture | null {
  // 目录端点在推理地址的上一层（推理是 <base>/v1，目录是 <base>/models）：
  // 录制的名字按不含 /v1 的那个路径取，所以目录这条路两条都试。
  // 只对目录这一条路这样：别的路径（推理、额度）没有这种上下两层的关系，
  // 试错会答错东西。
  const [path, search = ""] = route.split("?");
  const suffix = search ? `?${search}` : "";
  const candidates = [path];
  if (path.endsWith("/models")) {
    const withoutV1 = path.replace(/\/v1(?=\/|$)/, "");
    if (withoutV1 !== path) candidates.push(withoutV1);
  }
  for (const candidate of candidates) {
    for (const name of [
      fixtureName(method, candidate + suffix, variant),
      fixtureName(method, candidate + suffix, "all"),
    ]) {
      const fixture = readFixture(name);
      if (fixture) return fixture;
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const route = url.pathname + url.search;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const fixture = load(req.method ?? "GET", route, variantOf(body));
  if (!fixture) {
    const known = fs.existsSync(FIXTURE_DIR) ? fs.readdirSync(FIXTURE_DIR).sort() : [];
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no fixture for ${req.method} ${route}`, known }, null, 2));
    return;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(fixture.headers)) {
    // The length does not survive the round trip through a file.
    if (key === "content-length" || key === "content-encoding") continue;
    headers[key] = value;
  }
  res.writeHead(fixture.status, headers);
  res.end(fixture.body);
});

server.listen(PORT, "127.0.0.1", () => {
  const count = fs.existsSync(FIXTURE_DIR) ? fs.readdirSync(FIXTURE_DIR).length : 0;
  console.log(`mock server on http://127.0.0.1:${PORT} (${count} fixtures)`);
});
