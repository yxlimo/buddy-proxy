// tools/patch-enums.mjs — 把生成物里的 TypeScript enum 换成 const 对象。
//
//   node scripts/patch-enums.mjs
//
// 为什么要有这一步：Node 的「只剥类型」模式（--experimental-strip-types，
// 后端默认就是这个）不认 enum 语法 —— enum 是要编译的，不是能直接剥掉的。
// 后端没有构建步骤，.ts 文件是直接跑的，所以生成物里不能有 enum。
//
// 换完形状不变：值还是那些值，类型还是那个联合类型（const 对象的值的联合）。
// 前端那边 vite 怎么编译都行，不受影响。
//
// 跑在 buf generate 之后：mise run proto  已经把这一步串上了。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEN_DIR = path.join(ROOT, "lib", "gen");

/** 找所有 .ts 文件。 */
function tsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * 找到 `export enum 名字 {` 的开头与结尾。
 *
 * 结尾就是那个花括号配平的地方 —— enum 的内容里没有别的花括号（只有注释
 * 与成员），所以数花括号就够。
 */
function findEnum(source, from) {
  const start = source.indexOf("export enum ", from);
  if (start < 0) return null;
  const brace = source.indexOf("{", start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const end = source.indexOf(";", i);
        return { start, name: source.slice(start + "export enum ".length, brace).trim(), brace, close: i, tail: end };
      }
    }
  }
  return null;
}

/** 成员：名字 = 数值。 */
function members(body) {
  const out = [];
  for (const line of body.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)\s*,?\s*$/.exec(line);
    if (m) out.push({ name: m[1], value: m[2] });
  }
  return out;
}

/** 换掉一个 enum。 */
function patchEnum(source, found) {
  const body = source.slice(found.brace + 1, found.close);
  const list = members(body);
  if (!list.length) return null;
  const lines = list.map((m) => `  ${m.name}: ${m.value},`).join("\n");
  const replacement =
    `export const ${found.name} = {\n${lines}\n} as const;\n` +
    `export type ${found.name} = (typeof ${found.name})[keyof typeof ${found.name}];`;
  return source.slice(0, found.start) + replacement + source.slice(found.close + 1);
}

let changed = 0;
for (const file of tsFiles(GEN_DIR)) {
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  for (;;) {
    const found = findEnum(after, 0);
    if (!found) break;
    const patched = patchEnum(after, found);
    if (!patched) break;
    after = patched;
    changed++;
  }
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`[PATCH] ${path.relative(ROOT, file)}：换掉了 ${(before.match(/export enum /g) ?? []).length} 个 enum`);
  }
}
console.log(changed ? `[PATCH] 一共换掉了 ${changed} 个 enum` : "[PATCH] 没有 enum 要换");
