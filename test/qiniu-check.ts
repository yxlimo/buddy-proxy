// test/qiniu-check.ts — 七牛云：门户的资源包怎么读、面板上看到什么、平台登记得对不对。
//
//   node --experimental-strip-types test/qiniu-check.ts
//
// 离线：不问门户，也不问推理端点。回答的形状照门户真的那样，值是编的。

import fs from "node:fs";

const DATA_DIR = "/tmp/opencode/test-qiniu";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const { parseRespackOverview } = await import("../lib/qiniu/quota.ts");
const { kindOf, policiesOfKind } = await import("../lib/provider-kinds.ts");
// 种类登记在注册表里：导入它，种类才都在。
await import("../lib/kinds/index.ts");
const { platformOf } = await import("../lib/platforms.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(name);
}

/* ------------------------------------------------------------------ *
 * 门户的回答（形状照真的那样，值是编的）
 * ------------------------------------------------------------------ */

const OVERVIEW = {
  code: 200,
  message: "success",
  data: {
    records: [
      {
        item_code: "respack-general",
        item_name: "通用资源包",
        zone_name: "华东",
        total_surplus: "10000",
        month_used: "7000",
        month_remain: "3000",
        respack_unit: "k/tokens",
        update_time: 1767225600,
      },
      {
        item_code: "respack-multimodal",
        item_name: "多模态资源包",
        zone_name: "华北",
        total_surplus: "5000",
        month_used: "3000",
        month_remain: "2000",
        respack_unit: "k/tokens",
        update_time: 1767225600,
      },
    ],
  },
};

const PROVIDER = {
  id: "qiniu-test",
  platform: "qiniu",
  kind: "qiniu",
  region: "",
  alias: "七牛云测试账号",
  enabled: true,
  weight: 0,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as any;

/** 一个只带七牛云的快照。别的家是空的。 */
function snapshotWith(quota: unknown): any {
  return {
    qoder: {},
    minimax: {},
    minimaxApi: {},
    zcode: {},
    workbuddy: {},
    tokenrhythm: {},
    sensenova: {},
    internAi: {},
    qiniu: { [PROVIDER.id]: { quota } },
  };
}

/** 快照里那个额度：读出来的那两个包。 */
const QUOTA = { respacks: parseRespackOverview(OVERVIEW), at: Date.now() };

/* ------------------------------------------------------------------ *
 * 门户的回答怎么读
 * ------------------------------------------------------------------ */

section("资源包");

const packs = parseRespackOverview(OVERVIEW);
check("读出两个包", packs.length === 2, String(packs.length));
check(
  "第一个包的名字与地区",
  packs[0]?.itemName === "通用资源包" && packs[0]?.zoneName === "华东",
  `${packs[0]?.itemName} · ${packs[0]?.zoneName}`,
);
check("第一个包的编号", packs[0]?.itemCode === "respack-general", String(packs[0]?.itemCode));
check("第一个包剩 3000", packs[0]?.remaining === 3000, String(packs[0]?.remaining));
check("第二个包剩 2000", packs[1]?.remaining === 2000, String(packs[1]?.remaining));
check("单位是 k/tokens", packs[0]?.unit === "k/tokens", String(packs[0]?.unit));
check("总额是 10000", packs[0]?.total === 10000, String(packs[0]?.total));
check("已用是 7000", packs[0]?.used === 7000, String(packs[0]?.used));
check(
  "更新时刻从秒变成毫秒",
  packs[0]?.updateTime === 1767225600 * 1000,
  String(packs[0]?.updateTime),
);

section("坏数据");

check(
  "门户说不是 200 → 没有包",
  parseRespackOverview({ ...OVERVIEW, code: 500 }).length === 0,
  JSON.stringify(parseRespackOverview({ ...OVERVIEW, code: 500 }).length),
);
check("没有 records → 没有包", parseRespackOverview({ code: 200, data: {} }).length === 0);
check("records 不是数组 → 没有包", parseRespackOverview({ code: 200, data: { records: "x" } }).length === 0);
check("整个回答是空的 → 没有包", parseRespackOverview(null).length === 0);
const dirty = parseRespackOverview({
  code: 200,
  data: { records: [null, 7, { item_code: "x", item_name: "y", month_remain: "10" }] },
});
check("坏行被丢掉，好行留下", dirty.length === 1 && dirty[0]?.remaining === 10, JSON.stringify(dirty));
check(
  "字符串的量转成数字",
  typeof parseRespackOverview(OVERVIEW)[0]?.remaining === "number",
  typeof parseRespackOverview(OVERVIEW)[0]?.remaining,
);

/* ------------------------------------------------------------------ *
 * 面板上看到的额度
 * ------------------------------------------------------------------ */

section("额度");

const kind = kindOf("qiniu");
const views = kind?.quotas(PROVIDER, snapshotWith(QUOTA)) ?? [];
const credits = views[0]?.credits;
check("报一个额度", views.length === 1, String(views.length));
check("两个包报成两条", credits?.lots?.length === 2, String(credits?.lots?.length));
check("剩下的是两个包之和", credits?.remaining === 5000, String(credits?.remaining));
check("总额也是之和", credits?.total === 15000, String(credits?.total));
check("已用也是之和", credits?.used === 10000, String(credits?.used));
check("说明里写着资源包", String(credits?.note ?? "").includes("资源包"), String(credits?.note));
check("说明里写着剩多少", String(credits?.note ?? "").includes("5000"), String(credits?.note));
check(
  "一条 lot 的编号是包与地区",
  credits?.lots?.[0]?.id === "respack-general@华东",
  String(credits?.lots?.[0]?.id),
);
check(
  "一条 lot 的名字带着单位",
  String(credits?.lots?.[0]?.sourceLabel ?? "").includes("k/tokens"),
  String(credits?.lots?.[0]?.sourceLabel),
);
check("资源包没有到期时间", credits?.lots?.[0]?.expiresAt === 0, String(credits?.lots?.[0]?.expiresAt));

section("用尽了吗");

const empty = {
  respacks: parseRespackOverview({
    code: 200,
    data: {
      records: OVERVIEW.data.records.map((row) => ({ ...row, month_remain: "0" })),
    },
  }),
  at: Date.now(),
};
check("两个包都空了 → 用尽", kind?.outOfCredits(PROVIDER, snapshotWith(empty)) === true);
check(
  "还有一个包有剩 → 没用尽",
  kind?.outOfCredits(PROVIDER, snapshotWith(QUOTA)) === false,
);
check(
  "没读到额度（没有 cookie）→ 不知道，不算用尽",
  kind?.outOfCredits(PROVIDER, snapshotWith(null)) === false,
);

/* ------------------------------------------------------------------ *
 * 平台登记
 * ------------------------------------------------------------------ */

section("登记");

check("种类在", kind !== null, String(kind));
check("名字是七牛云", kind?.label === "七牛云", String(kind?.label));
check("登录方式是 api_key", kind?.login === "api_key", String(kind?.login));
check("平台在", platformOf("qiniu") !== null, String(platformOf("qiniu")));
check(
  "收 single 与 fallback",
  policiesOfKind("qiniu").join(",") === "single,fallback",
  policiesOfKind("qiniu").join(","),
);
check(
  "推理地址是七牛云的",
  kind?.baseUrl(PROVIDER) === "https://api.qnaigc.com/v1",
  String(kind?.baseUrl(PROVIDER)),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
