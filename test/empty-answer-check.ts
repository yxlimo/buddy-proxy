// test/empty-answer-check.ts — 「输出全在思考里」的判据。
//
//   node --experimental-strip-types test/empty-answer-check.ts
//
// 上游答 200、completion 含思考，减掉思考后没有正文，就是这条判据要抓的。
// 用纯函数测，不起假上游、不碰数据库。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 网关的模块加载时就会开库，所以先给它一个自己的数据目录。
process.env.BUDDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-empty-answer-"));

const { isAllThinking, effectiveMaxTokens, budgetUsed } = await import("../lib/router/handle.ts");

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// 正文 = 0。原来的 30684 差出来是 6，落在判据（<=5）之外，所以改掉的是
// 这组数，不是判据：判据来自实测（100/1063 次的差值 <= 5）。
check("思考吃满：正文为 0", isAllThinking({ completionTokens: 30690, reasoningTokens: 30690 }));
check("思考一部分：正文还在", !isAllThinking({ completionTokens: 100, reasoningTokens: 50 }));
check("没有思考：正文正常", !isAllThinking({ completionTokens: 100, reasoningTokens: 0 }));
check("没有 usage：不判", !isAllThinking({ completionTokens: 0, reasoningTokens: 0 }));
check("没有 usage 对象：不判", !isAllThinking(undefined));
check("只有思考没有完成数：不判", !isAllThinking({ completionTokens: 0, reasoningTokens: 300 }));

// 第二条分支：思考吃满预算、正文只剩一点。实测里有 completion=30690 /
// reasoning=30684（正文 6），只靠 <=5 的判据会漏掉它。
check("思考吃满、正文只剩 6", isAllThinking({ completionTokens: 30690, reasoningTokens: 30684 }));
// 思考很多但正文还有 200：不是空答复。
check("思考很多但正文有用", !isAllThinking({ completionTokens: 5000, reasoningTokens: 3000 }));
// 正常短答复：思考也少，两条分支都走不到。
check("短答复、思考也少", !isAllThinking({ completionTokens: 18, reasoningTokens: 6 }));

// 生效的上限：模拟客户端的上游用它自己发的那个数，不是客户端要的那个。
// Qoder 固定发 32000，客户端传 4096 也没用（见 lib/qoder/models.ts）。
check(
  "Qoder 用发出去的上限，不是客户端要的",
  effectiveMaxTokens({ upstreamMaxTokens: 32000 }, { max_tokens: 4096 }) === 32000,
);
check(
  "没有上游上限时退回客户端的",
  effectiveMaxTokens({}, { max_tokens: 4096 }) === 4096,
);
check(
  "客户端用 max_completion_tokens 也认",
  effectiveMaxTokens({}, { max_completion_tokens: 128 }) === 128,
);
check("两边都没有：未指定", effectiveMaxTokens({}, {}) === "未指定");

// 用掉了多少：思考吃满预算时是 100%。
check("用掉 100%", budgetUsed(32000, 32000) === "100%");
check("用掉 96%", budgetUsed(30690, 32000) === "96%");
check("上限不是数字：不知道", budgetUsed(100, "未指定") === "?");

console.log("");
console.log("结果");
console.log(`pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
