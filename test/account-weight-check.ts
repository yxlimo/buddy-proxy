// test/account-weight-check.ts — 账号的权重，以及删账号要删干净。
//
//   node --experimental-strip-types test/account-weight-check.ts
//
// 离线：只碰自己的数据库，不问任何上游。
//
// 两件事：
//
//   1. 权重：大的先试。降级时按它排先后。
//   2. 删干净：删账号要把旧位置的记录一起删。留着它们，启动时的归位会把
//      账号带回来 —— 删了又活，凭据还串着。

import fs from "node:fs";

const DATA_DIR = "/tmp/opencode/test-account-weight";
process.env.BUDDY_DATA_DIR = DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const { accountsOfPlatform, addAccount, updateProvider, provider } = await import("../lib/providers.ts");
// 删账号走 admin 层：凭据、旧位置的记录、快照里的那段，都在那边一起删。
const { deleteAccount } = await import("../lib/admin/accounts.ts");
const { selectProvider, byOrder } = await import("../lib/router/provider-selection.ts");
const { setSecret, getSecret, listSecrets } = await import("../lib/store.ts");

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
console.log("删账号要删干净");

{
  // 旧库把租户的凭据按租户号存着。删账号时这些也要删。
  setSecret("account:tokenrhythm:2", "account", { account: "18945877841", password: "pw", apiKey: "sk_tr_old" });
  setSecret("session:tokenrhythm:2", "session", { accountId: "tokenrhythm-2", cookie: "tr_session=old" });
  setSecret("key:provider:tokenrhythm:tenant-2", "key", { key: "sk_tr_old" });

  // 先建第一个，第二个才是 tokenrhythm-2 —— 旧租户 2 留下的记录就是这个号。
  addAccount({ platform: "tokenrhythm", alias: "租户 1" });
  const made = addAccount({ platform: "tokenrhythm", alias: "租户 2" });
  const id = made.id!;
  check("账号建出来了", id === "tokenrhythm-2", id);

  const result = deleteAccount(id);
  check("删掉了", result.ok, result.message);
  check("账号行没了", provider(id) === null);
  check("旧位置的凭据没了", getSecret("account:tokenrhythm:2") === null);
  check("旧位置的登录态没了", getSecret("session:tokenrhythm:2") === null);
  check("旧位置的 key 没了", getSecret("key:provider:tokenrhythm:tenant-2") === null);
  check(
    "新位置的凭据也没了",
    listSecrets("key:provider:tokenrhythm-2").length === 0,
    JSON.stringify(listSecrets("key:provider:tokenrhythm-2").map((s) => s.id)),
  );
}

console.log("");
console.log("删过的账号不会被旧记录带回来");

{
  // 归位（启动时的动作）看到旧记录就把账号带回来。删干净的账号不该这样。
  addAccount({ platform: "tokenrhythm", alias: "租户 1" });
  addAccount({ platform: "tokenrhythm", alias: "租户 2" });
  const made = addAccount({ platform: "tokenrhythm", alias: "租户 3" });
  const id = made.id!;
  // 旧位置有一条它的记录：旧库按租户号存，那一号就是它自己名字里的那个号。
  const index = Number(id.split("-")[1] ?? 1);
  const legacyId = `account:tokenrhythm:${index}`;
  setSecret(legacyId, "account", { account: "18252587721", password: "pw", apiKey: "sk_tr_3" });
  deleteAccount(id);
  check("删干净了", provider(id) === null && getSecret(legacyId) === null, legacyId);

  // 再跑一次归位：库已经是新形状，归位不该建出任何行。
  const { store } = await import("../lib/store.ts");
  const db = store();
  const rows = db
    .prepare("SELECT id FROM provider WHERE platform = ? AND id = ?")
    .all("tokenrhythm", id) as { id?: string }[];
  check("归位没有把它带回来", rows.length === 0, JSON.stringify(rows.map((r) => r.id)));
  check("它的新凭据也是空的", listSecrets(`key:provider:${id}`).length === 0);
}

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
