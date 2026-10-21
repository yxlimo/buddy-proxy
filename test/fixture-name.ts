// test/fixture-name.ts — how a fixture is named.
//
// The recorder, the mock server and the capture script have to agree on it, so
// it lives in one place.

import fs from "node:fs";
import path from "node:path";

export const FIXTURE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");

/** A name for the fixture: the method, the whole path and the variant. */
export function fixtureName(method: string, route: string, variant: string): string {
  const slug = route.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
  return `${method.toLowerCase()}-${slug}${variant === "all" ? "" : `-${variant}`}.json`;
}

/**
 * Which variant of the answer a request wants.
 *
 * The same path serves a streaming and a non-streaming request, and the two
 * answers have different shapes — so they cannot share a fixture. A request
 * that carries tools gets its own fixture as well: the answer is a tool call
 * rather than an answer.
 */
export function variantOf(body: Buffer | string): string {
  try {
    const parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
    if (parsed && typeof parsed === "object") {
      const tools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const stream = typeof parsed.stream === "boolean" ? (parsed.stream ? "stream" : "nostream") : "all";
      return tools ? `${stream}-tools` : stream;
    }
  } catch {
    /* not JSON — the legacy protocol sends its own encoded body */
  }
  return "all";
}

export interface Fixture {
  upstream: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function writeFixture(name: string, fixture: Fixture): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, name), JSON.stringify(fixture, null, 2) + "\n");
}

export function readFixture(name: string): Fixture | null {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
  } catch {
    return null;
  }
}
