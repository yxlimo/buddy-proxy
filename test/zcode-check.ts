// ZCode 登录窗口的到期时间：平台给的是秒。
import { expiresAtMs } from "../lib/zcode/auth.ts";

const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) process.exitCode = 1;
};

const now = Date.now();

// 平台给的是秒：1,792,892,746 是 2026-10-25，不是 1970。
const aSecond = Math.floor(now / 1000) + 300;
check(
  "秒换算成毫秒",
  expiresAtMs(aSecond) === aSecond * 1000,
  String(expiresAtMs(aSecond)),
);
check(
  "本来就是毫秒的不动",
  expiresAtMs(aSecond * 1000) === aSecond * 1000,
  String(expiresAtMs(aSecond * 1000)),
);
check(
  "没有值就用默认",
  expiresAtMs(undefined) > now && expiresAtMs(0) > now,
  String(expiresAtMs(0)),
);
check(
  "换算之后在未来",
  expiresAtMs(aSecond) > now,
  `${expiresAtMs(aSecond)} vs ${now}`,
);
check(
  "秒的数字不能被当成毫秒",
  expiresAtMs(aSecond) > 1e11,
  String(expiresAtMs(aSecond)),
);
