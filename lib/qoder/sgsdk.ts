// lib/qoder/sgsdk.ts — the machine identity the official Qoder client carries.
//
// The official client (both @qoder-ai/qodercli and @qodercn-ai/qoderclicn)
// embeds Alibaba's sgsdk native component — the file the bundle calls
// "runtime-info" — and asks it for a machine identity before it talks to the
// activity service. The identity is an encrypted blob: 66 bytes whose first
// three bytes are 3f 58 00, handed over as 88 base64url characters.
//
// It belongs to the machine, not to the account. On Linux the component never
// sees the account (the CLI only passes it on macOS and Windows), and the same
// blob comes back for every account and for every environment.
//
// The blob is bound to a seed file, ~/.config/.locale_cfg. The path comes from
// the passwd entry of the user that runs the process — not from $HOME — so a
// container has to hand the process a home that survives a rebuild, or the
// identity changes and the old one cannot be brought back.
//
// The binary is not kept in the repository: it is taken out of the npm package
// and put next to the data. `extractSgsdkBinary` does that, `machineIdentity`
// runs it.
//
// Not wired into the gateway: the activity path decides for itself what to
// send. See docs/qoder/sgsdk.md for what the measurements say.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvValue } from "../env.ts";
import { dataDir } from "../paths.ts";

/**
 * The environments the component knows about.
 *
 * The number is the only thing the CLI passes it on Linux: `runtime-info 0`
 * for the online environment. The numbers come out of the simulated client's own enum
 * (ONLINE 0, PRE 1, DAILY 2, US_ONLINE 3, SINGAPORE 4, KOREA 5).
 */
export type SgsdkEnvironment = "ONLINE" | "PRE" | "DAILY" | "US_ONLINE" | "SINGAPORE" | "KOREA";

export const SGSDK_ENVIRONMENT_IDS: Record<SgsdkEnvironment, number> = {
  ONLINE: 0,
  PRE: 1,
  DAILY: 2,
  US_ONLINE: 3,
  SINGAPORE: 4,
  KOREA: 5,
};

/** What the component hands back. */
export interface SgsdkMachineInfo {
  /** 88 base64url characters — an encrypted blob of 66 bytes, first three `3f 58 00`. */
  machineToken: string;
  /** 18 hex characters. */
  machineType: string;
  /** 18 hex characters. */
  machineCode: string;
  /** What the component thinks it is running on. */
  vmInfo?: Record<string, unknown>;
}

/** The machine identity as a whole: the blob plus the id the simulated client keeps beside it. */
export interface SgsdkMachineIdentity extends SgsdkMachineInfo {
  /** A uuid for this machine. The client keeps one per install. */
  machineId: string;
}

export interface SgsdkStatus {
  available: boolean;
  /** `linux-x64` and the like. */
  platform: string;
  /** Where the component was found. */
  binary?: string;
  /** The seed file that holds the identity. */
  seed?: string;
  seedExists: boolean;
  reason?: string;
  hint?: string;
}

export class SgsdkError extends Error {
  /** Why it failed — a short code, not a sentence. */
  reason: string;
  /** What to do about it, in a sentence. */
  hint?: string;

  constructor(message: string, reason: string, hint?: string) {
    super(message);
    this.name = "SgsdkError";
    this.reason = reason;
    this.hint = hint;
  }
}

/** How long a remembered identity is trusted, in milliseconds. */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** The component talks to Alibaba; give it a moment but not an hour. */
const RUN_TIMEOUT_MS = 30 * 1000;

/** `linux-x64`, `darwin-arm64` — the same shape the simulated client uses. */
export function sgsdkPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * The home directory the component reads, which is not `$HOME`.
 *
 * It is the home of the passwd entry of the current uid, so the seed file sits
 * at `<passwd home>/.config/.locale_cfg`. In a container that is the home of
 * the user the container runs as, and it has to live on a volume that survives
 * a rebuild.
 */
export function sgsdkHome(): string {
  try {
    return os.userInfo().homedir || os.homedir();
  } catch {
    return os.homedir();
  }
}

/** The seed file: the identity is bound to it, and it must not be deleted. */
export function sgsdkSeedPath(): string {
  return path.join(sgsdkHome(), ".config", ".locale_cfg");
}

/** Where this service keeps the component. */
export function sgsdkDir(): string {
  return path.join(dataDir(), "sgsdk");
}

/** The component the simulated client ships, for this platform. */
function embeddedBinaryName(): string {
  return `runtime-info-${sgsdkPlatform()}`;
}

/**
 * Where the component may be.
 *
 * In order: an explicit setting, the copy this service owns, and the copy the
 * official client put in its own home.
 */
export function sgsdkBinaryCandidates(): string[] {
  const out: string[] = [];
  const explicit = (readEnvValue("QODER_SGSDK_BINARY") || "").trim();
  if (explicit) out.push(explicit);
  out.push(path.join(sgsdkDir(), embeddedBinaryName()));
  const cliBin = path.join(sgsdkHome(), ".qoder", ".bin");
  for (const name of fs.existsSync(cliBin) ? fs.readdirSync(cliBin) : []) {
    if (name.startsWith(`runtime-info-${sgsdkPlatform()}`)) out.push(path.join(cliBin, name));
  }
  return out;
}

/** The component, if it is on this machine. */
export function sgsdkBinaryPath(): string | null {
  for (const candidate of sgsdkBinaryCandidates()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not there
    }
  }
  return null;
}

const B64 = /^[A-Za-z0-9+/=]$/;

/**
 * The binaries the bundle carries.
 *
 * They are base64 strings inside the minified bundle; the simulated client's own
 * `selectBinary(platform, arch)` picks one of them and writes it out. The
 * names of the variables are obfuscated and change from release to release,
 * so they are found by what they decode to instead: an ELF for this machine.
 */
export function findEmbeddedBinaries(bundlePath: string): { offset: number; bytes: Buffer }[] {
  const bundle = fs.readFileSync(bundlePath, "latin1");
  const out: { offset: number; bytes: Buffer }[] = [];
  let i = 0;
  while ((i = bundle.indexOf('="', i + 1)) > 0) {
    let j = i + 2;
    while (j < bundle.length && B64.test(bundle[j])) j++;
    const length = j - (i + 2);
    // The components are the big ones; the wasm module is smaller than a
    // megabyte and the DLL is the biggest of all.
    if (length >= 100000 && bundle[j] === '"') {
      out.push({ offset: i + 2, bytes: Buffer.from(bundle.slice(i + 2, j), "base64") });
    }
    i = j;
  }
  return out;
}

/** Is this ELF the one for this machine? */
function isElfForThisPlatform(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.readUInt32BE(0) !== 0x7f454c46) return false;
  const machine = bytes.readUInt16LE(18);
  if (process.arch === "x64") return machine === 0x3e;
  if (process.arch === "arm64") return machine === 0xb7;
  return false;
}

/**
 * Take the component out of a Qoder CLI bundle.
 *
 * The bundle is the minified `bundle/qodercli.js` (or `qoderclicn.js`) of the
 * npm package. The component lands next to the data, where
 * `sgsdkBinaryPath` looks for it.
 */
export function extractSgsdkBinary(
  bundlePath: string,
  outPath?: string,
): { path: string; sha256: string; bytes: number; offset: number } {
  if (!fs.existsSync(bundlePath)) {
    throw new SgsdkError(`bundle not found: ${bundlePath}`, "bundle_missing", "先装 @qoder-ai/qodercli 或 @qodercn-ai/qoderclicn。");
  }
  const candidates = findEmbeddedBinaries(bundlePath).filter((b) => isElfForThisPlatform(b.bytes));
  if (!candidates.length) {
    throw new SgsdkError(
      `no embedded component for ${sgsdkPlatform()} in ${bundlePath}`,
      "embedded_binary_missing",
      "这个包里没有本平台的原生组件，换一个版本试试。",
    );
  }
  // The x64 client keeps one ELF per platform; if there is more than one, the
  // bigger one is the component and the smaller one is something else.
  const picked = candidates.sort((a, b) => b.bytes.length - a.bytes.length)[0];
  const target = outPath ?? path.join(sgsdkDir(), embeddedBinaryName());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, picked.bytes, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return {
    path: target,
    sha256: createHash("sha256").update(picked.bytes).digest("hex"),
    bytes: picked.bytes.length,
    offset: picked.offset,
  };
}

/** The identity as it was found, with the seed it belongs to. */
interface RememberedIdentity extends SgsdkMachineIdentity {
  seed: string;
  at: number;
}

function seedFingerprint(): string {
  try {
    return createHash("sha256").update(fs.readFileSync(sgsdkSeedPath())).digest("hex");
  } catch {
    return "";
  }
}

let remembered: RememberedIdentity | null = null;

function rememberPath(): string {
  return path.join(sgsdkDir(), "identity.json");
}

function readRemembered(): RememberedIdentity | null {
  try {
    const raw = JSON.parse(fs.readFileSync(rememberPath(), "utf8"));
    if (raw && typeof raw.machineToken === "string" && raw.machineToken) return raw as RememberedIdentity;
  } catch {
    // no memory yet
  }
  return null;
}

function writeRemembered(identity: RememberedIdentity): void {
  try {
    fs.mkdirSync(sgsdkDir(), { recursive: true });
    fs.writeFileSync(rememberPath(), JSON.stringify(identity, null, 2), { mode: 0o600 });
  } catch {
    // a memory that cannot be written is not fatal
  }
}

/** The json the component prints. */
function parseInfo(stdout: string): SgsdkMachineInfo {
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) {
    throw new SgsdkError("the component printed nothing", "empty_output", "组件没有输出，检查外网是否通。");
  }
  let body: any;
  try {
    body = JSON.parse(line);
  } catch {
    throw new SgsdkError("the component printed something that is not json", "invalid_output");
  }
  const token = body?.machineToken;
  if (typeof token !== "string" || !token.trim()) {
    throw new SgsdkError("the component returned no token", "empty_token");
  }
  return {
    machineToken: token.trim(),
    machineType: typeof body?.machineType === "string" ? body.machineType : "",
    machineCode: typeof body?.machineCode === "string" ? body.machineCode : "",
    ...(body?.vmInfo && typeof body.vmInfo === "object" ? { vmInfo: body.vmInfo } : {}),
  };
}

/**
 * Run the component and read what it says.
 *
 * It needs the network: it asks Alibaba's umid service about the machine. The
 * answer is the same every time, as long as the seed file is not touched.
 */
export async function runSgsdk(
  opts: { environment?: SgsdkEnvironment; timeoutMs?: number } = {},
): Promise<SgsdkMachineInfo> {
  const binary = sgsdkBinaryPath();
  if (!binary) {
    throw new SgsdkError(
      "the sgsdk component is not on this machine",
      "binary_missing",
      "先用 extractSgsdkBinary() 从 Qoder CLI 的包里把原生组件抠出来。",
    );
  }
  const environment = SGSDK_ENVIRONMENT_IDS[opts.environment ?? "ONLINE"];
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [String(environment)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new SgsdkError("the component did not answer in time", "timeout", "组件要连阿里云，超时了。"),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new SgsdkError(`the component did not start: ${e.message}`, "spawn_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!out.trim()) {
        reject(
          new SgsdkError(
            `the component said nothing (exit ${code})${err ? `: ${err.trim().slice(0, 200)}` : ""}`,
            "no_output",
            "组件没输出。多半是外网不通（它要连 umid.daily.alibaba.net）。",
          ),
        );
        return;
      }
      resolve(out);
    });
  });
  return parseInfo(stdout);
}

/**
 * The identity of this machine.
 *
 * The blob comes from the component; the id beside it is a uuid the service
 * keeps, so the pair stays the same across restarts.
 *
 * The answer is remembered: the component is run again only when the seed
 * file changed, when the memory is older than an hour, or when `force` says
 * so.
 */
export async function machineIdentity(
  opts: { environment?: SgsdkEnvironment; force?: boolean } = {},
): Promise<SgsdkMachineIdentity> {
  const seed = seedFingerprint();
  if (!opts.force) {
    const cached = remembered ?? readRemembered();
    if (
      cached &&
      cached.seed === seed &&
      Date.now() - cached.at < CACHE_TTL_MS &&
      typeof cached.machineId === "string" &&
      cached.machineId
    ) {
      remembered = cached;
      return cached;
    }
  }
  const info = await runSgsdk(opts);
  const previous = readRemembered();
  const identity: RememberedIdentity = {
    ...info,
    // The id belongs to the machine, so it survives a new blob.
    machineId: previous?.machineId ?? randomUUID(),
    seed,
    at: Date.now(),
  };
  remembered = identity;
  writeRemembered(identity);
  return identity;
}

/**
 * The headers the simulated client puts on a request when it has an identity.
 *
 * The names come out of the simulated client's own code: `Cosy-MachineId` with the uuid,
 * and `Cosy-MachineToken`, `Cosy-MachineType`, `Cosy-MachineCode` with what
 * the component said.
 */
export function machineHeaders(identity: SgsdkMachineIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    "Cosy-MachineId": identity.machineId,
    "Cosy-MachineToken": identity.machineToken,
  };
  if (identity.machineType) headers["Cosy-MachineType"] = identity.machineType;
  if (identity.machineCode) headers["Cosy-MachineCode"] = identity.machineCode;
  return headers;
}

/** What the component looks like from here — for /health. Never throws. */
export function sgsdkStatus(): SgsdkStatus {
  const binary = sgsdkBinaryPath();
  const seed = sgsdkSeedPath();
  const seedExists = fs.existsSync(seed);
  const status: SgsdkStatus = {
    available: !!binary,
    platform: sgsdkPlatform(),
    seed,
    seedExists,
  };
  if (binary) status.binary = binary;
  if (!binary) {
    status.reason = "binary_missing";
    status.hint = "原生组件不在本机：用 extractSgsdkBinary() 从 Qoder CLI 的包里抠出来。";
  } else if (!seedExists) {
    status.reason = "seed_missing";
    status.hint = "种子文件不在：组件会另起一个身份，旧身份回不来。";
  }
  return status;
}
