#!/usr/bin/env node
// scripts/minimax-login.ts — one-time login for the proxy's own MiniMax Code session.
//
// Run once, on the host or inside the container. It prints an authorization URL and a
// user code; you approve in a browser, the script polls, and the credential is written
// to the data dir. Every later refresh is done by the proxy itself, so this is the only
// step that needs a human.
//
//   node scripts/minimax-login.ts           device flow login
//   node scripts/minimax-login.ts --status  show the stored session
//   node scripts/minimax-login.ts --logout  revoke the refresh token and delete the file
//
// In a container: docker compose exec minimax-proxy node scripts/minimax-login.ts

import { login, oauthStatus, revoke, sessionPath } from "../lib/minimax-oauth.ts";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  if (args.includes("--status")) {
    console.log(JSON.stringify(oauthStatus(), null, 2));
    return;
  }
  if (args.includes("--logout")) {
    await revoke();
    console.log(`revoked and removed ${sessionPath()}`);
    return;
  }
  await login();
}

main().catch((e: Error & { hint?: string }) => {
  console.error(`login failed: ${e.message}`);
  if (e.hint) console.error(e.hint);
  process.exit(1);
});
