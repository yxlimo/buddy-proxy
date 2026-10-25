// test/provider-policy-check.ts — 上游的生效策略：读、写、校验，还有签到选谁。
//
//   node --experimental-strip-types test/provider-policy-check.ts
//
// 离线：只碰自己的数据库，不问任何上游。

import fs from "node:fs";
import type { BenefitOutcome } from "../lib/benefits.ts";

const DATA_DIR = "/tmp/opencode/test-provider-policy";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const { create } = await import("@bufbuild/protobuf");
const { addProvider, listProviders, policyOf, provider, updateProvider } = await import(
  "../lib/providers.ts"
);
const { policyEnum, policyErrorText, policyFromEnum, unsupportedPolicyText } = await import(
  "../lib/admin/policy.ts"
);
const { policiesOfKind, registerKind } = await import("../lib/provider-kinds.ts");
// 种类登记在注册表里：导入它，种类才都在。
await import("../lib/kinds.ts");
const { upstreamAccountCount } = await import("../lib/admin/upstreams.ts");
const { adminService } = await import("../lib/admin/service.ts");
const { benefitUpstreams } = await import("../lib/admin/benefits.ts");
const { runBenefits } = await import("../lib/benefits.ts");
const { setSecret } = await import("../lib/store.ts");
const { miniMaxApiTenantSecretId } = await import("../lib/minimax/api.ts");
const { tokenRhythmTenantSecretId } = await import("../lib/tokenrhythm/accounts.ts");
const {
  CredentialState,
  ListProviderKindsRequestSchema,
  ProviderPolicy: ContractPolicy,
  SetProviderPolicyRequestSchema,
  UpdateProviderRequestSchema,
} = await import("../lib/gen/buddy/admin/v1/admin_pb.ts");

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

/** 打管理服务的方法（不经 HTTP）。 */
async function setPolicy(upstreamId: string, policy: number) {
  return adminService.setProviderPolicy!(
    create(SetProviderPolicyRequestSchema, { upstreamId, policy }),
  );
}

console.log("");
console.log("策略的读与写");

const rows = listProviders();
const qoder = rows.find((r) => r.id === "qoder");
check("新行的策略是 single", qoder?.policy === "single", String(qoder?.policy));

const written = updateProvider("qoder", { policy: "fallback" });
check("策略写得进去", written.ok === true, JSON.stringify(written));
check("policyOf 读回来是 fallback", policyOf("qoder") === "fallback", policyOf("qoder"));
check("整行里也是 fallback", provider("qoder")?.policy === "fallback");

const bad = updateProvider("qoder", { policy: "nope" as never });
check("不认识的策略不收", bad.ok === false, JSON.stringify(bad));
check(
  "错的话说了只认哪三个",
  bad.message.includes("single") && bad.message.includes("fallback") && bad.message.includes("expiry_first"),
  bad.message,
);
check("原来的策略没被动", policyOf("qoder") === "fallback", policyOf("qoder"));

const back = updateProvider("qoder", { policy: "single" });
check("改回 single", back.ok === true && policyOf("qoder") === "single", policyOf("qoder"));

updateProvider("qoder", { policy: "expiry_first" });
updateProvider("qoder", { alias: "Qoder（全球区）" });
check("没给策略就别动它", policyOf("qoder") === "expiry_first", policyOf("qoder"));
// 存储层不认种类（那一层是服务层的事），这里改回来，后面的校验从 single 起。
updateProvider("qoder", { policy: "single" });

const missing = updateProvider("no-such-upstream", { policy: "single" });
check("没有这个上游就不改", missing.ok === false, JSON.stringify(missing));

console.log("");
console.log("契约里的枚举");

check("single ↔ SINGLE", policyEnum("single") === ContractPolicy.SINGLE);
check("fallback ↔ FALLBACK", policyEnum("fallback") === ContractPolicy.FALLBACK);
check("expiry_first ↔ EXPIRY_FIRST", policyEnum("expiry_first") === ContractPolicy.EXPIRY_FIRST);
check("SINGLE → single", policyFromEnum(ContractPolicy.SINGLE) === "single");
check("FALLBACK → fallback", policyFromEnum(ContractPolicy.FALLBACK) === "fallback");
check("EXPIRY_FIRST → expiry_first", policyFromEnum(ContractPolicy.EXPIRY_FIRST) === "expiry_first");
check("UNSPECIFIED 不认", policyFromEnum(ContractPolicy.UNSPECIFIED) === null);
check("不认识的数字不认", policyFromEnum(7) === null);
const errorText = policyErrorText(0);
check(
  "错的话是中文，说了三个值",
  errorText.includes("单一") && errorText.includes("降级") && errorText.includes("余额到期优先"),
  errorText,
);

console.log("");
console.log("哪一类上游支持哪几个策略");

check(
  "tokenrhythm 三个",
  policiesOfKind("tokenrhythm").join(",") === "single,fallback,expiry_first",
  policiesOfKind("tokenrhythm").join(","),
);
check(
  "minimax-api 两个",
  policiesOfKind("minimax-api").join(",") === "single,fallback",
  policiesOfKind("minimax-api").join(","),
);
for (const kind of ["minimax", "qoder", "workbuddy", "sensenova", "intern-ai", "zcode"]) {
  check(
    `${kind} 只有单一`,
    policiesOfKind(kind).join(",") === "single",
    policiesOfKind(kind).join(","),
  );
}
check(
  "不认识的种类只给单一",
  policiesOfKind("no-such-kind").join(",") === "single",
  policiesOfKind("no-such-kind").join(","),
);

// 注册一种没填 policies 的上游（只在这个进程里）：面板的选项不能因此崩，
// 只能少一个选项。
registerKind({
  kind: "test-kind-no-policies",
  label: "测试种类",
  login: "device",
  baseUrl: () => "https://example.invalid",
  credential: () => ({
    kind: "session",
    status: CredentialState.UNSPECIFIED,
    fingerprint: "",
    expiresAt: 0,
    remainingSec: 0,
    warning: false,
    detail: "",
    generation: 0,
  }),
  models: () => [],
  quotas: () => [],
  outOfCredits: () => false,
});
const kinds = await adminService.listProviderKinds!(create(ListProviderKindsRequestSchema, {}));
const listed = (kinds.kinds as { kind: string; policies: number[] }[]).find(
  (k) => k.kind === "test-kind-no-policies",
);
check("漏填策略的种类也列得出来", !!listed, JSON.stringify(listed));
check(
  "漏填策略的种类给的是单一",
  listed?.policies.join(",") === String(ContractPolicy.SINGLE),
  listed?.policies.join(","),
);

console.log("");
console.log("SetProviderPolicy");

// 中转站：一个账号一个钱包，三个策略都支持。
const trFallback = await setPolicy("tokenrhythm", ContractPolicy.FALLBACK);
check("中转站能设降级", trFallback.ok === true, JSON.stringify(trFallback));
check("设完就是降级", policyOf("tokenrhythm") === "fallback", policyOf("tokenrhythm"));

const trExpiry = await setPolicy("tokenrhythm", ContractPolicy.EXPIRY_FIRST);
check("中转站能设余额到期优先", trExpiry.ok === true, JSON.stringify(trExpiry));
check("设完就是余额到期优先", policyOf("tokenrhythm") === "expiry_first", policyOf("tokenrhythm"));

const trSingle = await setPolicy("tokenrhythm", ContractPolicy.SINGLE);
check("中转站能设回单一", trSingle.ok === true && policyOf("tokenrhythm") === "single");

// 开放平台：一把 key 一个租户，降级行，余额到期优先不行。
const apiFallback = await setPolicy("minimax-api", ContractPolicy.FALLBACK);
check("开放平台能设降级", apiFallback.ok === true, JSON.stringify(apiFallback));
const apiExpiry = await setPolicy("minimax-api", ContractPolicy.EXPIRY_FIRST);
check("开放平台不收余额到期优先", apiExpiry.ok === false, JSON.stringify(apiExpiry));
check(
  "拒收的话说了这一类支持哪几个",
  String(apiExpiry.message).includes("单一") && String(apiExpiry.message).includes("降级"),
  String(apiExpiry.message),
);
check("拒收的没写进库", policyOf("minimax-api") === "fallback", policyOf("minimax-api"));
await setPolicy("minimax-api", ContractPolicy.SINGLE);

// 只有一个账号的：别的策略选了也没有用。
const qoderFallback = await setPolicy("qoder", ContractPolicy.FALLBACK);
check("Qoder 不收降级", qoderFallback.ok === false, JSON.stringify(qoderFallback));
check(
  "拒收的话说了只支持单一",
  String(qoderFallback.message).includes("单一") &&
    !String(qoderFallback.message).includes("降级（fallback）"),
  String(qoderFallback.message),
);
check("Qoder 的策略没被动", policyOf("qoder") === "single", policyOf("qoder"));

// 给错了的：不写库。
const unspecified = await setPolicy("tokenrhythm", ContractPolicy.UNSPECIFIED);
check("UNSPECIFIED 不收", unspecified.ok === false, JSON.stringify(unspecified));
check(
  "错的话说了只认哪三个",
  ["single", "fallback", "expiry_first"].every((v) => String(unspecified.message).includes(v)),
  String(unspecified.message),
);
const unknown = await setPolicy("tokenrhythm", 7);
check("不认识的数字不收", unknown.ok === false, JSON.stringify(unknown));
check("给错了的没写进库", policyOf("tokenrhythm") === "single", policyOf("tokenrhythm"));

const noSuch = await setPolicy("no-such-upstream", ContractPolicy.SINGLE);
check("没有这个上游就不改", noSuch.ok === false, JSON.stringify(noSuch));

const unsupportedText = unsupportedPolicyText("Qoder", "fallback", ["single"]);
check(
  "拒收的话是中文",
  unsupportedText.includes("Qoder") && unsupportedText.includes("单一") && unsupportedText.includes("single"),
  unsupportedText,
);

console.log("");
console.log("UpdateProvider 不再碰策略");

// 策略有自己的方法了：改别名与开关不该动到它。
await setPolicy("tokenrhythm", ContractPolicy.FALLBACK);
const aliasOnly = await adminService.updateProvider!(
  create(UpdateProviderRequestSchema, { id: "tokenrhythm", alias: "TokenRhythm" }),
);
check("只改别名是改得掉的", aliasOnly.ok === true, JSON.stringify(aliasOnly));
check("只改别名不动策略", policyOf("tokenrhythm") === "fallback", policyOf("tokenrhythm"));
await setPolicy("tokenrhythm", ContractPolicy.SINGLE);

console.log("");
console.log("账号数");

// 开放平台：一把 key 一个租户。
addProvider({ id: "mm-test", kind: "minimax-api", alias: "测试开放平台" });
setSecret(miniMaxApiTenantSecretId(1, "mm-test"), "key", { key: "sk-cp-one" });
setSecret(miniMaxApiTenantSecretId(2, "mm-test"), "key", { key: "sk-cp-two" });
check("开放平台数租户", upstreamAccountCount("mm-test") === 2, String(upstreamAccountCount("mm-test")));

// 中转站：一个账号一个钱包。
addProvider({ id: "tr-test", kind: "tokenrhythm", alias: "测试中转站" });
setSecret(tokenRhythmTenantSecretId(1, "tr-test"), "account", {
  account: "one@example.com",
  password: "pw-one",
  apiKey: "sk-tr-one",
});
check("中转站数租户", upstreamAccountCount("tr-test") === 1, String(upstreamAccountCount("tr-test")));
setSecret(tokenRhythmTenantSecretId(2, "tr-test"), "account", {
  account: "two@example.com",
  password: "pw-two",
  apiKey: "sk-tr-two",
});
check("中转站有两个就是两个", upstreamAccountCount("tr-test") === 2, String(upstreamAccountCount("tr-test")));

// 其余：一个账号就是 1。
check("Qoder 是一个账号", upstreamAccountCount("qoder") === 1, String(upstreamAccountCount("qoder")));
check("WorkBuddy 是一个账号", upstreamAccountCount("workbuddy-cn") === 1, String(upstreamAccountCount("workbuddy-cn")));
check("没有的上游是 0", upstreamAccountCount("no-such-upstream") === 0, String(upstreamAccountCount("no-such-upstream")));

console.log("");
console.log("签到选账号");

// 第二个 Qoder 账号：用户自己加的。新加的行是开着的。
addProvider({ id: "qoder-2", kind: "qoder", alias: "第二个 Qoder" });

updateProvider("qoder-2", { enabled: false });
check("没开的时候不签到", benefitUpstreams().length === 0, benefitUpstreams().join(","));

updateProvider("qoder", { enabled: true });
updateProvider("qoder-2", { enabled: true });
let ups = benefitUpstreams();
check("两个 Qoder 账号都签到", ups.includes("qoder") && ups.includes("qoder-2"), ups.join(","));
check("关着的那个不签到", !ups.includes("qoder-cn"), ups.join(","));
check("别的种类不签到", !ups.includes("zcode") && !ups.includes("tokenrhythm"), ups.join(","));

// 策略是转发的事：签到一个都不许少。
updateProvider("qoder", { policy: "single" });
updateProvider("qoder-2", { policy: "fallback" });
ups = benefitUpstreams();
check("策略不影响签到", ups.includes("qoder") && ups.includes("qoder-2"), ups.join(","));

updateProvider("qoder", { enabled: false });
ups = benefitUpstreams();
check("关掉的账号不签到", !ups.includes("qoder") && ups.includes("qoder-2"), ups.join(","));

console.log("");
console.log("每个账号都签到");

const calls: string[] = [];
const outcome = (upstream: string): BenefitOutcome => ({
  upstream,
  ok: true,
  credits: 0,
  report: [],
  at: new Date().toISOString(),
});
const fake = {
  workbuddy: async (id: string) => {
    calls.push(`workbuddy:${id}`);
    return outcome(id);
  },
  minimax: async (id: string) => {
    calls.push(`minimax:${id}`);
    return outcome(id);
  },
  qoder: async (id: string) => {
    calls.push(`qoder:${id}`);
    return outcome(id);
  },
};

const results = await runBenefits(["qoder-2"], fake);
check("qoder 的账号走了 qoder 那条路", calls.join(",") === "qoder:qoder-2", calls.join(","));
check("一条结果对一个账号", results.length === 1 && results[0].upstream === "qoder-2");

calls.length = 0;
await runBenefits(["minimax", "qoder-2", "zcode"], fake);
check(
  "每个账号一次，不认的种类跳过",
  calls.join(",") === "minimax:minimax,qoder:qoder-2",
  calls.join(","),
);

console.log("");
console.log("签到的定时器");

// 启动的时候一个账号也没有，定时器照样要设：面板后来加的账号得被签到。
// run 换成假的，不发真请求。
const { BenefitsRunner } = await import("../lib/router/benefits.ts");
const signed: string[] = [];
let accounts: string[] = [];
const timer = new BenefitsRunner({
  intervalMs: 20,
  upstreams: () => accounts,
  run: async (ups) => {
    signed.push(...ups);
    return [];
  },
});
accounts = ["qoder-late"];
await timer.runOnce();
check(
  "启动时没有账号，后来加的账号也会被签到",
  signed.includes("qoder-late"),
  signed.join(","),
);

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
