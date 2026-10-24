// 快照是按 Provider id 存的：按 kind 取会取到 undefined。
import { snapshotEntry } from "../lib/admin/upstreams.ts";

const snapshot: any = {
  minimax: { minimax: { balance: { availableCny: 42 }, tokenPlan: { windows: [1, 2] } } },
  tokenrhythm: { tokenrhythm: { tenants: [{ index: 1, credential: { status: "authenticated" } }] } },
  qoder: { "qoder-cn": { account: { uid: "x" }, credits: { total: 100 } } },
};

const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) process.exitCode = 1;
};

check(
  "按 Provider id 取得到那一份",
  snapshotEntry(snapshot, "minimax", "minimax")?.balance?.availableCny === 42,
  JSON.stringify(snapshotEntry(snapshot, "minimax", "minimax")),
);
check(
  "按 kind 取不到（这是那个 bug）",
  snapshotEntry(snapshot, "minimax", "global") === null,
  JSON.stringify(snapshotEntry(snapshot, "minimax", "global")),
);
check(
  "中转站的租户取得到",
  snapshotEntry(snapshot, "tokenrhythm", "tokenrhythm")?.tenants?.length === 1,
  JSON.stringify(snapshotEntry(snapshot, "tokenrhythm", "tokenrhythm")),
);
check(
  "Qoder 中国区取得到",
  snapshotEntry(snapshot, "qoder", "qoder-cn")?.credits?.total === 100,
  JSON.stringify(snapshotEntry(snapshot, "qoder", "qoder-cn")),
);
check("没有快照就是没有", snapshotEntry(null, "minimax", "minimax") === null);
