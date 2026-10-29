#!/usr/bin/env python3
"""盯着 MiniMax 的额度，额度回来（或到点）之后给当前目录的会话发一条消息。

    python3 helper/buddy_todo.py              # 等额度回来再发
    python3 helper/buddy_todo.py --now        # 立刻发
    python3 helper/buddy_todo.py --at 14:30   # 到点发（本地时间）
    python3 helper/buddy_todo.py --dry-run    # 只打印，不发

待办写在当前目录的 `.buddy-todo.md` 里，内容就是要发的话。发成功了那个文件
改名成 `.buddy-todo.sent-<时间戳>.md` 存档；失败了原样留着。

会话要自己选（防止发错地方）：脚本把当前目录的会话列出来编号，回车确认才发，
`--session <编号或 id>` 可以跳过这步（给自动化用）。
"""
import argparse
import datetime
import pathlib
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import common  # noqa: E402  （同目录，放进 sys.path 之后才能 import）

DEFAULT_TIMEOUT = 1800  # 30 分钟
DEFAULT_GRACE = 60      # 秒
DEFAULT_POLL = 30       # 秒

EXIT_NO_TODO = 2
EXIT_NO_PLAN = 3
EXIT_SEND_FAILED = 4

# 会话列表里最后那一项：新开一个 pi 会话。
NEW_SESSION = {"client": "pi", "id": "", "title": "新开一个 pi 会话", "new": True}


def log(message: str) -> None:
    print(f"buddy-todo: {message}")


# ------------------------------------------------------------------ 额度


def parse_health(payload) -> list:
    """从 /health 里挑出 MiniMax 的账号和它们的额度窗口。

    返回每个账号一条：
      id / interval_percent / interval_ends_at / cooldown_until_ms / out_of_credits

    只有 `general` 窗口算数（video 窗口网关不服务）。没有 tokenPlan 的账号
    给安全默认（没有窗口额度 = 不可用）。
    """
    if not isinstance(payload, dict):
        return []
    upstreams = payload.get("upstreams")
    node = None
    if isinstance(upstreams, list):
        for entry in upstreams:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("id") or entry.get("name") or entry.get("key") or "")
            if name.lower() == "minimax":
                node = entry
                break
    elif isinstance(upstreams, dict):
        node = upstreams.get("minimax")
        if node is None:
            for key, value in upstreams.items():
                if key.lower() == "minimax":
                    node = value
                    break

    if isinstance(node, list):
        raw_accounts = node
    elif isinstance(node, dict):
        accounts = node.get("accounts")
        raw_accounts = accounts if isinstance(accounts, list) else []
    else:
        raw_accounts = []

    out = []
    for index, raw in enumerate(raw_accounts):
        if not isinstance(raw, dict):
            continue
        account_id = str(
            raw.get("id")
            or raw.get("accountId")
            or raw.get("providerId")
            or raw.get("name")
            or raw.get("label")
            or f"minimax#{index}"
        )
        snapshot = raw.get("snapshot")
        snapshot = snapshot if isinstance(snapshot, dict) else {}
        token_plan = snapshot.get("tokenPlan")
        token_plan = token_plan if isinstance(token_plan, dict) else {}
        windows = token_plan.get("windows")
        windows = windows if isinstance(windows, list) else []

        general = None
        for window in windows:
            if not isinstance(window, dict):
                continue
            if str(window.get("model") or "").lower() == "general":
                general = window
                break

        cooldown = raw.get("cooldown")
        cooldown = cooldown if isinstance(cooldown, dict) else {}
        until = cooldown.get("untilMs")
        if until is None:
            until = cooldown.get("until")
        if until is None:
            until = raw.get("cooldownUntilMs")

        out.append(
            {
                "id": account_id,
                "interval_percent": general.get("intervalPercent") if general else 0,
                "interval_ends_at": common.to_ms(general.get("intervalEndsAt")) if general else 0,
                "cooldown_until_ms": common.to_ms(until),
                "out_of_credits": raw.get("outOfCredits") is True,
            }
        )
    return out


def next_recovery(accounts: list, now_ms: int, grace_ms: int = 0):
    """额度什么时候回来。

    返回 None 表示算不出来（没有窗口、没有冷却、也没有可读的时间）。

    算得出来时返回：
      usable      现在就能发吗
      at          该发的那一刻（毫秒时间戳，含 grace）
      recovers_at 额度真正回来的那一刻（不含 grace）
      reason      一句话说明
    """
    usable = None
    for account in accounts:
        if (
            (account.get("interval_percent") or 0) > 0
            and not account.get("out_of_credits")
            and (account.get("cooldown_until_ms") or 0) <= now_ms
        ):
            usable = account
            break
    if usable is not None:
        reason = f"{usable['id']} 还有 {usable['interval_percent']}% 的窗口额度"
        return {
            "usable": True,
            "at": now_ms,
            "recovers_at": now_ms,
            "reason": reason,
        }

    candidates = []
    for account in accounts:
        at = max(account.get("interval_ends_at") or 0, account.get("cooldown_until_ms") or 0)
        if at > now_ms:
            candidates.append((at, account))
    if not candidates:
        return None
    candidates.sort(key=lambda pair: pair[0])
    at, account = candidates[0]
    limit = (
        "冷却到那时结束"
        if (account.get("cooldown_until_ms") or 0) > (account.get("interval_ends_at") or 0)
        else "general 窗口到那时结束"
    )
    return {
        "usable": False,
        "at": at + grace_ms,
        "recovers_at": at,
        "reason": f"{account['id']} 的额度在 {datetime.datetime.fromtimestamp(at / 1000).isoformat()} 回来（{limit}）",
    }


def read_accounts(gateway: str) -> tuple:
    """读网关的 /health。返回 (账号列表, 错误信息)。"""
    url = f"{gateway}/health"
    payload, err = common.http_get_json(url)
    if err:
        return [], err
    return parse_health(payload), ""


# ------------------------------------------------------------------ 会话


def describe(session: dict) -> str:
    """一行说明：客户端 / id / 时间 / 标题。"""
    client = session.get("client", "")
    sid = session.get("id") or ""
    if len(sid) > 13 and common.UUID_RE.fullmatch(sid):
        sid = sid[:13]
    title = (session.get("title") or "").strip().replace("\n", " ")
    if len(title) > 60:
        title = title[:60] + "…"
    stamp = common.format_time(session.get("updated_ms") or 0)
    return f"{client:<9} {sid:<26} ({stamp})  {title}"


def list_sessions(cwd: str, client: str, pi_root=None) -> list:
    """当前目录的会话，按最后更新倒序。"""
    root = pathlib.Path(pi_root) if pi_root else common.PI_SESSIONS_ROOT
    sessions = []
    if client in ("pi", "both"):
        sessions.extend(common.pi_sessions(root, cwd))
    if client in ("opencode", "both"):
        found, err = common.opencode_sessions(cwd)
        if err:
            log(f"opencode 的会话列表拿不到：{err}")
        sessions.extend(found)
    sessions.sort(key=lambda s: s.get("updated_ms") or 0, reverse=True)
    return sessions


def choose_session(sessions: list, reader=None) -> dict:
    """让人挑一个会话。回车确认第一项，q 退出。

    返回挑中的会话（最后一项是「新开一个 pi 会话」）。
    """
    reader = reader or input
    options = list(sessions) + [dict(NEW_SESSION)]
    print()
    for index, session in enumerate(options, start=1):
        print(f"[{index}] {describe(session)}")
    print()
    while True:
        try:
            answer = reader("选哪个？(默认 1，回车确认，q 退出) ").strip()
        except EOFError:
            answer = ""
        if answer.lower() == "q":
            raise SystemExit(0)
        if not answer:
            return options[0]
        if answer.isdigit() and 1 <= int(answer) <= len(options):
            return options[int(answer) - 1]
        # 也接受直接写 id。
        for session in options:
            if session.get("id") and answer == session["id"]:
                return session
        print(f"看不懂「{answer}」。编号 1-{len(options)}，或者直接写会话 id。")


def resolve_session(sessions: list, wanted: str) -> dict:
    """`--session` 给的是编号还是 id，这里解析成会话。"""
    options = list(sessions) + [dict(NEW_SESSION)]
    wanted = str(wanted).strip()
    if wanted.isdigit():
        index = int(wanted)
        if 1 <= index <= len(options):
            return options[index - 1]
        raise SystemExit(f"buddy-todo: 没有第 {index} 个会话（一共 {len(options)} 个）。")
    for session in options:
        if session.get("id") and wanted == session["id"]:
            return session
    raise SystemExit(f"buddy-todo: 找不到会话 {wanted}。")


# ------------------------------------------------------------------ 发


def send_command(client: str, session: dict, prompt: str) -> list:
    """发消息的那条命令。

    pi 必须传 transcript 的**绝对路径**：传裸 id 在跨目录的时候 pi 会问
    「Fork this session into current directory? [y/N]」，非交互的进程就挂死了。
    """
    if client == "opencode":
        return ["opencode", "run", "-s", session["id"], "--prompt", prompt]
    if session.get("new"):
        return ["pi", "-p", "--session-id", session["id"], "--", prompt]
    return ["pi", "-p", "--session", session["path"], "--", prompt]


def quote(part: str) -> str:
    """给命令里的一个参数加引号（只为了给人看）。"""
    if any(ch in part for ch in ' \t\n"\'\\'):
        return '"' + part.replace('"', '\\"') + '"'
    return part


def show_command(argv: list, prompt: str) -> str:
    """命令的一行式（prompt 截断到 200 字）。"""
    head = " ".join(quote(part) for part in argv[:-1])
    tail = quote(argv[-1])
    if len(tail) > 200:
        tail = tail[:200] + "…"
    return f"{head} {tail}"


def deliver(todo_path: pathlib.Path, client: str, session: dict, prompt: str, dry_run: bool = False, timeout: int = DEFAULT_TIMEOUT, runner=None) -> tuple:
    """把待办发出去，成功了把待办改名存档。

    返回 (退出码, 说明)。
    """
    if session.get("new"):
        session = dict(session)
        session["id"] = session.get("id") or str(uuid.uuid4())

    argv = send_command(client, session, prompt)
    if dry_run:
        log(f"dry-run，不发送：{show_command(argv, prompt)}")
        return 0, "dry-run"

    log(f"发送：{show_command(argv, prompt)}")
    run = runner or common.run_command
    try:
        code, _stdout, stderr = run(argv, cwd=str(todo_path.parent), timeout=timeout)
    except common.CommandFailed as exc:
        log(f"发送失败：{exc}")
        if exc.stderr:
            log(f"stderr：{exc.stderr[:500]}")
        return EXIT_SEND_FAILED, str(exc)

    if code != 0:
        log(f"发送失败：{argv[0]} 退出码 {code}")
        if stderr:
            log(f"stderr：{stderr[:500]}")
        return EXIT_SEND_FAILED, f"退出码 {code}"

    archived = common.archive(todo_path)
    log(f"发成功了，待办存档成 {archived.name}")
    return 0, "sent"


# ------------------------------------------------------------------ 入口


def parse_at(value: str, now=None) -> float:
    """`--at 14:30`（也接受 14:30:00）→ 那一天那一刻的时间戳（秒）。

    今天那一刻已经过去了，就用明天。
    """
    now = now or datetime.datetime.now()
    parts = value.strip().split(":")
    if len(parts) not in (2, 3) or not all(part.isdigit() for part in parts):
        raise SystemExit(f"buddy-todo: --at 不是时间（收到 {value}，例：14:30）")
    hour, minute = int(parts[0]), int(parts[1])
    second = int(parts[2]) if len(parts) == 3 else 0
    target = now.replace(hour=hour, minute=minute, second=second, microsecond=0)
    if target <= now:
        target += datetime.timedelta(days=1)
    return target.timestamp()


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="盯额度，额度回来之后给当前目录的会话发一条消息")
    parser.add_argument("--file", default=None, help="待办文件（默认当前目录的 .buddy-todo.md）")
    parser.add_argument("--cwd", default=None, help="工作目录：待办文件、会话列表、客户端的 cwd（默认当前目录）")
    parser.add_argument("--now", action="store_true", help="立刻发，不等额度")
    parser.add_argument("--at", default=None, help="到点发（本地时间，例 14:30 或 14:30:00）")
    parser.add_argument("--client", choices=["pi", "opencode"], default=None, help="用哪个客户端（默认两个都列，挑哪个算哪个）")
    parser.add_argument("--session", default=None, help="会话编号或 id（给了就不问）")
    parser.add_argument("--gateway", default=None, help="网关地址（默认 http://127.0.0.1:6450，连不上就试 NAS 上那份）")
    parser.add_argument("--grace", type=int, default=DEFAULT_GRACE, help=f"额度回来之后多等几秒（默认 {DEFAULT_GRACE}）")
    parser.add_argument("--poll", type=int, default=DEFAULT_POLL, help=f"每隔多久重读一次额度（默认 {DEFAULT_POLL} 秒）")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help=f"客户端最多跑多久（默认 {DEFAULT_TIMEOUT} 秒）")
    parser.add_argument("--force", action="store_true", help="到点了额度还是不可用，也照发")
    parser.add_argument("--dry-run", action="store_true", help="只打印要发的命令，不发")
    args = parser.parse_args(argv)

    cwd = pathlib.Path(args.cwd).resolve() if args.cwd else pathlib.Path.cwd()
    todo_path = pathlib.Path(args.file) if args.file else cwd / ".buddy-todo.md"
    if not todo_path.is_absolute():
        todo_path = (cwd / todo_path).resolve()
    if not todo_path.is_file():
        log(f"找不到待办文件 {todo_path}。在当前目录写一个 .buddy-todo.md 再跑。")
        return EXIT_NO_TODO
    prompt = todo_path.read_text(encoding="utf-8")
    if not prompt.strip():
        log(f"待办文件 {todo_path.name} 是空的，没什么要发的。")
        return EXIT_NO_TODO

    # 真正的网关要连得上才算数：挨个候选试，第一个答得上 /health 的算准。
    gateway = ""
    accounts = []
    if not args.now:
        for candidate in common.gateway_candidates(args.gateway):
            accounts, err = read_accounts(candidate)
            if not err:
                gateway = candidate
                break
            log(f"{candidate} 的额度拿不到：{err}")
        if not gateway:
            if not args.dry_run:
                log("网关的 /health 读不出来，不知道额度什么时候回来。")
                return EXIT_NO_PLAN
            gateway = common.gateway_candidates(args.gateway)[0]

    plan = None
    if not args.now:
        plan = next_recovery(accounts, int(time.time() * 1000), args.grace * 1000)
        if plan is None:
            if args.dry_run:
                log("算不出额度什么时候回来（没有窗口、冷却或额度可读）。")
            else:
                log("算不出额度什么时候回来：没有账号的窗口额度、冷却时间或额度可读。")
                return EXIT_NO_PLAN
        else:
            log(plan["reason"])

    sessions = list_sessions(str(cwd), args.client or "both")
    if args.session:
        session = resolve_session(sessions, args.session)
    else:
        session = choose_session(sessions)
    client = session.get("client", "pi")
    log(f"选中：{describe(session)}")

    if args.dry_run:
        code, _ = deliver(todo_path, client, session, prompt, dry_run=True, timeout=args.timeout)
        return code

    if args.now:
        log("立刻发。")
    elif args.at:
        target = parse_at(args.at)
        wait = max(0.0, target - time.time())
        log(f"等到 {datetime.datetime.fromtimestamp(target).strftime('%Y-%m-%d %H:%M:%S')} 再发（约 {int(wait)} 秒）。")
        time.sleep(wait)
        # 到点了重读一次额度：不可用就接着等（除非 --force）。
        accounts, err = read_accounts(gateway)
        if err:
            log(f"额度重读失败：{err}")
        else:
            plan = next_recovery(accounts, int(time.time() * 1000), args.grace * 1000)
            if plan is None:
                log("算不出额度什么时候回来。")
                return EXIT_NO_PLAN
            if not plan["usable"]:
                if args.force:
                    log("--force：额度还不可用，照发。")
                else:
                    log(f"{plan['reason']}；继续等。")
                    wait_until(gateway, args.grace * 1000, args.poll)
    else:
        if plan is not None and not plan["usable"]:
            wait_until(gateway, args.grace * 1000, args.poll)

    code, _reason = deliver(todo_path, client, session, prompt, timeout=args.timeout)
    return code


def wait_until(gateway: str, grace_ms: int, poll_s: int) -> None:
    """等到额度回来（每 poll_s 秒重读一次）。"""
    while True:
        now = int(time.time() * 1000)
        accounts, err = read_accounts(gateway)
        if err:
            log(f"额度重读失败：{err}")
            time.sleep(poll_s)
            continue
        current = next_recovery(accounts, now, grace_ms)
        if current is None:
            log("算不出额度什么时候回来。")
            raise SystemExit(EXIT_NO_PLAN)
        if current["usable"]:
            log(f"额度可用（{current['reason']}）")
            return
        wait = max(1, min(poll_s, int((current["at"] - now) / 1000)))
        log(f"{current['reason']}；{wait} 秒后再看")
        time.sleep(wait)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
