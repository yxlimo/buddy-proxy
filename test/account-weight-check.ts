// test/account-weight-check.ts — 账号的权重，以及删账号要删干净。
//
//   node --experimental-strip-types test/account-weight-check.ts
//
// 离线：只碰自己的数据库，不问任何上游。
//
// 两件事：
//
//   1. 权重：大的先试。降级时按它排先后。
//   2. 删干净：删账号只删它自己那一份，别的账号的凭据不动。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 临时目录走系统的 tmpdir：写死的 /tmp 在 Windows 上落到当前盘的根上，
// 而且两次运行会撞在同一个目录上。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "test-account-weight-"));
process.env.BUDDY_DATA_DIR = DATA_DIR;

const { accountsOfPlatform, addAccount, updateProvider, provider } = await import("../lib/providers.ts");
// 删账号走 admin 层：凭据、旧位置的记录、快照里的那段，都在那边一起删。
const { deleteAccount } = await import("../lib/admin/accounts.ts");
const { selectProvider, byOrder } = await import("../lib/router/provider-selection.ts");
const { setSecret, getSecret, listSecrets } = await import("../lib/store.ts");
const { listCooldowns, setCooldown } = await import("../lib/cooldown.ts");

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

console.log("");
console.log("权重：大的先试");

const first = addAccount({ platform: "qoder", alias: "第一个" });
const second = addAccount({ platform: "qoder", alias: "第二个" });
check("两个账号都建好了", Boolean(first.id && second.id), `${first.id} ${second.id}`);

{
  const rows = accountsOfPlatform("qoder");
  check("新账号排在后面", rows.map((r) => r.id).join(",") === `${first.id},${second.id}`, rows.map((r) => r.id).join(","));
  check(
    "新账号的权重比现有的低",
    rows[1].weight < rows[0].weight,
    `${rows[0].weight} → ${rows[1].weight}`,
  );
}

{
  // 把第二个账号的权重调高：它就该排到前面。
  const changed = updateProvider(second.id!, { alias: second.id!, weight: 999 });
  check("权重改得动", changed.ok, changed.message);
  const rows = accountsOfPlatform("qoder");
  check(
    "权重大的排前面",
    rows.map((r) => r.id).join(",") === `${second.id},${first.id}`,
    rows.map((r) => r.id).join(","),
  );
  check("权重存下来了", provider(second.id!)?.weight === 999, String(provider(second.id!)?.weight));
}

{
  // 降级：权重大的先试，第一个接不了就换第二个。
  const tried: string[] = [];
  const candidates = byOrder(
    accountsOfPlatform("qoder").map((row) => ({
      id: row.id,
      weight: row.weight,
      run: async () => {
        tried.push(row.id);
        if (row.id === second.id) throw new Error("这个账号接不了");
        return "答复";
      },
    })),
  );
  const result = await selectProvider("fallback", candidates, { degradable: () => true });
  check("先试的是权重大的那个", tried[0] === second.id, tried.join(","));
  check("接不了就换下一个", tried.length === 2, tried.join(","));
  check("最后一个接住了", result === "答复", String(result));
}

{
  // 单一：只看权重最大的那个，不换。
  const tried: string[] = [];
  const candidates = byOrder(
    accountsOfPlatform("qoder").map((row) => ({
      id: row.id,
      weight: row.weight,
      run: async () => {
        tried.push(row.id);
        throw new Error("接不了");
      },
    })),
  );
  await selectProvider("single", candidates, { degradable: () => true }).catch(() => {});
  check("单一不换人", tried.length === 1 && tried[0] === second.id, tried.join(","));
}

console.log("");
console.log("账号 id 是独立的自增数");

{
  // 同一平台连加两个：id 是 1、2 这样的自增数，跟平台 id 没有字面关系。
  const one = addAccount({ platform: "qoder-cn", alias: "甲" });
  const two = addAccount({ platform: "qoder-cn", alias: "乙" });
  check("两个账号的 id 不同", Boolean(one.id && two.id) && one.id !== two.id, `${one.id} ${two.id}`);
  check("id 是自增整数", [one.id!, two.id!].every((id) => /^\d+$/.test(id)), `${one.id} ${two.id}`);
  check(
    "id 里没有平台的名字",
    [one.id!, two.id!].every((id) => !id.includes("qoder")),
    `${one.id} ${two.id}`,
  );
  check(
    "两个账号都挂在同一个平台上",
    provider(one.id!)?.platform === "qoder-cn" && provider(two.id!)?.platform === "qoder-cn",
    `${provider(one.id!)?.platform} ${provider(two.id!)?.platform}`,
  );
  check(
    "后加的那个号比前面的大",
    Number(two.id!) > Number(one.id!),
    `${one.id} → ${two.id}`,
  );
  check(
    "账号 id 不长成平台 id 的样子",
    [one.id!, two.id!].every((id) => id !== "qoder-cn"),
    `${one.id} ${two.id}`,
  );
}

console.log("");
console.log("删账号只删它自己那一份");

{
  const one = addAccount({ platform: "tokenrhythm", alias: "租户 1" });
  const two = addAccount({ platform: "tokenrhythm", alias: "租户 2" });
  check("两个账号建出来了", Boolean(one.id && two.id) && one.id !== two.id, `${one.id} ${two.id}`);
  setSecret(`key:provider:${one.id}:account`, "account", { account: "acct-one", password: "pw", apiKey: "sk_tr_one" });
  setSecret(`key:provider:${two.id}:account`, "account", { account: "acct-two", password: "pw", apiKey: "sk_tr_two" });

  const result = deleteAccount(two.id!);
  check("删掉了", result.ok, result.message);
  check("账号行没了", provider(two.id!) === null);
  check("它自己的凭据没了", getSecret(`key:provider:${two.id}:account`) === null);
  check(
    "另一个账号的凭据还在，没被连坐",
    (getSecret<any>(`key:provider:${one.id}:account`)?.account ?? "") === "acct-one",
    JSON.stringify(getSecret(`key:provider:${one.id}:account`)),
  );
  check(
    "删号没有留下别的记录",
    listSecrets(`key:provider:${two.id}`).length === 0 && getSecret(`session:provider:${two.id}`) === null,
    JSON.stringify(listSecrets(`key:provider:${two.id}`).map((s) => s.id)),
  );
  deleteAccount(one.id!);
}

console.log("");
console.log("删账号要把冷却也删掉");

{
  // 冷却按账号 id 认人。账号删了这一行就是孤儿 —— 指着一个不存在的账号的额度，
  // 以后的统计与面板都要按 id 扫到它。
  const made = addAccount({ platform: "qoder", alias: "冷却过的账号" });
  const id = made.id!;
  setCooldown(id, Date.now() + 10 * 60_000, "quota");
  check(
    "冷却写进去了",
    listCooldowns().some((row) => row.providerId === id),
    JSON.stringify(listCooldowns().map((row) => row.providerId)),
  );

  const result = deleteAccount(id);
  check("账号删掉了", result.ok, result.message);
  check(
    "冷却也没了",
    !listCooldowns().some((row) => row.providerId === id),
    JSON.stringify(listCooldowns().map((row) => row.providerId)),
  );
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
