#!/usr/bin/env node
// scripts/qoder-login.ts — one-time login for the proxy's own Qoder session.
//
// Run once, on the host or inside the container. It prints an authorization URL;
// you approve it in a browser, the script polls, and the credential is written to
// the data dir. Every later refresh is done by the proxy itself, so this is the
// only step that needs a human.
//
//   node scripts/qoder-login.ts --region global   device flow login (qoder.com)
//   node scripts/qoder-login.ts --region cn       device flow login (qoder.cn)
//   node scripts/qoder-login.ts --status           show the stored sessions
//
// In a container: docker compose exec router node scripts/qoder-login.ts --region global

import { login, qoderStatus, sessionPath, type QoderRegion } from "../lib/qoder-auth.ts";
import { ENDPOINTS } from "../lib/qoder-auth.ts";

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function region(): QoderRegion {
  const raw = (argValue("--region") ?? process.env.QODER_REGION ?? "global").toLowerCase();
  return raw === "cn" ? "cn" : "global";
}

async function main(): Promise<void> {
  if (args.includes("--status")) {
    console.log(JSON.stringify({ cn: qoderStatus("cn"), global: qoderStatus("global") }, null, 2));
    return;
  }
  if (args.includes("--logout")) {
    const fs = await import("node:fs");
    const file = sessionPath(region());
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
    console.log(`removed ${file}`);
    return;
  }
  const r = region();
  console.log(`region ${r}: site ${ENDPOINTS[r].site}, openapi ${ENDPOINTS[r].openapi}`);
  await login(r);
}

main().catch((e: Error & { hint?: string }) => {
  console.error(`login failed: ${e.message}`);
  if (e.hint) console.error(e.hint);
  process.exit(1);
});
