import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNudgeCommand,
  nextRecoveryAt,
  newestPiSession,
  parseHealth,
  parseOpencodeSessions,
  sessionIdOf,
  type AccountQuota,
} from "../tools/wait-nudge.ts";

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

const MINUTE = 60_000;
const T = Date.parse("2026-10-26T12:00:00.000Z");

// A /health payload as the gateway reports it: the MiniMax accounts carry the
// plan windows in their snapshot, the video window next to the general one.
const HEALTH = {
  upstreams: {
    minimax: {
      accounts: [
        {
          id: "minimax-a",
          outOfCredits: false,
          snapshot: {
            tokenPlan: {
              windows: [
                {
                  model: "video",
                  intervalPercent: 90,
                  weeklyPercent: 90,
                  intervalEndsAt: "2026-10-26T12:00:00.000Z",
                },
                {
                  model: "general",
                  intervalPercent: 34,
                  weeklyPercent: 60,
                  intervalEndsAt: "2026-10-26T12:00:00.000Z",
                },
              ],
            },
          },
        },
        {
          id: "minimax-b",
          outOfCredits: true,
          cooldown: { untilMs: Date.parse("2026-10-26T11:30:00.000Z") },
          snapshot: {
            tokenPlan: {
              windows: [
                {
                  model: "general",
                  intervalPercent: 0,
                  weeklyPercent: 12,
                  intervalEndsAt: "2026-10-26T13:00:00.000Z",
                },
              ],
            },
          },
        },
      ],
    },
  },
};

function account(patch: Partial<AccountQuota>): AccountQuota {
  return {
    id: "minimax-a",
    intervalPercent: 0,
    weeklyPercent: 0,
    intervalEndsAt: 0,
    cooldownUntilMs: 0,
    outOfCredits: false,
    ...patch,
  };
}

check("parseHealth 取出 minimax 的账号", () => {
  const accounts = parseHealth(HEALTH);
  assert.equal(accounts.length, 2);

  const first = accounts[0];
  assert.ok(first);
  assert.equal(first.id, "minimax-a");
  assert.equal(first.outOfCredits, false);
  assert.equal(first.cooldownUntilMs, 0);

  const second = accounts[1];
  assert.ok(second);
  assert.equal(second.id, "minimax-b");
  assert.equal(second.outOfCredits, true);
  assert.equal(second.cooldownUntilMs, Date.parse("2026-10-26T11:30:00.000Z"));
});

check("parseHealth 取的是 general 窗口，video 窗口不算", () => {
  const first = parseHealth(HEALTH)[0];
  assert.ok(first);
  assert.equal(first.intervalPercent, 34);
  assert.equal(first.weeklyPercent, 60);
  assert.equal(first.intervalEndsAt, T);
});

check("parseHealth 缺 tokenPlan 的账号给安全默认", () => {
  const accounts = parseHealth({
    upstreams: { minimax: { accounts: [{ id: "minimax-c" }] } },
  });
  assert.equal(accounts.length, 1);
  const only = accounts[0];
  assert.ok(only);
  assert.equal(only.intervalPercent, 0);
  assert.equal(only.weeklyPercent, 0);
  assert.equal(only.intervalEndsAt, 0);
  assert.equal(only.cooldownUntilMs, 0);
  assert.equal(only.outOfCredits, false);
});

check("nextRecoveryAt 有窗口额度就能用", () => {
  const plan = nextRecoveryAt(
    [account({ intervalPercent: 34, intervalEndsAt: T + 10 * MINUTE })],
    T,
    MINUTE,
  );
  assert.equal(plan.usable, true);
  assert.equal(plan.at, T);
});

check("nextRecoveryAt 取最早恢复的那个账号，再加 grace", () => {
  const plan = nextRecoveryAt(
    [
      account({ id: "minimax-a", intervalEndsAt: T + 40 * MINUTE }),
      account({ id: "minimax-b", intervalEndsAt: T + 10 * MINUTE }),
    ],
    T,
    MINUTE,
  );
  assert.equal(plan.usable, false);
  assert.equal(plan.at, T + 10 * MINUTE + MINUTE);
});

check("nextRecoveryAt outOfCredits 的账号不算可用", () => {
  const plan = nextRecoveryAt(
    [account({ intervalPercent: 34, outOfCredits: true, intervalEndsAt: T + 10 * MINUTE })],
    T,
    MINUTE,
  );
  assert.equal(plan.usable, false);
  assert.equal(plan.at, T + 10 * MINUTE + MINUTE);
});

check("nextRecoveryAt 冷却和窗口取更晚的那个", () => {
  const plan = nextRecoveryAt(
    [
      account({
        intervalPercent: 34,
        cooldownUntilMs: T + 5 * MINUTE,
        intervalEndsAt: T + 10 * MINUTE,
      }),
    ],
    T,
    MINUTE,
  );
  assert.equal(plan.usable, false);
  assert.equal(plan.at, T + 10 * MINUTE + MINUTE);
});

check("nextRecoveryAt 算不出时间就报错", () => {
  assert.throws(() =>
    nextRecoveryAt(
      [account({ outOfCredits: true }), account({ id: "minimax-b", outOfCredits: true })],
      T,
      MINUTE,
    ),
  );
});

check("newestPiSession 取 mtime 最新的那个会话", () => {
  const root = mkdtempSync(join(tmpdir(), "wait-nudge-"));
  try {
    const dir = join(root, "--tmp-xxx--");
    const older = "2026-10-26T11-59-43-440Z_01a17814-1111-2222-3333-444455556666";
    const newer = "2026-10-26T13-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000";
    mkdirSync(join(dir, older), { recursive: true });
    mkdirSync(join(dir, newer), { recursive: true });
    writeFileSync(join(dir, older, "session.jsonl"), "{}\n");
    writeFileSync(join(dir, newer, "session.jsonl"), "{}\n");
    utimesSync(join(dir, older), T / 1000, T / 1000);
    utimesSync(join(dir, newer), (T + 60 * MINUTE) / 1000, (T + 60 * MINUTE) / 1000);

    const found = newestPiSession(root, "/tmp/xxx");
    assert.ok(found);
    assert.equal(found.id, "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000");
    assert.equal(found.file, join(dir, newer, "session.jsonl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("newestPiSession 没有会话就返回 null", () => {
  const root = mkdtempSync(join(tmpdir(), "wait-nudge-"));
  try {
    assert.equal(newestPiSession(root, "/tmp/nothing-here"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("newestPiSession 认得旁边的 .jsonl（pi 的真布局）", () => {
  const root = mkdtempSync(join(tmpdir(), "wait-nudge-"));
  try {
    const dir = join(root, "--tmp-yyy--");
    const older = "2026-10-25T03-11-10-425Z_01a1710a-6a58-710f-ab3c-409049422b4f";
    const newer = "2026-10-26T11-59-43-440Z_01a17814-ad50-775e-8c08-6ff8df765b64";
    mkdirSync(join(dir, older), { recursive: true });
    mkdirSync(join(dir, newer), { recursive: true });
    writeFileSync(join(dir, `${older}.jsonl`), "{}\n");
    writeFileSync(join(dir, `${newer}.jsonl`), "{}\n");
    utimesSync(join(dir, older), T / 1000, T / 1000);
    utimesSync(join(dir, newer), (T + 60 * MINUTE) / 1000, (T + 60 * MINUTE) / 1000);

    const found = newestPiSession(root, "/tmp/yyy");
    assert.ok(found);
    assert.equal(found.id, "01a17814-ad50-775e-8c08-6ff8df765b64");
    assert.equal(found.file, join(dir, `${newer}.jsonl`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("newestPiSession 只有 .jsonl 的会话也认", () => {
  const root = mkdtempSync(join(tmpdir(), "wait-nudge-"));
  try {
    const dir = join(root, "--tmp-zzz--");
    const name = "2026-10-26T11-58-53-233Z_01a17813-e930-7241-b8d2-4c5272079c84";
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.jsonl`), "{}\n");

    const found = newestPiSession(root, "/tmp/zzz");
    assert.ok(found);
    assert.equal(found.id, "01a17813-e930-7241-b8d2-4c5272079c84");
    assert.equal(found.file, join(dir, `${name}.jsonl`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("sessionIdOf 对 UUID 名字仍取 UUID", () => {
  assert.equal(
    sessionIdOf("2026-10-26T11-59-43-440Z_01a17814-1111-2222-3333-444455556666"),
    "01a17814-1111-2222-3333-444455556666",
  );
  assert.equal(sessionIdOf("01a17814-ad50-775e-8c08-6ff8df765b64"), "01a17814-ad50-775e-8c08-6ff8df765b64");
});

check("sessionIdOf 对非 UUID 的会话名取最后一个下划线之后那段", () => {
  assert.equal(sessionIdOf("2026-10-29T03-58-17-343Z_nudge-test-1"), "nudge-test-1");
  assert.equal(sessionIdOf("2026-10-29T03-58-17-343Z_nudge-test-1.jsonl".slice(0, -".jsonl".length)), "nudge-test-1");
});

check("newestPiSession 认得非 UUID 名字的会话", () => {
  const root = mkdtempSync(join(tmpdir(), "wait-nudge-"));
  try {
    const dir = join(root, "--tmp-x--");
    const name = "2026-10-29T03-58-17-343Z_nudge-test-1";
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.jsonl`), "{}\n");

    const found = newestPiSession(root, "/tmp/x");
    assert.ok(found);
    assert.equal(found.id, "nudge-test-1");
    assert.equal(found.file, join(dir, `${name}.jsonl`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("newestPiSession 目录形态和浮文件形态混在一起时仍优先目录形态", () => {
  const root = mkdtempSync(join(tmpdir(), "wait-nudge-"));
  try {
    const dir = join(root, "--tmp-mixed--");
    const older = "2026-10-29T03-58-17-343Z_folder-old";
    const newer = "2026-10-29T04-58-17-343Z_folder-new";
    const floating = "2026-10-29T05-58-17-343Z_floating-file";
    mkdirSync(join(dir, older), { recursive: true });
    mkdirSync(join(dir, newer), { recursive: true });
    writeFileSync(join(dir, older, "session.jsonl"), "{}\n");
    writeFileSync(join(dir, newer, "session.jsonl"), "{}\n");
    writeFileSync(join(dir, `${floating}.jsonl`), "{}\n");
    utimesSync(join(dir, older), T / 1000, T / 1000);
    utimesSync(join(dir, newer), (T + 60 * MINUTE) / 1000, (T + 60 * MINUTE) / 1000);
    utimesSync(join(dir, `${floating}.jsonl`), (T + 120 * MINUTE) / 1000, (T + 120 * MINUTE) / 1000);

    const found = newestPiSession(root, "/tmp/mixed");
    assert.ok(found);
    assert.equal(found.id, "folder-new");
    assert.equal(found.file, join(dir, newer, "session.jsonl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("parseOpencodeSessions 取第一条", () => {
  const sessions = parseOpencodeSessions([
    { id: "ses_01", title: "第一个", time: { updated: 1_764_000_000_000 } },
    { id: "ses_02", title: "第二个", updatedAt: 1_764_000_001_000 },
  ]);
  assert.equal(sessions.length, 2);
  const first = sessions[0];
  assert.ok(first);
  assert.equal(first.id, "ses_01");
  assert.equal(first.title, "第一个");
  assert.equal(first.updatedAt, 1_764_000_000_000);
});

check("parseOpencodeSessions 也认 { sessions: [...] }", () => {
  const sessions = parseOpencodeSessions({ sessions: [{ id: "ses_09", title: "九个" }] });
  assert.equal(sessions.length, 1);
  const first = sessions[0];
  assert.ok(first);
  assert.equal(first.id, "ses_09");
});

check("buildNudgeCommand 的形状", () => {
  const pi = buildNudgeCommand("pi", "ses-1", "继续");
  assert.equal(pi.cmd, "pi");
  assert.deepEqual(pi.args, ["-p", "--session", "ses-1", "--", "继续"]);
  assert.equal([pi.cmd, ...pi.args].join(" "), "pi -p --session ses-1 -- 继续");

  const opencode = buildNudgeCommand("opencode", "ses-2", "继续");
  assert.equal(opencode.cmd, "opencode");
  assert.deepEqual(opencode.args, ["run", "-s", "ses-2", "--prompt", "继续"]);
  assert.equal([opencode.cmd, ...opencode.args].join(" "), "opencode run -s ses-2 --prompt 继续");
});

if (failures > 0) {
  console.error(`wait-nudge: ${failures} 项没过`);
  process.exit(1);
}
console.log("wait-nudge: 全过");
