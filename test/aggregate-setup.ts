// test/aggregate-setup.ts — put models into the published-models table.
//
//   node --experimental-strip-types test/aggregate-setup.ts <command> [...]
//
// The self-test needs the root route to publish something the upstreams do
// not: a model whose name is the panel's, with two upstreams behind it, so the
// fallback can be tried.
//
// The `seed` command puts the sessions of the two upstreams the test needs
// into the test's own database. The mock upstream does not look at the
// credential, but the router does: without a session there is nothing to send.
// The sessions used to come from the machine's own files (~/.qoder-proxy and
// friends), which is why the test broke on a machine that had none.

import { saveAggregateModel, deleteAggregateModel, clearAggregateUsage, listAggregateModels } from "../lib/aggregate.ts";
import { setSecret } from "../lib/store.ts";

const [, , command, ...rest] = process.argv;

switch (command) {
  case "save":
    // save <id> <display> <strategy> <group:model> [<group:model> ...]
    saveAggregateModel({
      id: rest[0],
      displayName: rest[1],
      strategy: (rest[2] as "single" | "fallback") ?? "single",
      targets: rest.slice(3).map((spec, index) => {
        const [group, upstreamModel] = spec.split(":");
        return { group, upstreamModel, position: index, enabled: true };
      }),
    });
    console.log(`saved ${rest[0]} with ${rest.length - 3} targets`);
    break;
  case "delete":
    deleteAggregateModel(rest[0]);
    console.log(`deleted ${rest[0]}`);
    break;
  case "clear-usage":
    clearAggregateUsage();
    console.log("cleared the traffic");
    break;
  case "seed": {
    // The two sessions the test's requests need. The mock does not check the
    // token; the router does need one to send a request at all.
    const now = Date.now();
    setSecret("session:qoder:global", "session", {
      schemaVersion: 1,
      region: "global",
      clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
      accessToken: "dt-test-token",
      refreshToken: "drt-test-token",
      userId: "test-user",
      expiresAtMs: now + 365 * 24 * 3600 * 1000,
      refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
      machineId: "test-machine",
      machineToken: "test-machine-token",
      machineType: "test",
      generation: 1,
      loginAtMs: now,
      refreshedAtMs: now,
    });
    setSecret("session:workbuddy:cn", "session", {
      accessToken: "wb-test-token",
      refreshToken: "wb-test-refresh",
      uid: "test-user",
      nickname: "tester",
      domain: "127.0.0.1",
      region: "cn",
      generation: 1,
      expiresAtMs: now + 365 * 24 * 3600 * 1000,
      refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
      loginAtMs: now,
      refreshedAtMs: now,
    });
    console.log("seeded the qoder and workbuddy sessions");
    break;
  }
  case "list":
    console.log(JSON.stringify(listAggregateModels(), null, 2));
    break;
  default:
    console.error("usage: aggregate-setup.ts save|delete|clear-usage|seed|list ...");
    process.exit(2);
}
