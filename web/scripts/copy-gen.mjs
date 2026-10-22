// web/scripts/copy-gen.mjs — 把契约的生成物搬进面板包里。
//
// 生成物在仓库的 lib/gen/ 里，前后端共用一份，不进版本库的两份拷贝。
// 但它 import 的 @bufbuild/protobuf 要从「文件所在目录往上」找 node_modules
// —— 生成物在 web/ 外面，找到的是仓库根目录的那份，面板自己的构建环境里
// 没有它，类型就断了。
//
// 所以构建前把它搬进 web/.gen/：文件在 web/ 里面，依赖从 web/node_modules
// 里找。搬的是构建产物，不进版本库，来源只有 lib/gen/ 一处。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..");
const SOURCE = path.join(WEB, "..", "lib", "gen");
const TARGET = path.join(WEB, ".gen");

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst);
      continue;
    }
    if (!fs.existsSync(dst) || fs.readFileSync(src).compare(fs.readFileSync(dst)) !== 0) {
      fs.copyFileSync(src, dst);
    }
  }
}

if (!fs.existsSync(SOURCE)) {
  console.error(`契约的生成物不在 ${SOURCE}。先跑 mise run proto。`);
  process.exit(1);
}

fs.rmSync(TARGET, { recursive: true, force: true });
copyTree(SOURCE, TARGET);
console.log(`契约的生成物已搬到 ${path.relative(WEB, TARGET)}/`);
