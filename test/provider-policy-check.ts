// test/provider-policy-check.ts — 平台的生效策略：读、写、校验，还有签到选谁。
//
//   node --experimental-strip-types test/provider-policy-check.ts
//
// 离线：只碰自己的数据库，不问任何上游。
//
// 策略在**平台**这一层（lib/platforms.ts 的 platform_policy 表），账号是 provider
// 表里的行。所以这里改策略用 setPlatformPolicy，加减账号用 addAccount。

import fs from "node:fs";
import type { BenefitOutcome } from "../lib/benefits.ts";

const DATA_DIR = "/tmp/opencode/test-provider-policy";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const { create } = await import("@bufbuild/protobuf");
const { accountsOfPlatform, addAccount, listProviders, provider, updateProvider } = await import(
  "../lib/providers.ts"
);
const { platformPolicies, platformPolicy, setPlatformPolicy } = await import("../lib/platforms.ts");
const { policyEnum, policyErrorText, policyFromEnum, unsupportedPolicyText } = await import(
  "../lib/admin/policy.ts"
);
const { policiesOfKind, registerKind } = await import("../lib/provider-kinds.ts");
// 种类登记在注册表里：导入它，种类才都在。
await import("../lib/kinds/index.ts");
const { upstreamAccountCount } = await import("../lib/admin/upstreams.ts");
const { adminService } = await import("../lib/admin/service.ts");
const { benefitUpstreams } = await import("../lib/admin/benefits.ts");
const { runBenefits } = await import("../lib/benefits.ts");
const { setSecret } = await import("../lib/store.ts");
const { tokenRhythmCredentialSecretId } = await import("../lib/tokenrhythm/accounts.ts");
const {
  CredentialState,
  ListProviderKindsRequestSchema,
  ProviderPolicy: ContractPolicy,
  SetPlatformPolicyRequestSchema,
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
async function setPolicy(platform: string, policy: number) {
  return adminService.setPlatformPolicy!(
    create(SetPlatformPolicyRequestSchema, { platform, policy }),
  );
}

console.log("");
console.log("没有账号的新库");

// 启动不再插行：新部署后面板上一个账号都没有。
check("新库里一个账号都没有", listProviders().length === 0, String(listProviders().length));
check("没有账号的平台策略是 single", platformPolicy("qoder") === "single", platformPolicy("qoder"));

console.log("");
console.log("策略的读与写");

check("写得进去", setPlatformPolicy("qoder", "single").ok === true);
// 每个平台都收降级（只有 tokenrhythm 多一个余额到期优先）：读回来也得是 fallback。
const fallbackOnQoder = setPlatformPolicy("qoder", "fallback");
check("Qoder 收降级", fallbackOnQoder.ok === true, JSON.stringify(fallbackOnQoder));
check("Qoder 读回来是 fallback", platformPolicy("qoder") === "fallback", platformPolicy("qoder"));
const qoderBackToSingle = setPlatformPolicy("qoder", "single");
check(
  "Qoder 能设回 single",
  qoderBackToSingle.ok === true && platformPolicy("qoder") === "single",
  JSON.stringify(qoderBackToSingle),
);

const written = setPlatformPolicy("tokenrhythm", "fallback");
check("中转站的策略写得进去", written.ok === true, JSON.stringify(written));
check("读回来是 fallback", platformPolicy("tokenrhythm") === "fallback", platformPolicy("tokenrhythm"));

const bad = setPlatformPolicy("tokenrhythm", "nope" as never);
check("不认识的策略不收", bad.ok === false, JSON.stringify(bad));
check(
  "错的话说了只认哪几个",
  bad.message.includes("single") && bad.message.includes("fallback") && bad.message.includes("expiry_first"),
  bad.message,
);
check("原来的策略没被动", platformPolicy("tokenrhythm") === "fallback", platformPolicy("tokenrhythm"));

const unknownPlatform = setPlatformPolicy("no-such-platform", "single");
check("没有这个平台就不改", unknownPlatform.ok === false, JSON.stringify(unknownPlatform));

const back = setPlatformPolicy("tokenrhythm", "single");
check("改回 single", back.ok === true && platformPolicy("tokenrhythm") === "single");

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
console.log("一类上游支持哪几个策略");

check(
  "tokenrhythm 三个",
  policiesOfKind("tokenrhythm").join(",") === "single,fallback,expiry_first",
  policiesOfKind("tokenrhythm").join(","),
);
check(
  "七牛云两个",
  policiesOfKind("qiniu").join(",") === "single,fallback",
  policiesOfKind("qiniu").join(","),
);
for (const kind of ["minimax", "qoder", "workbuddy", "sensenova", "intern-ai", "zcode"]) {
  check(
    `${kind} 收 single 与 fallback`,
    policiesOfKind(kind).join(",") === "single,fallback",
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
console.log("SetPlatformPolicy");

const trFallback = await setPolicy("tokenrhythm", ContractPolicy.FALLBACK);
check("中转站能设降级", trFallback.ok === true, JSON.stringify(trFallback));
check("设完就是降级", platformPolicy("tokenrhythm") === "fallback", platformPolicy("tokenrhythm"));

const trExpiry = await setPolicy("tokenrhythm", ContractPolicy.EXPIRY_FIRST);
check("中转站能设余额到期优先", trExpiry.ok === true, JSON.stringify(trExpiry));
check("设完就是余额到期优先", platformPolicy("tokenrhythm") === "expiry_first", platformPolicy("tokenrhythm"));

const trSingle = await setPolicy("tokenrhythm", ContractPolicy.SINGLE);
check("中转站能设回单一", trSingle.ok === true && platformPolicy("tokenrhythm") === "single");

const apiFallback = await setPolicy("qiniu", ContractPolicy.FALLBACK);
check("七牛云能设降级", apiFallback.ok === true, JSON.stringify(apiFallback));
const apiExpiry = await setPolicy("qiniu", ContractPolicy.EXPIRY_FIRST);
check("七牛云不收余额到期优先", apiExpiry.ok === false, JSON.stringify(apiExpiry));
// 文案由 lib/platforms.ts 生成（它列的是策略 id），这里只核对它说了哪些。
check(
  "拒收的话说了这个平台支持哪几个",
  String(apiExpiry.message).includes("single") && String(apiExpiry.message).includes("fallback"),
  String(apiExpiry.message),
);
check("拒收的没写进库", platformPolicy("qiniu") === "fallback", platformPolicy("qiniu"));
await setPolicy("qiniu", ContractPolicy.SINGLE);

// 降级是所有平台都有的选项：逐个平台设一遍，再读回来，再设回单一。
for (const platform of ["qoder", "minimax", "workbuddy-cn", "sensenova", "intern-ai"]) {
  const set = await setPolicy(platform, ContractPolicy.FALLBACK);
  check(`${platform} 收降级`, set.ok === true, JSON.stringify(set));
  check(`${platform} 读回来是 fallback`, platformPolicy(platform) === "fallback", platformPolicy(platform));
  const backToSingle = await setPolicy(platform, ContractPolicy.SINGLE);
  check(
    `${platform} 能设回单一`,
    backToSingle.ok === true && platformPolicy(platform) === "single",
    JSON.stringify(backToSingle),
  );
}

const unspecified = await setPolicy("tokenrhythm", ContractPolicy.UNSPECIFIED);
check("UNSPECIFIED 不收", unspecified.ok === false, JSON.stringify(unspecified));
check(
  "错的话说了只认哪三个",
  ["single", "fallback", "expiry_first"].every((v) => String(unspecified.message).includes(v)),
  String(unspecified.message),
);
const unknown = await setPolicy("tokenrhythm", 7);
check("不认识的数字不收", unknown.ok === false, JSON.stringify(unknown));
check("给错了的没写进库", platformPolicy("tokenrhythm") === "single", platformPolicy("tokenrhythm"));

const noSuch = await setPolicy("no-such-platform", ContractPolicy.SINGLE);
check("没有这个平台就不改", noSuch.ok === false, JSON.stringify(noSuch));

// 只有 tokenrhythm 有余额到期优先，拿它当「不支持」的样本。
const unsupportedText = unsupportedPolicyText("tokenrhythm", "expiry_first", ["single", "fallback"]);
check(
  "拒收的话是中文",
  unsupportedText.includes("tokenrhythm") &&
    unsupportedText.includes("余额到期优先") &&
    unsupportedText.includes("single"),
  unsupportedText,
);

console.log("");
console.log("UpdateProvider 不再碰策略");

// 策略有自己的方法了：改别名与开关不该动到它。
const qoderAccount = addAccount({ platform: "qoder" });
check("账号加得进去", qoderAccount.ok === true && !!qoderAccount.id, JSON.stringify(qoderAccount));
await setPolicy("tokenrhythm", ContractPolicy.FALLBACK);
const aliasOnly = await adminService.updateProvider!(
  create(UpdateProviderRequestSchema, { id: qoderAccount.id!, alias: "Qoder 主账号" }),
);
check("只改别名是改得掉的", aliasOnly.ok === true, JSON.stringify(aliasOnly));
check("只改别名不动平台策略", platformPolicy("tokenrhythm") === "fallback", platformPolicy("tokenrhythm"));
await setPolicy("tokenrhythm", ContractPolicy.SINGLE);

console.log("");
console.log("账号数");

// 账号是 provider 表的行：一个平台加两个账号就是两行。
check("Qoder 现在有一个账号", upstreamAccountCount("qoder") === 1, String(upstreamAccountCount("qoder")));
addAccount({ platform: "qoder", alias: "第二个 Qoder" });
check("加第二个就是两个", upstreamAccountCount("qoder") === 2, String(upstreamAccountCount("qoder")));
check(
  "账号按创建先后排",
  accountsOfPlatform("qoder").map((r) => r.alias).join(",") === "Qoder 主账号,第二个 Qoder",
  accountsOfPlatform("qoder").map((r) => r.alias).join(","),
);
check("没有账号的平台是 0", upstreamAccountCount("zcode") === 0, String(upstreamAccountCount("zcode")));
check("不认识的平台是 0", upstreamAccountCount("no-such-platform") === 0, String(upstreamAccountCount("no-such-platform")));

// 中转站也一样：一个租户一个账号行，凭据挂在账号行上。
const trOne = addAccount({ platform: "tokenrhythm", alias: "中转站一号" });
const trTwo = addAccount({ platform: "tokenrhythm", alias: "中转站二号" });
check("中转站两个账号", upstreamAccountCount("tokenrhythm") === 2, String(upstreamAccountCount("tokenrhythm")));
setSecret(tokenRhythmCredentialSecretId(trOne.id!), "account", {
  account: "one@example.com",
  password: "pw-one",
  apiKey: "sk-tr-one",
});
check(
  "凭据挂在账号行上",
  accountsOfPlatform("tokenrhythm").length === 2 &&
    provider(trOne.id!)?.id === trOne.id &&
    provider(trTwo.id!)?.id === trTwo.id,
  `${trOne.id},${trTwo.id}`,
);

console.log("");
console.log("签到选账号");

// 新加的账号都是开着的。
check("新账号是开着的", provider(trOne.id!)?.enabled === true);

updateProvider(qoderAccount.id!, { enabled: false });
updateProvider("qoder-2", { enabled: false });
check("都关着的时候不签到", benefitUpstreams().length === 0, benefitUpstreams().join(","));

updateProvider(qoderAccount.id!, { enabled: true });
updateProvider("qoder-2", { enabled: true });
let ups = benefitUpstreams();
check(
  "两个 Qoder 账号都签到",
  ups.includes(qoderAccount.id!) && ups.includes("qoder-2"),
  ups.join(","),
);
check("别的种类不签到", !ups.includes("zcode"), ups.join(","));

// 策略是转发的事：签到一个都不许少。
setPlatformPolicy("qoder", "single");
ups = benefitUpstreams();
check("策略不影响签到", ups.includes(qoderAccount.id!) && ups.includes("qoder-2"), ups.join(","));

updateProvider(qoderAccount.id!, { enabled: false });
ups = benefitUpstreams();
check("关掉的账号不签到", !ups.includes(qoderAccount.id!) && ups.includes("qoder-2"), ups.join(","));

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
await runBenefits(["zcode", "qoder-2"], fake);
check(
  "每个账号一次，不认的种类跳过",
  calls.join(",") === "qoder:qoder-2",
  calls.join(","),
);

// 一个账号出错不挡着别的账号：签到是各自的事。
{
  const calls2: string[] = [];
  const broken = {
    minimax: async (id: string) => {
      calls2.push(`minimax:${id}`);
      throw new Error("这个账号的会话坏了");
    },
    qoder: async (id: string) => {
      calls2.push(`qoder:${id}`);
      return outcome(id);
    },
  };
  // 账号号是行给的：第一个 MiniMax Code 账号叫 minimax，没有 -1 后缀。
  const minimaxAccount = addAccount({ platform: "minimax" });
  const minimaxId = minimaxAccount.id!;
  const results2 = await runBenefits([minimaxId, "qoder-2"], broken);
  check("出错的那个也出了结果", results2.length === 2, JSON.stringify(results2.length));
  check(
    "出错的那个说的是失败",
    results2.find((r) => r.upstream === minimaxId)?.ok === false,
    JSON.stringify(results2.find((r) => r.upstream === minimaxId)),
  );
  check(
    "错话里有原因",
    String(results2.find((r) => r.upstream === minimaxId)?.report.join("")).includes("会话坏了"),
    JSON.stringify(results2.find((r) => r.upstream === minimaxId)?.report),
  );
  check("别的账号照样签了", calls2.includes("qoder:qoder-2"), calls2.join(","));
  check("出错的那个也轮到过", calls2.includes(`minimax:${minimaxId}`), calls2.join(","));
}

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
