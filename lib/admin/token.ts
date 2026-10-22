// lib/admin/token.ts — 面板自己的令牌。
//
// 面板的鉴权与 agent 侧的前门是两回事：前门那道 REQUIRE_API_KEY 可以关掉
// （公开模式），但面板管的是凭据，不能跟着公开模式走。所以面板有自己的一把
// 钥匙：数据目录里的 admin-token，0600。
//
// 生成方式跟 api-keys.json 一样（随机字节 + hex），只是落在文件里而不是
// 数据库里 —— 面板要在数据库还是空的时候也能用。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataFile } from "../paths.ts";

/** 令牌文件的名字。它在数据目录里，活过容器重建。 */
const TOKEN_FILE = "admin-token";

/** 令牌有多少字节（十六进制字符数的一半）。 */
const TOKEN_BYTES = 32;

/** 令牌文件在哪。 */
export function tokenPath(): string {
  return dataFile(TOKEN_FILE);
}

/** 读到的令牌。读一次就够了，进程里一直拿着。 */
let cached: string | null = null;

/**
 * 面板的令牌：没有就生成一个。
 *
 * 生成的动作放在启动时（router-proxy.ts 调它），所以第一次有人访问面板时
 * 文件一定已经在那里了。
 *
 * 令牌只在**第一次生成**时打进日志：服务起来的时候人往往不在机器前，
 * 日志里露这一次面是唯一的办法。之后重启不再重复打 —— 日志不是秘密的
 * 存放处，令牌在文件里。
 */
export function adminToken(): string {
  if (cached) return cached;
  const file = tokenPath();
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) {
      // 已经有了：不打日志。
      cached = raw;
      return raw;
    }
  } catch {
    /* 文件还没有，下面生成一个 */
  }
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 不是我们的文件就算了 */
  }
  console.log(`[ADMIN] 面板令牌已生成：${token}`);
  console.log(`        写到了 ${file}（0600）`);
  cached = token;
  return token;
}

/** 令牌是不是已经配好了。 */
export function adminTokenSet(): boolean {
  try {
    return fs.readFileSync(tokenPath(), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 校验请求头里的令牌。
 *
 * 令牌是 Bearer，中间的空格可以有也可以没有（面板发的是标准写法）。
 * 比对用定长的比较，免得令牌被一个字节一个字节地试出来。
 */
export function checkAdminToken(headers: Record<string, unknown>): boolean {
  const raw = String((headers as any).authorization ?? "").trim();
  // 标准写法是 "Bearer <令牌>"，中间有空格。有人写成 "Bearer<令牌>" 也认。
  const token = /^Bearer\s*/i.test(raw) ? raw.replace(/^Bearer\s*/i, "").trim() : raw;
  if (!token) return false;
  const expected = adminToken();
  const given = Buffer.from(token, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}
