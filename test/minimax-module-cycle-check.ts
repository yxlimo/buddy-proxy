// test/minimax-module-cycle-check.ts — the MiniMax modules load, whichever one
// is the entry.
//
//   node --experimental-strip-types test/minimax-module-cycle-check.ts
//
// lib/minimax/auth.ts, oauth.ts and transport.ts are in one import cycle
// (auth → oauth → providers → platforms → kinds → transport → auth). A
// constant read across that cycle while a module loads can hit a binding that
// is not initialized yet, and the process dies before it serves anything.
//
// So the entry point is the thing under test: each module is loaded first in
// its own process, and the load order is flipped for the pair that used to
// break. Nothing touches the network.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Each load runs in its own process: a module that was already loaded cannot
// be loaded "first" again, and the failure this guards against happens only
// at module-evaluation time.
function loadAs(entry: string): { ok: boolean; out: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-cycle-"));
  try {
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "-e",
        `await import(${JSON.stringify(path.join(ROOT, "lib/minimax", entry))}); console.log("ok");`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, BUDDY_DATA_DIR: dataDir },
      },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { ok: r.status === 0 && r.stdout?.trim() === "ok", out };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// Two modules in one process, in the given order.
function loadPair(first: string, second: string): { ok: boolean; out: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-cycle-"));
  try {
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "-e",
        `await import(${JSON.stringify(path.join(ROOT, "lib/minimax", first))});` +
          `await import(${JSON.stringify(path.join(ROOT, "lib/minimax", second))});` +
          `console.log("ok");`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, BUDDY_DATA_DIR: dataDir },
      },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { ok: r.status === 0 && r.stdout?.trim() === "ok", out };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log("单个入口");

for (const entry of ["auth.ts", "oauth.ts", "transport.ts"]) {
  const r = loadAs(entry);
  check(`从 ${entry} 加载不崩`, r.ok, r.out);
}

console.log("");
console.log("先加载谁都行");

const pairs: Array<[string, string]> = [
  ["oauth.ts", "auth.ts"],
  ["auth.ts", "oauth.ts"],
  ["transport.ts", "oauth.ts"],
  ["oauth.ts", "transport.ts"],
];

for (const [first, second] of pairs) {
  const r = loadPair(first, second);
  check(`先 ${first} 再 ${second}`, r.ok, r.out);
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) {
  console.log(problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
