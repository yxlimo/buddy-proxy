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

const { configString, configFlag, configNumber, configOverride, configClear, configOverrides, configSnapshot } =
  await import("../lib/config.ts");

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

// The environment wins over the database: what the deployment pins, the
// deployment decides.
configOverride("CHECK_FLAG", "false");
check("flag still from the environment", configFlag("CHECK_FLAG", true), true);

// But the panel's value is not thrown away by it: it waits in the database.
check(
  "the panel's value is kept",
  configOverrides().find((o) => o.key === "CHECK_FLAG")?.value,
  "false",
);

// A setting the environment does not pin is the database's.
configOverride("CHECK_NUMBER", "42");
check("number from the database", configNumber("CHECK_NUMBER", 7), 42);

// A value that makes no sense falls back rather than break the service.
configOverride("CHECK_NUMBER", "not-a-number");
check("unusable number falls back", configNumber("CHECK_NUMBER", 7), 7);

// And clearing hands the setting back to the environment.
configClear("CHECK_FLAG");
check("flag back from the environment", configFlag("CHECK_FLAG", false), true);
check(
  "the panel's value is gone",
  configOverrides().find((o) => o.key === "CHECK_FLAG"),
  undefined,
);

// The snapshot knows where every value came from, which is what the panel and
// the startup log show.
console.log("");
console.log("面板看到的是生效的那份，挡着的另放一份");

{
  // 面板只公布那几个设置，这里用其中一个（REQUIRE_API_KEY）做例子。
  // 环境变量钉住它，面板写的那份在库里等着。
  process.env.REQUIRE_API_KEY = "true";
  configFlag("REQUIRE_API_KEY", false);
  configOverride("REQUIRE_API_KEY", "false");

  const { configItems } = await import("../lib/admin/config.ts");
  const item = configItems().find((i) => i.key === "REQUIRE_API_KEY");
  check("面板看到的是环境变量的值", item?.value, "true");
  check("来源是环境变量", item?.source, "environment");
  check("面板写的那份也在", item?.overrideValue, "false");

  // 先把环境变量撤了，再清：撤了之后它才让位给库里那份。
  delete process.env.REQUIRE_API_KEY;
  configClear("REQUIRE_API_KEY");
  const after = configItems().find((i) => i.key === "REQUIRE_API_KEY");
  check("环境变量撤了，回到默认值", after?.source, "default");
  check("库里那份也清掉了", after?.overrideValue, "");
}

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

// Close the database before removing its directory. On Windows an open file
// cannot be deleted — the removal fails with EPERM — so the handle has to go
// first. On Linux it makes no difference.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
console.log(`\nconfig checks: ${passed} passed`);
