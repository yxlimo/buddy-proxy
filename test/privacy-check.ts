// test/privacy-check.ts — the privacy scanner's own semantics.
//
//   node --experimental-strip-types test/privacy-check.ts
//
// Offline: nothing here touches the network and nothing touches a real
// account. The samples are made up, they only have the shape.
//
// The scanner is shape based, so the test is about shapes: every rule has to
// fire on a value that looks like the real thing, and stay quiet on the
// values that name nobody (127.0.0.1, test@example.com, ~/projects/x, a line
// marked privacy:allow).
//
// The samples below carry the allow marker: the scanner scans this file too,
// and a sample that is only a sample has no business in the report.
//
// Two more rules are pinned down below: a change that only deletes lines is
// scanned on no lines at all (the history behind the file is not this
// change's business), and a picture is not a leak (a compiled artifact is).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOW_MARKER, mask, scanFile, scanText } from "../check-privacy.ts";

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

/** The kinds the scanner reports for one piece of text. */
function kinds(text: string): string[] {
  return scanText(text, "sample").map((hit) => hit.kind);
}

/** The scanner on one piece of text: did the kind fire? */
function fires(text: string, kind: string): boolean {
  return kinds(text).includes(kind);
}

const MAIL = "dana.finch@corp.northwind.internal"; // privacy:allow
const KEY = "sk-EXAMPLEfakeEXAMPLEfake12"; // privacy:allow
const GH_P = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; // privacy:allow
const GH_O = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; // privacy:allow
const GH_PAT = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; // privacy:allow
const AWS = "AKIAFAKEFAKEFAKEFAKE"; // privacy:allow
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ"; // privacy:allow
const BEARER = "Bearer ZmFrZS1iZWFyZXItdG9rZW4tMTIzNA"; // privacy:allow
const LAN_192 = "192.168.50.4:6450"; // privacy:allow
const LAN_10 = "10.13.7.2"; // privacy:allow
const LAN_172 = "172.20.4.1"; // privacy:allow
const HOME_PATH = "/home/alice/projects"; // privacy:allow
const MAC_PATH = "/Users/bob/work"; // privacy:allow
const WIN_PATH = "C:\\Users\\carol\\notes"; // privacy:allow

console.log("");
console.log("邮箱");

check("真实形状的邮箱被抓到", fires(`reply to ${MAIL} please`, "email"), kinds(`reply to ${MAIL} please`).join(","));
check("example.com 不是人", !fires("test@example.com", "email"));
check("example.org 不是人", !fires("test@example.org", "email"));
check("test@ 不是人", !fires("test@corp.northwind.internal", "email"));
check("noreply@ 不是人", !fires("noreply@corp.northwind.internal", "email"));
check("github 的 no-reply 不是人", !fires("1234+someone@users.noreply.github.com", "email"));

console.log("");
console.log("凭据");

check("sk- 开头的长串被抓到", fires(`key = ${KEY}`, "secret-key"), kinds(`key = ${KEY}`).join(","));
check("ghp_ 被抓到", fires(`token ${GH_P}`, "github-token"));
check("gho_ 被抓到", fires(`token ${GH_O}`, "github-token"));
check("github_pat_ 被抓到", fires(`token ${GH_PAT}`, "github-token"));
check("AWS 的 key id 被抓到", fires(`aws ${AWS}`, "aws-key"));
check("JWT 被抓到", fires(`t ${JWT}`, "jwt"));
check("Bearer 被抓到", fires(`Authorization: ${BEARER}`, "bearer"));

console.log("");
console.log("内网地址");

check("192.168 被抓到", fires(`nas at ${LAN_192}`, "private-ip"));
check("10. 被抓到", fires(`host ${LAN_10}`, "private-ip"));
check("172.16-31 被抓到", fires(`host ${LAN_172}`, "private-ip"));
check("三段的版本号不是地址", !fires("host 10.4.1", "private-ip"));
check("五段的也不是地址", !fires("host 10.4.1.2.3", "private-ip"));
check("127.0.0.1 不是内网地址", !fires("upstream at 127.0.0.1:8080", "private-ip"));
check("localhost 不是内网地址", !fires("upstream at localhost:3000", "private-ip"));
check("172.32 不是内网地址", !fires("host 172.32.0.1", "private-ip"));

console.log("");
console.log("本机路径");

check("/home/<user> 被抓到", fires(`the session file is under ${HOME_PATH}`, "local-path"));
check("/Users/<name> 被抓到", fires(`the file is under ${MAC_PATH}`, "local-path"));
check("C:\\Users\\<name> 被抓到", fires(`the file is under ${WIN_PATH}`, "local-path"));
check("~/ 不是本机路径", !fires("the project is under ~/projects/x", "local-path"));
check("/var/log 不是本机路径", !fires("the log is under /var/log/app.log", "local-path"));

console.log("");
console.log("行内放行");

check("privacy:allow 的那行不报", !fires(`the key is ${KEY} // ${ALLOW_MARKER}`, "secret-key"));
check("同一行里的别的形状也不报", !fires(`mail ${MAIL} // ${ALLOW_MARKER}`, "email"));
check("没有标记的那行照报", fires(`the key is ${KEY}`, "secret-key"));

console.log("");
console.log("打码");

{
  const hit = scanText(`key = ${KEY}`, "sample")[0];
  check("片段只留前四个字符", hit.snippet === "sk-E***", hit.snippet);
  check("片段里没有完整的值", !hit.snippet.includes("EXAMPLEfake"), hit.snippet);
  check("mask 自己也不留尾巴", mask("abcdefghij") === "abcd***", mask("abcdefghij"));
}

console.log("");
console.log("二进制");

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-check-"));
  try {
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x41, 0x00, 0x42, 0x0a]));
    const hits = scanFile(dir, "blob.bin");
    check("含 NUL 字节的文件被认出来", hits.some((hit) => hit.kind === "binary-content"), JSON.stringify(hits));
    check("二进制不再报文本形状", !hits.some((hit) => hit.kind === "secret-key"), JSON.stringify(hits));
    check("未知扩展名的二进制不报成编译产物", !hits.some((hit) => hit.kind === "binary-file"), JSON.stringify(hits));

    // A picture: PNG magic and a NUL byte. The bytes are a normal product,
    // not a leak, and not a text file either.
    fs.writeFileSync(path.join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02]));
    const png = scanFile(dir, "shot.png");
    check("图片不报", png.length === 0, JSON.stringify(png));

    // A compiled artifact still is: it has no place in the repository.
    fs.writeFileSync(path.join(dir, "mod.so"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    const so = scanFile(dir, "mod.so");
    check("编译产物照旧报 binary-file", so.some((hit) => hit.kind === "binary-file"), JSON.stringify(so));

    fs.writeFileSync(path.join(dir, "mod.pyc"), "compiled bytes\n");
    const pyc = scanFile(dir, "mod.pyc");
    check(".pyc 报成二进制残留", pyc.some((hit) => hit.kind === "binary-file"), JSON.stringify(pyc));

    fs.writeFileSync(path.join(dir, "plain.txt"), "nothing here\n");
    const plain = scanFile(dir, "plain.txt");
    check("普通文本没有命中", plain.length === 0, JSON.stringify(plain));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
console.log("整条命令");

/** Run the scanner the way a person runs it, and take the code and the output. */
function runScanner(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", SCANNER, ...args], {
      cwd,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { code: failure.status ?? 1, out: failure.stdout ?? "" };
  }
}

/** Run git in the throwaway repository. */
function gitIn(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

const SCANNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "check-privacy.ts");

const TOKEN_A = "sk-FAKEfakeFAKEfakeFAKEfake12"; // privacy:allow
const TOKEN_B = "sk-FAKE2fakeFAKE2fakeFAKE2fake12"; // privacy:allow
const TOKEN_C = "sk-FAKE3fakeFAKE3fakeFAKE3fake12"; // privacy:allow
// Two samples with a different head, so the masked snippets of the two can
// be told apart in the report.
const HISTORY_TOKEN = "sk-HISTORYfakeHISTORYfake1234"; // privacy:allow
const ADDED_TOKEN = "sk-ADDEDfakeADDEDfake12345"; // privacy:allow

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-repo-"));
  try {
    gitIn(dir, ["init", "-q"]);
    gitIn(dir, ["config", "user.email", "ci@example.com"]);
    gitIn(dir, ["config", "user.name", "Privacy Check"]);

    fs.writeFileSync(path.join(dir, "clean.txt"), "nothing to hide here\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-qm", "init"]);

    const clean = runScanner(dir, []);
    check("干净的仓库退出码是 0", clean.code === 0, `${clean.code} ${clean.out}`);
    check("干净的时候也有汇总", clean.out.includes("扫了") && clean.out.includes("0 条命中"), clean.out);

    fs.writeFileSync(path.join(dir, "committed.txt"), `key = ${TOKEN_A}\n`);
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-qm", "add the sample"]);

    const committed = runScanner(dir, []);
    check("已提交的内容不算这次的改动", committed.code === 0, `${committed.code} ${committed.out}`);

    fs.appendFileSync(path.join(dir, "committed.txt"), `another = ${TOKEN_B}\n`);
    const changed = runScanner(dir, []);
    check("改动里的假 token 被抓到", changed.code === 1, `${changed.code} ${changed.out}`);
    check("报的是改动的那一行", changed.out.includes("committed.txt:2"), changed.out);
    check("输出里是打码的片段", changed.out.includes("sk-F***"), changed.out);
    check("输出里没有完整的 token", !changed.out.includes(TOKEN_B), changed.out);
    check("输出里没有之前提交过的 token", !changed.out.includes(TOKEN_A), changed.out);

    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-qm", `the key is ${TOKEN_C}`]);
    const message = runScanner(dir, []);
    check("提交信息里的形状也报", message.code === 1, `${message.code} ${message.out}`);
    check("提交信息有自己的位置", message.out.includes("(HEAD 提交信息)"), message.out);
    check("提交信息里的 token 也是打码的", !message.out.includes(TOKEN_C), message.out);

    const all = runScanner(dir, ["--all"]);
    check("--all 也抓得到", all.code === 1, `${all.code} ${all.out}`);
    check("--all 扫的是整个工作树", all.out.includes("整个工作树"), all.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
console.log("只删不改");

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-delete-"));
  try {
    gitIn(dir, ["init", "-q"]);
    gitIn(dir, ["config", "user.email", "ci@example.com"]);
    gitIn(dir, ["config", "user.name", "Privacy Check"]);

    fs.writeFileSync(
      path.join(dir, "history.txt"),
      `first line\nkey = ${HISTORY_TOKEN}\nlast line\n`,
    );
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-qm", "the history"]);

    // The change takes one line out and puts none in: the shape behind the
    // file belongs to the past, not to this change
    fs.writeFileSync(path.join(dir, "history.txt"), `first line\nkey = ${HISTORY_TOKEN}\n`);
    const deleted = runScanner(dir, []);
    check("只删一行的改动不报历史里的形状", deleted.code === 0, `${deleted.code} ${deleted.out}`);
    check("历史里的 token 没有进报告", !deleted.out.includes("sk-H***"), deleted.out);

    // The same file, one line with a shape of its own: now it belongs to the
    // change and is reported, the history still is not
    fs.writeFileSync(
      path.join(dir, "history.txt"),
      `first line\nkey = ${HISTORY_TOKEN}\nlast line\nadded = ${ADDED_TOKEN}\n`,
    );
    const added = runScanner(dir, []);
    check("新增的行被抓到", added.code === 1, `${added.code} ${added.out}`);
    check("报的是新增的那一行", added.out.includes("history.txt:4"), added.out);
    check("新增的那一行是打码的", added.out.includes("sk-A***"), added.out);
    check("历史里的 token 仍不报", !added.out.includes("sk-H***"), added.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

