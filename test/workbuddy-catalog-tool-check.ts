// test/workbuddy-catalog-tool-check.ts — the tool that writes the China table.
//
//   node --experimental-strip-types test/workbuddy-catalog-tool-check.ts
//
// Offline: a made-up product config in a temporary directory, no client cache,
// no upstream, no request.
//
// scripts/workbuddy-catalog.ts turns the desktop client's product config into
// lib/workbuddy/cn-catalog.json. What is checked here is the part that could go
// wrong quietly:
//
//   1. an empty `credits` is null — "no multiplier", not free
//   2. a bare `effort` is a fixed level: no levels to pick, and that level as
//      the default
//   3. the models that are not chat models are filtered out
//   4. the same input renders the same bytes
//   5. --check answers 0 when the file is current and 1 when it is not
//   6. the newest cache file wins when several are there
//   7. no printed path carries the machine's user name

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCatalog,
  creditValue,
  diffCatalog,
  effortsOf,
  filesIn,
  locateInput,
  maskPath,
  newestOf,
  parseFailure,
  render,
  resolveSource,
  run,
  windowsCacheDir,
  windowsToLinux,
  type CatalogEntry,
  type Probe,
} from "../scripts/workbuddy-catalog.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "workbuddy-catalog.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-catalog-tool-"));

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

/* ------------------------------------------------------------------ *
 * 造一份客户端的 product config
 * ------------------------------------------------------------------ */

/** 一份最小的配置：两个 chat 模型，外加每一种该被过滤的。 */
function productConfig(credits = "x0.11"): any {
  return {
    genieVersion: "9.9.9",
    agents: [
      { name: "cli", models: ["chat-a", "chat-b"] },
      { name: "compact", models: ["wb-lite"] },
    ],
    models: [
      {
        id: "chat-a",
        name: "Chat A",
        credits,
        maxInputTokens: 1000000,
        maxOutputTokens: 128000,
        supportsImages: true,
        supportsToolCall: true,
        supportsReasoning: true,
        onlyReasoning: true,
        reasoning: {
          supportedEfforts: ["low", "high", "max"],
          defaultEffort: "high",
          canDisableThinking: true,
        },
      },
      {
        id: "chat-b",
        name: "Chat B",
        // 空串 = 没有倍率，不是免费
        credits: "",
        maxInputTokens: 200000,
        maxOutputTokens: 64000,
        reasoning: { effort: "high", summary: "auto" },
      },
      { id: "kling-video-v3", videoGeneration: { aspectRatios: ["16:9"] } },
      { id: "completion-gf", maxInputTokens: 200000, maxOutputTokens: 8192 },
      { id: "codewise-rewrite", maxInputTokens: 200000, maxOutputTokens: 256 },
      { id: "hunyuan-image-alpha-edit", maxInputTokens: 200000 },
      { id: "default-1.2", maxInputTokens: 200000, maxOutputTokens: 24000 },
      { id: "wb-lite" },
      { id: "deepseek-v3-1-volc", maxInputTokens: 96000, maxOutputTokens: 32000 },
      { id: "hy3-b", maxInputTokens: 192000, maxOutputTokens: 64000, labels: ["enterprise:selfhost"] },
    ],
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

/** 把一次解析失败的那个错误对象捞出来：parseFailure 测的就是它。 */
function catchOf(text: string): unknown {
  try {
    JSON.parse(text);
  } catch (error) {
    return error;
  }
  throw new Error("这份内容竟然解析成功了");
}

/** 跑一次命令行，返回退出码与输出。HOME 可换，测的是 os.homedir() 那条脱敏。 */
function cli(args: string[], env = process.env): { code: number; out: string } {
  const res = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  if (res.error) throw res.error;
  return { code: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

console.log("");
console.log("the values");

check('"x0.69" → 0.69', creditValue("x0.69") === 0.69, String(creditValue("x0.69")));
check('"x0.69 credits" → 0.69', creditValue("x0.69 credits") === 0.69, String(creditValue("x0.69 credits")));
check('"" → null, not 0', creditValue("") === null, String(creditValue("")));
check("a missing credits → null", creditValue(undefined) === null, String(creditValue(undefined)));
check('"x0.00" → 0 (free is a number)', creditValue("x0.00") === 0, String(creditValue("x0.00")));

const fixed = effortsOf({ effort: "high", summary: "auto" });
check(
  "a bare effort is a fixed level, not a one-item list",
  JSON.stringify(fixed.efforts) === "[]" && fixed.defaultEffort === "high",
  JSON.stringify(fixed),
);
const listed = effortsOf({ supportedEfforts: ["high", "xhigh"], defaultEffort: "xhigh", effort: "high" });
check(
  "a list of efforts is the list, with its own default",
  JSON.stringify(listed.efforts) === '["high","xhigh"]' && listed.defaultEffort === "xhigh",
  JSON.stringify(listed),
);
const nothing = effortsOf(null);
check(
  "no reasoning at all says nothing",
  JSON.stringify(nothing.efforts) === "[]" && nothing.defaultEffort === "" && nothing.canDisableThinking === null,
  JSON.stringify(nothing),
);

console.log("");
console.log("what is kept");

const built = buildCatalog(productConfig());
check(
  "only the chat models are kept",
  built.models.map((m) => m.id).join(",") === "chat-a,chat-b",
  built.models.map((m) => m.id).join(","),
);
check(
  "an empty credits in the file is null, not 0",
  built.models[1].credits === null,
  JSON.stringify(built.models[1]),
);
check(
  "the fixed-effort model has no levels and one default",
  JSON.stringify(built.models[1].efforts) === "[]" && built.models[1].defaultEffort === "high",
  JSON.stringify(built.models[1]),
);
check("the models come out sorted by id", built.models[0].id < built.models[1].id, JSON.stringify(built.models.map((m) => m.id)));
const dropped = built.dropped.map((d) => d.id).join(",");
check(
  "video, completion, image, alias, no-window and the deployment variants are filtered",
  dropped ===
    [
      "codewise-rewrite",
      "completion-gf",
      "deepseek-v3-1-volc",
      "default-1.2",
      "hunyuan-image-alpha-edit",
      "hy3-b",
      "kling-video-v3",
      "wb-lite",
    ].join(","),
  dropped,
);

console.log("");
console.log("the output is stable");

const first = render(buildCatalog(productConfig()).models, "9.9.9");
const second = render(buildCatalog(productConfig()).models, "9.9.9");
check("the same input renders the same bytes", first === second, `${first.length} / ${second.length}`);
check("two-space indent, one trailing newline", first.includes('\n  "source"') && first.endsWith("}\n") && !first.endsWith("\n\n"), JSON.stringify(first.slice(-4)));
check("nothing in it is a timestamp", !/\d{4}-\d{2}-\d{2}T/.test(first), "");
// 一份内容相同但键顺序不同的配置也必须渲染成同一份：差两个字节的目录会把
// --check 变成噪声，之后就没人看它了。
const shuffled = productConfig();
shuffled.models = [...shuffled.models].reverse();
check(
  "the order the config lists the models in does not matter",
  render(buildCatalog(shuffled).models, "9.9.9") === first,
  "",
);

console.log("");
console.log("the differences");

const before = buildCatalog(productConfig()).models;
const after = buildCatalog(productConfig("x0.19")).models;
const lines = diffCatalog(before, after);
check(
  "a changed value is one line, with both sides",
  lines.join("\n") === "chat-a credits: 0.11 → 0.19",
  lines.join("\n"),
);
const added = diffCatalog(before, [...after, { ...after[0], id: "chat-c" } as CatalogEntry]);
check("a new model is a line of its own", added.includes("新增 chat-c"), added.join("\n"));
const removed = diffCatalog(before, [after[0]]);
check("a model that is gone says so", removed.includes("消失 chat-b"), removed.join("\n"));

console.log("");
console.log("--check and the write");

const cfg = path.join(tmp, "config", "acc-product-config-v3-new.json");
writeJson(cfg, productConfig());
const out = path.join(tmp, "cn-catalog.json");

const firstCheck = cli(["--config", cfg, "--out", out, "--check"]);
check("--check on a missing file says 1", firstCheck.code === 1, `${firstCheck.code} ${firstCheck.out.slice(0, 200)}`);

const wrote = cli(["--config", cfg, "--out", out]);
check("the plain run writes it", wrote.code === 0 && fs.existsSync(out), `${wrote.code} ${wrote.out.slice(0, 200)}`);
const written = fs.readFileSync(out, "utf8");

const clean = cli(["--config", cfg, "--out", out, "--check"]);
check("--check on a current file says 0", clean.code === 0, `${clean.code} ${clean.out.slice(0, 200)}`);

const again = cli(["--config", cfg, "--out", out]);
check(
  "a second run leaves the bytes alone",
  again.code === 0 && fs.readFileSync(out, "utf8") === written,
  `${again.code}`,
);

const dry = cli(["--config", cfg, "--out", out, "--dry-run"]);
check("--dry-run does not touch the file", dry.code === 0 && fs.readFileSync(out, "utf8") === written, String(dry.code));

const changedCfg = path.join(tmp, "config", "acc-product-config-v3-changed.json");
writeJson(changedCfg, productConfig("x0.19"));
const stale = cli(["--config", changedCfg, "--out", out, "--check"]);
check(
  "--check on an outdated file says 1 and names the change",
  stale.code === 1 && stale.out.includes("chat-a credits: 0.11 → 0.19"),
  `${stale.code} ${stale.out.slice(0, 300)}`,
);

// run() 也走同一条路：直接调用的地方（测试、脚本里）不该和命令行两套语义。
check("run() writes and answers 0", run({ config: cfg, out }) === 0, "");
check("run() with --check answers 0 when it is current", run({ config: cfg, out, check: true }) === 0, "");
check("run() with --check answers 1 when it is not", run({ config: changedCfg, out, check: true }) === 1, "");

console.log("");
console.log("which cache file is the input");

const cache = path.join(tmp, "cache");
const older = path.join(cache, "acc-product-config-v3-old.json");
const newer = path.join(cache, "acc-product-config-v3-new.json");
const other = path.join(cache, "something-else.json");
writeJson(older, { ...productConfig(), genieVersion: "1.0.0" });
writeJson(newer, { ...productConfig(), genieVersion: "2.0.0" });
writeJson(other, { genieVersion: "3.0.0" });
fs.utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
fs.utimesSync(newer, new Date(2026, 5, 1), new Date(2026, 5, 1));

check("the newest one wins", newestOf([older, newer]) === newer, String(newestOf([older, newer])));
check(
  "with its own version",
  resolveSource(cfg, probeOf({}))?.genieVersion === "9.9.9",
  String(resolveSource(cfg, probeOf({}))?.genieVersion),
);

// 输入只认客户端的缓存名：同一个目录里别的 json 不是输入。
const found = filesIn(cache);
check(
  "only the client cache names are candidates",
  found.length === 2 && found.includes(older) && found.includes(newer) && !found.includes(other),
  found.join(","),
);
check("a directory without a cache answers nothing", filesIn(path.join(tmp, "nowhere")).length === 0, "");

console.log("");
console.log("where the input is looked for");

// 探路全部从外面给：这台机器有没有 WSL interop、家目录里有没有缓存，都不影响
// 被测的东西。
function probeOf(opts: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  profile?: string | null;
  wslpath?: (win: string) => string | null;
  onWindowsAsk?: () => void;
}): Probe {
  return {
    env: opts.env ?? {},
    home: opts.home ?? path.join(tmp, "no-home"),
    windowsProfile: () => {
      opts.onWindowsAsk?.();
      return opts.profile ?? null;
    },
    toLinuxPath: opts.wslpath ?? (() => null),
  };
}

const barrenHome = path.join(tmp, "no-home");
const namedCfg = path.join(tmp, "named", "acc-product-config-v3-named.json");
writeJson(namedCfg, productConfig());

let askedWindows = 0;
const onlyExplicit = probeOf({
  env: { WORKBUDDY_PRODUCT_CONFIG: namedCfg, WORKBUDDY_CACHE_DIR: cache },
  home: barrenHome,
  profile: "C:\\Users\\tester",
  onWindowsAsk: () => {
    askedWindows++;
  },
});
check(
  "--config is used as it is, nothing else is looked at",
  locateInput("/somewhere/acc-product-config-v3-x.json", onlyExplicit) ===
    "/somewhere/acc-product-config-v3-x.json" &&
    askedWindows === 0,
  String(locateInput("/somewhere/acc-product-config-v3-x.json", onlyExplicit)),
);

check(
  "WORKBUDDY_PRODUCT_CONFIG names the file",
  locateInput(undefined, probeOf({ env: { WORKBUDDY_PRODUCT_CONFIG: namedCfg }, home: barrenHome })) === namedCfg,
  "",
);
check(
  "WORKBUDDY_CACHE_DIR names the directory, newest inside it",
  locateInput(
    undefined,
    probeOf({ env: { WORKBUDDY_CACHE_DIR: cache }, home: barrenHome }),
  ) === newer,
  String(locateInput(undefined, probeOf({ env: { WORKBUDDY_CACHE_DIR: cache }, home: barrenHome }))),
);
check(
  "the file name beats the directory name",
  locateInput(
    undefined,
    probeOf({ env: { WORKBUDDY_PRODUCT_CONFIG: namedCfg, WORKBUDDY_CACHE_DIR: cache }, home: barrenHome }),
  ) === namedCfg,
  "",
);
// 家目录里的那份不带任何用户名：拼的是 os.homedir()
const homeCache = path.join(tmp, "home-tester", ".workbuddy", "cache");
writeJson(path.join(homeCache, "acc-product-config-v3-home.json"), productConfig());
const homeProbe = probeOf({ home: path.join(tmp, "home-tester") });
check(
  "then the home directory, without listing anyone else's",
  locateInput(undefined, homeProbe) === path.join(homeCache, "acc-product-config-v3-home.json"),
  String(locateInput(undefined, homeProbe)),
);
check(
  "an empty env directory falls through to the home directory",
  locateInput(undefined, probeOf({ env: { WORKBUDDY_CACHE_DIR: path.join(tmp, "nowhere") }, home: path.join(tmp, "home-tester") })) ===
    path.join(homeCache, "acc-product-config-v3-home.json"),
  "",
);

console.log("");
console.log("the Windows side is asked, not guessed");

// 编造的样例：被测的就是这两种形状，所以这两行必须存在
const WIN_PROFILE = "C:\\Users\\tester"; // privacy:allow — 编造的样例
const WIN_HOME = "/mnt/c/Users/tester"; // privacy:allow — 编造的样例
const winCache = `${WIN_HOME}/.workbuddy/cache`;

check(
  "a Windows home becomes the WSL mount by hand",
  windowsToLinux(WIN_PROFILE) === WIN_HOME,
  String(windowsToLinux(WIN_PROFILE)),
);
check(
  "with wslpath gone, the hand conversion gives the cache dir",
  windowsCacheDir(probeOf({ profile: WIN_PROFILE })) === winCache,
  String(windowsCacheDir(probeOf({ profile: WIN_PROFILE }))),
);
check(
  "wslpath wins when it answers",
  windowsCacheDir(
    probeOf({ profile: WIN_PROFILE, wslpath: () => path.join(tmp, "wsl-c") }),
  ) === path.join(tmp, "wsl-c", ".workbuddy", "cache"),
  String(windowsCacheDir(probeOf({ profile: WIN_PROFILE, wslpath: () => path.join(tmp, "wsl-c") }))),
);
check(
  "no interop at all is a null, not a guess",
  windowsCacheDir(probeOf({ profile: null })) === null,
  String(windowsCacheDir(probeOf({ profile: null }))),
);
check(
  "the Windows cache is only reached when nothing else answers",
  locateInput(
    undefined,
    probeOf({ home: barrenHome, profile: WIN_PROFILE, wslpath: () => path.join(tmp, "nowhere-win") }),
  ) === null,
  "",
);

console.log("");
console.log("nothing found is said out loud");

// 一条路都不通：不猜、不报路径，只说怎么给。console.error 捕下来看它到底说了什么。
const said: string[] = [];
const savedError = console.error;
let barrenCode = -1;
try {
  console.error = (...args: unknown[]) => {
    said.push(args.map(String).join(" "));
  };
  barrenCode = run({ probe: probeOf({ home: barrenHome, profile: null }) });
} finally {
  console.error = savedError;
}
const message = said.join("\n");
check("no input answers 1", barrenCode === 1, String(barrenCode));
check(
  "and says how to give it",
  message.includes("--config") &&
    message.includes("WORKBUDDY_PRODUCT_CONFIG") &&
    message.includes("WORKBUDDY_CACHE_DIR"),
  message,
);
check(
  "without naming a user",
  !message.includes(path.basename(os.homedir())) && !message.includes("tester"),
  message,
);

console.log("");
console.log("什么能进日志");

// 输入是客户端缓存，路径里带着本机用户名；这些行会被贴进报告或提交。
// 下面两个路径是形状本身，被测的就是它：编造的样例，不是谁的机器。
const WSL_SAMPLE = "/mnt/c/Users/alice/.workbuddy/cache/acc.json"; // privacy:allow — 编造的样例
const HOME_SAMPLE = "/home/alice/.workbuddy/x"; // privacy:allow — 编造的样例

check(
  "a WSL user's home becomes <user>, the rest stays",
  maskPath(WSL_SAMPLE) === "/mnt/c/Users/<user>/.workbuddy/cache/acc.json",
  maskPath(WSL_SAMPLE),
);
check(
  "a home directory becomes ~",
  maskPath(HOME_SAMPLE) === "~/.workbuddy/x",
  maskPath(HOME_SAMPLE),
);
check(
  "anything that is not a home is left alone",
  maskPath("/tmp/x.json") === "/tmp/x.json" &&
    maskPath("lib/workbuddy/cn-catalog.json") === "lib/workbuddy/cn-catalog.json",
  `${maskPath("/tmp/x.json")} / ${maskPath("lib/workbuddy/cn-catalog.json")}`,
);

// 逐处改打印会漏一两处：换个家目录跑一整轮，整份输出里不许有那个名字。
// os.homedir() 跟着 HOME 走，config 和输出就都落在这个假家目录下面。
const fakeHome = path.join(tmp, "home-alice");
const homeCfg = path.join(fakeHome, ".workbuddy", "cache", "acc-product-config-v3-home.json");
const homeOut = path.join(fakeHome, "lib", "cn-catalog.json");
const homeCfgChanged = path.join(fakeHome, ".workbuddy", "cache", "acc-product-config-v3-home2.json");
writeJson(homeCfg, productConfig());
writeJson(homeCfgChanged, productConfig("x0.19"));
const fakeEnv = { ...process.env, HOME: fakeHome };

const homeWrite = cli(["--config", homeCfg, "--out", homeOut], fakeEnv);
const homeDry = cli(["--config", homeCfgChanged, "--out", homeOut, "--dry-run"], fakeEnv);
const homeStale = cli(["--config", homeCfgChanged, "--out", homeOut, "--check"], fakeEnv);
const homeAll = `${homeWrite.out}${homeDry.out}${homeStale.out}`;
check(
  "the run, the dry run and the check all print no user name",
  !homeAll.includes("alice"),
  homeAll.split("\n").filter((line) => line.includes("alice")).join(" | "),
);
check(
  "and the home is shown as ~ in every one of them",
  homeWrite.out.includes("输入：~/.workbuddy/cache/") &&
    homeWrite.out.includes(`写了 ~/lib/cn-catalog.json`) &&
    homeDry.out.includes("要写进 ~/lib/cn-catalog.json") &&
    homeStale.out.includes("有差异：~/lib/cn-catalog.json"),
  `${homeWrite.out.slice(0, 120)} | ${homeStale.out.slice(0, 120)}`,
);

console.log("");
console.log("Windows 形状的路径");

// 这两行是形状本身：被测的就是它，编造的样例，不是谁的机器。
const WIN_FILE = "C:\\Users\\alice\\.workbuddy\\cache\\x.json"; // privacy:allow — 编造的样例
const WIN_SLASH = "C:/Users/alice/.workbuddy/cache/x.json"; // privacy:allow — 编造的样例
const WIN_MASKED = "C:\\Users\\<user>\\.workbuddy\\cache\\x.json";

check("a Windows path keeps the drive and masks the name", maskPath(WIN_FILE) === WIN_MASKED, maskPath(WIN_FILE));
check("forward slashes as well", maskPath(WIN_SLASH) === "C:/Users/<user>/.workbuddy/cache/x.json", maskPath(WIN_SLASH));
check(
  "a path in the middle of a message is masked too, not just at the start",
  maskPath(`ENOENT: no such file or directory, open '${WIN_FILE}'`) === `ENOENT: no such file or directory, open '${WIN_MASKED}'`,
  maskPath(`ENOENT: no such file or directory, open '${WIN_FILE}'`),
);
check("masking what is already masked changes nothing", maskPath(WIN_MASKED) === WIN_MASKED, maskPath(WIN_MASKED));

// 用户给的 --config 是这个形状时，Node 的 ENOENT 会自己再拼一遍路径，光改打印
// 点挡不住。整轮输出里不许出现那个名字。
const winRun = cli(["--config", WIN_FILE, "--out", path.join(tmp, "win-out.json")]);
check("a Windows --config that is not there answers 2", winRun.code === 2, `${winRun.code} ${winRun.out.slice(0, 200)}`);
check(
  "and its output names no user",
  !winRun.out.includes("alice") && winRun.out.includes("<user>"),
  winRun.out.split("\n").slice(0, 3).join(" | "),
);

console.log("");
console.log("fs 冒泡上来的错误");

// 把 --out 指向一个目录：fs.writeFileSync 掀 EISDIR，消息里带着整条路径，而这条
// 路径的前缀是 HOME，也就是一个带用户名的家目录。
const errHome = path.join(tmp, "home-tester");
const errCfg = path.join(errHome, ".workbuddy", "cache", "acc-product-config-v3-err.json");
writeJson(errCfg, productConfig());
const errOut = path.join(errHome, "lib", "cn-catalog.json");
fs.mkdirSync(errOut, { recursive: true });
const errRun = cli(["--config", errCfg, "--out", errOut], { ...process.env, HOME: errHome });
check("writing onto a directory answers 2", errRun.code === 2, `${errRun.code} ${errRun.out.slice(0, 200)}`);
check(
  "the message that bubbles up carries no user name",
  !errRun.out.includes("tester"),
  errRun.out.split("\n").filter((line) => line.includes("tester")).join(" | "),
);
check(
  "and the path in it is the masked one",
  errRun.out.includes("~/lib/cn-catalog.json") && /EISDIR|EACCES|EPERM|ENOTDIR/.test(errRun.out),
  errRun.out.slice(-240),
);

console.log("");
console.log("解析失败不贴文件内容");

// V8 的 JSON 语法错误会附一段文件内容；输入是客户端配置，那段不许进日志。
const badFile = path.join(tmp, "bad", "acc-product-config-v3-bad.json");
fs.mkdirSync(path.dirname(badFile), { recursive: true });
fs.writeFileSync(badFile, '{"genieVersion":"9.9.9","owner":"tester-not-a-user","models":[tester-not-a-user]}', "utf8");
const badRun = cli(["--config", badFile, "--out", path.join(tmp, "bad-out.json")]);
check("a file that is not JSON answers 2", badRun.code === 2, `${badRun.code} ${badRun.out.slice(0, 200)}`);
check(
  "the message says which file and what kind of failure",
  badRun.out.includes("解析不了") && badRun.out.includes("acc-product-config-v3-bad.json") && badRun.out.includes("SyntaxError"),
  badRun.out.slice(0, 300),
);
check(
  "and quotes none of the file's content",
  !badRun.out.includes("tester") && !badRun.out.includes("owner") && !badRun.out.includes("models"),
  badRun.out.slice(0, 300),
);
check(
  "a parse failure is its type and position, never the snippet",
  !String(parseFailure(catchOf('{"id":"x",oops}'))).includes("oops") &&
    parseFailure(catchOf('{"a":1,')) === "SyntaxError（line 1 column 8）",
  `${parseFailure(catchOf('{"id":"x",oops}'))} / ${parseFailure(catchOf('{"a":1,'))}`,
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
process.exit(fail === 0 ? 0 : 1);
