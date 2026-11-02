// check-privacy.ts — the gate in front of a commit: does this change carry a
// real identity, a real credential or a real internal address into the repo.
//
//   node --experimental-strip-types check-privacy.ts           # this change only
//   node --experimental-strip-types check-privacy.ts --all     # the whole tree
//
// The repo is public and it leaked before: recorded upstream answers carried
// real names, mailboxes, account ids and avatar urls; a test file kept a real
// looking token; helper/ and .pi/agents/ carried the NAS address and the
// machine's own home directories; the .pyc files under __pycache__ carried
// those paths as bytes. Finding that late meant rewriting the whole history,
// so the check happens before the commit instead.
//
// Two modes, because the two questions differ:
//   default  the change under review: the files git status lists (new,
//            modified, untracked) and, inside a tracked file, the lines the
//            diff adds. Content that is already committed is not scanned —
//            a pre-commit gate must not blame the change for the past.
//   --all    the whole working tree: every tracked file plus the untracked
//            ones, every line. This is the health check of the repository as
//            it stands.
//
// A hit prints where it is, never what it is: the snippet keeps the first
// four characters and the rest is masked. This output is pasted into chats
// and logs, so it must not write the secret down a second time.
//
// Binaries get their own kind. Text replacement cannot reach the bytes inside
// a .pyc, so "replace the value" is not a fix there and the report says so.
//
// The scanner is shape based: it cannot tell a real token from a well made
// fake one. A hit is a place to look, not a verdict.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** One hit. The snippet is already masked. */
export type Hit = {
  /** The file, relative to the repository root. */
  file: string;
  /** The line, 1 based. */
  line: number;
  /** The kind of the pattern. */
  kind: string;
  /** The match, masked: the first four characters and nothing else. */
  snippet: string;
};

/** The marker that lets a line keep a value that has to be there. */
export const ALLOW_MARKER = "privacy:allow";

/** The kinds, in the order they are reported. */
export const KINDS = {
  email: "email",
  secretKey: "secret-key",
  githubToken: "github-token",
  awsKey: "aws-key",
  jwt: "jwt",
  bearer: "bearer",
  privateIp: "private-ip",
  localPath: "local-path",
  binaryFile: "binary-file",
  binaryContent: "binary-content",
} as const;

/** The directories that hold other people's bytes, not ours. */
const SKIP_DIRS = [
  "node_modules",
  "web/node_modules",
  "web/.gen",
  "web/dist",
  ".git",
  "data",
  ".pnpm-store",
  "test/.smoke-logs",
];

/**
 * The extensions that hold compiled bytes: a build output that has no place
 * in the repository, and that no text replacement can fix.
 */
const COMPILED_EXT = new Set([".pyc", ".pyo", ".so", ".dylib", ".dll", ".class", ".o", ".a"]);

/**
 * The extensions that hold media or archives: pictures, sound, video, fonts,
 * documents, compressed bundles. Their bytes are a normal product, not a
 * leak, and they are not text either, so they get no report at all.
 */
const MEDIA_EXT = new Set([
  // pictures
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff", ".avif", ".heic", ".heif",
  // sound
  ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac", ".aac", ".opus",
  // video
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v",
  // fonts
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // documents
  ".pdf",
  // archives
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".tar", ".7z", ".rar",
]);

type Rule = { kind: string; pattern: RegExp };

/**
 * The shapes worth a look. Every one of them is a shape a real value takes:
 * a mailbox, a provider key, a GitHub token, an AWS key id, a JWT, a bearer
 * header, an address inside the LAN, a directory of somebody's machine.
 */
const RULES: Rule[] = [
  { kind: KINDS.email, pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: KINDS.secretKey, pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  {
    kind: KINDS.githubToken,
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  },
  { kind: KINDS.awsKey, pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: KINDS.jwt, pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: KINDS.bearer, pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  {
    kind: KINDS.privateIp,
    // Four octets, every branch of them: a version number has three
    // ("10.4.1"), so it is not an address. The last octet may not be
    // followed by another one: "10.4.1.2.3" is not an address either.
    pattern:
      /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\.\d)/g,
  },
  {
    kind: KINDS.localPath,
    pattern: /(?:\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)/g,
  },
];

/** The mailboxes that are obviously placeholders, not a person. */
const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "example",
  "localhost",
  "invalid",
  "test",
]);

/**
 * A mailbox that names nobody: the reserved example domains, the "test"
 * local part, the no-reply addresses. A real mailbox survives this.
 */
export function isPlaceholderEmail(raw: string): boolean {
  const at = raw.lastIndexOf("@");
  if (at < 0) return false;
  const local = raw.slice(0, at).toLowerCase();
  const domain = raw.slice(at + 1).toLowerCase();
  if (local === "test" || local.startsWith("noreply")) return true;
  if (domain === "users.noreply.github.com") return true;
  if (PLACEHOLDER_DOMAINS.has(domain)) return true;
  return domain.endsWith(".example.com") || domain.endsWith(".example.org") || domain.endsWith(".example.net");
}

/** Keep the head of the match, drop the rest: the report is a map, not the value. */
export function mask(raw: string): string {
  return `${raw.slice(0, 4)}***`;
}

/** The path of a file relative to the repository root, always with slashes. */
function rel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Is this path in a directory the scanner does not look into? */
export function isSkipped(filePath: string): boolean {
  const parts = filePath.split("/");
  if (parts.includes("node_modules")) return true;
  return SKIP_DIRS.some((dir) => filePath === dir || filePath.startsWith(`${dir}/`));
}

/**
 * The hits in one piece of text. A line carrying the allow marker keeps its
 * value: the caller has said that value has to be there.
 */
export function scanText(text: string, file: string): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(line)) !== null) {
        const raw = match[0];
        if (rule.kind === KINDS.email && isPlaceholderEmail(raw)) continue;
        hits.push({ file, line: index + 1, kind: rule.kind, snippet: mask(raw) });
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      }
    }
  }
  return hits;
}

/** The line the first NUL byte sits on. */
function nulLine(buf: Buffer): number {
  const at = buf.indexOf(0);
  if (at < 0) return 1;
  let line = 1;
  for (let index = 0; index < at; index++) if (buf[index] === 0x0a) line++;
  return line;
}

/**
 * The hits in one file. `only` limits the text scan to a set of lines — the
 * lines a diff adds — while the binary kinds are always reported: a compiled
 * file that changed is a thing to look at whatever the diff says.
 */
export function scanFile(root: string, file: string, only?: Set<number>): Hit[] {
  const abs = path.join(root, file);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return [];
  }
  const hits: Hit[] = [];
  const ext = path.extname(file).toLowerCase();
  if (COMPILED_EXT.has(ext)) {
    hits.push({ file, line: 1, kind: KINDS.binaryFile, snippet: "二进制文件，文本替换改不到" });
  }
  // Media and archives are normal products: their bytes are not a leak, and
  // they are not text either, so there is nothing to report and nothing to
  // read as text.
  if (MEDIA_EXT.has(ext)) return hits;
  if (buf.includes(0)) {
    hits.push({ file, line: nulLine(buf), kind: KINDS.binaryContent, snippet: "二进制，文本替换改不到" });
    return hits;
  }
  const found = scanText(buf.toString("utf8"), file);
  const text = only ? found.filter((hit) => only.has(hit.line)) : found;
  return [...hits, ...text];
}

/** Run git in the repository and take what it says. */
function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The repository root, or the working directory when git has no answer. */
export function repoRoot(start: string): string {
  try {
    return git(start, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return start;
  }
}

/** Undo the quoting git puts around a path with odd characters in it. */
function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

/** Every file under a directory, the skipped ones left out. */
function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (isSkipped(rel(root, abs))) continue;
      out.push(...walk(root, abs));
    } else if (entry.isFile()) {
      out.push(rel(root, abs));
    }
  }
  return out;
}

/** The files under a path: the path itself when it is a file. */
function expand(root: string, target: string): string[] {
  const abs = path.join(root, target);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) return [];
  if (stat.isDirectory()) return walk(root, abs);
  return [target];
}

/**
 * The files the change touches, as git status sees them. A deleted file is
 * not scanned: there is nothing left of it to leak.
 */
export function statusFiles(root: string): string[] {
  const out = new Set<string>();
  let text = "";
  try {
    text = git(root, ["status", "--porcelain"]);
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2);
    if (code.includes("D")) continue;
    let target = line.slice(3).trim();
    if (target.includes(" -> ")) target = target.split(" -> ").pop() ?? target;
    target = unquote(target);
    for (const file of expand(root, target)) {
      if (!isSkipped(file)) out.add(file);
    }
  }
  return [...out];
}

/**
 * The lines the diff adds, per file. A file that is new to the repository has
 * no diff, so every line of it is new.
 */
export function addedLines(root: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let diff = "";
  try {
    diff = git(root, ["diff", "HEAD", "--unified=0", "--no-color"]);
  } catch {
    return out;
  }
  let file = "";
  let line = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(row);
      file = match ? match[2] : "";
      continue;
    }
    if (row.startsWith("+++ ")) {
      const target = row.slice(4).trim();
      file = target === "/dev/null" ? "" : unquote(target.replace(/^b\//, ""));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (file === "") continue;
    if (row.startsWith("+")) {
      const set = out.get(file) ?? new Set<number>();
      set.add(line);
      out.set(file, set);
      line++;
    } else if (row.startsWith("-")) {
      // an old line: the new file's numbering does not move
    } else if (row.startsWith("\\")) {
      // the marker for a missing newline
    } else {
      line++;
    }
  }
  return out;
}

/** The files that are already committed. */
function committedFiles(root: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const line of git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")) {
      if (line.trim() !== "") out.add(line.trim());
    }
  } catch {
    // no commit yet: everything is new
  }
  return out;
}

/** The message of the last commit. */
function headMessage(root: string): string | null {
  try {
    return git(root, ["log", "-1", "--pretty=%B"]);
  } catch {
    return null;
  }
}

/** The result of one run. */
export type Scan = {
  hits: Hit[];
  /** How many files were looked at. */
  files: number;
  /** The mode the run was in. */
  mode: "change" | "all";
};

/**
 * The scan itself. The default mode looks at the change: the files git status
 * lists and, inside a tracked file, the lines the diff adds. The --all mode
 * looks at every line of every tracked and untracked file.
 */
export function scan(root: string, options: { all?: boolean } = {}): Scan {
  const hits: Hit[] = [];
  let files = 0;

  if (options.all) {
    const listed = new Set<string>();
    for (const args of [["ls-files"], ["ls-files", "--others", "--exclude-standard"]]) {
      let text = "";
      try {
        text = git(root, args);
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const file = line.trim();
        if (file === "" || isSkipped(file)) continue;
        listed.add(file);
      }
    }
    for (const file of [...listed].sort()) {
      files++;
      hits.push(...scanFile(root, file));
    }
  } else {
    const committed = committedFiles(root);
    const added = addedLines(root);
    const targets = new Set<string>(statusFiles(root));
    for (const file of added.keys()) targets.add(file);
    for (const file of [...targets].sort()) {
      files++;
      // A committed file is scanned on the lines this change adds, and on
      // nothing else: the history behind it is not this change's business. A
      // change that only deletes lines adds nothing, so that file
      // contributes no lines at all — not all of them.
      const only = committed.has(file) ? (added.get(file) ?? new Set<number>()) : undefined;
      hits.push(...scanFile(root, file, only));
    }
  }

  const message = headMessage(root);
  if (message !== null) {
    // A commit message that names what was leaked is an index of the leak.
    hits.push(...scanText(message, "(HEAD 提交信息)"));
  }

  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { hits, files, mode: options.all ? "all" : "change" };
}

/** The run as the command line does it. */
function main(argv: string[]): number {
  const unknown = argv.filter((arg) => arg !== "--all");
  if (unknown.length > 0) {
    console.error(`用法：node --experimental-strip-types check-privacy.ts [--all]`);
    return 2;
  }
  const all = argv.includes("--all");
  const root = repoRoot(process.cwd());
  const result = scan(root, { all });
  for (const hit of result.hits) {
    console.log(`${hit.file}:${hit.line}  ${hit.kind}  ${hit.snippet}`);
  }
  const scope = result.mode === "all" ? "整个工作树" : "本次改动";
  console.log(`扫了 ${result.files} 个文件（${scope}），${result.hits.length} 条命中`);
  return result.hits.length > 0 ? 1 : 0;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
