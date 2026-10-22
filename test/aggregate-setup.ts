// test/aggregate-setup.ts — put models into the published-models table.
//
//   node --experimental-strip-types test/aggregate-setup.ts <command> [...]
//
// The self-test needs the root route to publish something the upstreams do
// not: a model whose name is the panel's, with two upstreams behind it, so the
// fallback can be tried.

import { saveAggregateModel, deleteAggregateModel, clearAggregateUsage, listAggregateModels } from "../lib/aggregate.ts";

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
  case "list":
    console.log(JSON.stringify(listAggregateModels(), null, 2));
    break;
  default:
    console.error("usage: aggregate-setup.ts save|delete|clear-usage|list ...");
    process.exit(2);
}
