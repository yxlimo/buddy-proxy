// lib/admin/log.ts — 凭据日志的末尾几行。
//
// 凭据的麻烦事正是那种「事后才想看」的事：容器一重建，容器日志就没了，
// 而凭据日志在数据卷里，活过重建。所以面板里能翻它。

import fs from "node:fs";
import { dataFile } from "../paths.ts";

/** 一次最多读多少字节。日志再大也只翻末尾。 */
const MAX_BYTES = 4 * 1024 * 1024;

/** 最多给多少行。 */
const MAX_LINES = 2000;

/** 日志文件在哪。 */
function logPath(): string {
  return dataFile("auth.log");
}

/**
 * 日志的末尾若干行。
 *
 * 检索词是子串匹配，不区分大小写。文件不在就当没有日志。
 */
export function tailLog(lines = 200, filter = ""): string[] {
  const want = Math.min(Math.max(Number(lines) || 0, 1), MAX_LINES);
  let text = "";
  try {
    const stat = fs.statSync(logPath());
    const size = stat.size;
    if (size <= MAX_BYTES) {
      text = fs.readFileSync(logPath(), "utf8");
    } else {
      const fd = fs.openSync(logPath(), "r");
      try {
        const buf = Buffer.alloc(MAX_BYTES);
        fs.readSync(fd, buf, 0, MAX_BYTES, size - MAX_BYTES);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return [];
  }
  const all = text.split("\n").filter((line) => line.trim().length > 0);
  const needle = String(filter ?? "").trim().toLowerCase();
  const matched = needle ? all.filter((line) => line.toLowerCase().includes(needle)) : all;
  return matched.slice(Math.max(matched.length - want, 0));
}
