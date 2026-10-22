// test/config-check.ts — the settings layer, checked on its own.
//
// The settings come from three places: the database, the environment and the
// default in the code. This checks the order of them, because a service that
// reads the wrong one changes its behaviour without saying anything.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "buddy-config-")), "data");
process.env.BUDDY_DATA_DIR = dbFile;

// The environment answers two of them, so the order can be seen.
process.env.CHECK_FLAG = "true";
process.env.CHECK_STRING = "from-env";

const { configString, configFlag, configNumber, configOverride, configClear, configSnapshot } = await import(
  "../lib/config.ts"
);

let passed = 0;
function check(name: string, got: unknown, want: unknown): void {
  try {
    assert.deepEqual(got, want);
    passed++;
    console.log(`  ok   ${name}`);
  } catch {
    console.log(`  FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exitCode = 1;
  }
}

// The environment is used when the database says nothing.
check("flag from the environment", configFlag("CHECK_FLAG", false), true);
check("string from the environment", configString("CHECK_STRING", "fallback"), "from-env");
check("number from the default", configNumber("CHECK_NUMBER", 7), 7);

// The database wins over the environment.
configOverride("CHECK_FLAG", "false");
check("flag from the database", configFlag("CHECK_FLAG", true), false);

configOverride("CHECK_NUMBER", "42");
check("number from the database", configNumber("CHECK_NUMBER", 7), 42);

// A value that makes no sense falls back rather than break the service.
configOverride("CHECK_NUMBER", "not-a-number");
check("unusable number falls back", configNumber("CHECK_NUMBER", 7), 7);

// And clearing hands the setting back to the environment.
configClear("CHECK_FLAG");
check("flag back from the environment", configFlag("CHECK_FLAG", false), true);

// The snapshot knows where every value came from, which is what the panel and
// the startup log show.
const snapshot = configSnapshot();
check("the snapshot has the settings", snapshot.length >= 3, true);
check(
  "the snapshot knows the source",
  snapshot.find((s) => s.key === "CHECK_STRING")?.source,
  "environment",
);
check(
  "the settings are grouped",
  snapshot.find((s) => s.key === "CHECK_STRING")?.group,
  "general",
);

fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
console.log(`\nconfig checks: ${passed} passed`);
