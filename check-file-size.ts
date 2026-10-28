// check-file-size.ts — the gate on how big a file may get.
//
//   node --experimental-strip-types check-file-size.ts            # warn
//   node --experimental-strip-types check-file-size.ts --strict   # fail
//
// A file that grows past the limit is a file nobody can change safely: the
// merge conflicts pile up and every edit touches every other edit. So the
// limit is checked here, and the files that are over it are named.
//
// The exit code is 0 unless --strict is given: the list is what matters, and
// the files that are already over the limit cannot be made smaller by a gate
// that suddenly fails. Use --strict once the list is empty.
//
// The generated contract (lib/gen) is not counted: it is written by buf, not
// by hand.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LIMIT = 400;
// The generated contract: buf writes it, so it is as long as the contract
// says and nothing else.
const GENERATED = path.join("lib", "gen");

/** The files that are checked: lib/**\/*.ts and the router itself. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.relative(ROOT, full) === GENERATED) continue;
      out.push(...sources(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** The number of lines in a file: the last line counts even without a newline. */
function lineCount(file: string): number {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

const files = [...sources(path.join(ROOT, "lib")), path.join(ROOT, "router-proxy.ts")];
const over = files
  .map((file) => ({ path: path.relative(ROOT, file), lines: lineCount(file) }))
  .filter((f) => f.lines > LIMIT)
  .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));

for (const file of over) console.log(`${file.path} ${file.lines}`);
console.log(`${over.length} 个文件超过 ${LIMIT} 行`);

if (over.length > 0 && process.argv.includes("--strict")) process.exit(1);
