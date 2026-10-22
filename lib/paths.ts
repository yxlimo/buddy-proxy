// lib/paths.ts — where the service keeps its things.
//
// One directory, one environment variable:
//
//   BUDDY_DATA_DIR=/data
//
// In there:
//   buddy.db        the database: the credentials, the settings, the cache
//   auth.log        the credential log
//   identity.salt   the salt the device fingerprint is derived from
//   *.json          the session files the service used to keep, read once
//
// The directory has to survive a container rebuild: the refresh tokens rotate
// on every refresh, so losing it means logging in again. It is the volume.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvValue } from "./env.ts";

/**
 * The directory everything lives in.
 *
 * The environment wins; then the mounted volume, which is what a container
 * gets; then the home directory, for a machine that runs the service itself.
 */
export function dataDir(): string {
  const explicit = readEnvValue("BUDDY_DATA_DIR") || "";
  if (explicit) return explicit;
  if (fs.existsSync("/data")) return "/data";
  return path.join(os.homedir(), ".buddy-proxy");
}

/** The database file. */
export function dbPath(): string {
  return path.join(dataDir(), "buddy.db");
}

/** A file in the data directory. */
export function dataFile(name: string): string {
  return path.join(dataDir(), name);
}

/**
 * The directories the session files used to live in.
 *
 * The service reads them once, when it moves a session into the database, so
 * that nobody has to log in again because the files moved. A machine that ran
 * an older version still has them there.
 */
export function legacyDirs(): string[] {
  const home = os.homedir();
  return [".minimax-proxy", ".qoder-proxy", ".workbuddy-proxy", ".tokenrhythm-proxy"].map((d) =>
    path.join(home, d),
  );
}
