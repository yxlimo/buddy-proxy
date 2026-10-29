#!/usr/bin/env python3
"""buddy-helper 共用的那几件：读网关、找会话、跑命令、归档。

只用标准库。两个脚本（buddy_sync.py / buddy_todo.py）都从这里取东西，
单测（test_buddy.py）也是拿这里当桩来测。
"""
from __future__ import annotations

import datetime
import http.client
import json
import os
import pathlib
import re
import subprocess
import urllib.parse

# 网关地址候选：挨个试，第一个通的算准。
# 127.0.0.1 是本机自己起的网关；NAS 上那份是 192.168.50.4。
# 命令行 --gateway 与环境变量 BUDDY_GATEWAY 都能覆盖。
DEFAULT_GATEWAYS = ["http://127.0.0.1:6450", "http://192.168.50.4:6450"]
ENV_GATEWAY = "BUDDY_GATEWAY"

# pi 的会话都放在这儿，按工作目录分目录。
PI_SESSIONS_ROOT = pathlib.Path.home() / ".pi" / "agent" / "sessions"

UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


# ------------------------------------------------------------------ 网关


def gateway_candidates(explicit: str | None = None) -> list:
    """要试的网关地址：命令行 > 环境变量 > 默认候选。"""
    if explicit:
        return [explicit.rstrip("/")]
    env = os.environ.get(ENV_GATEWAY) or os.environ.get("ROUTER_URL")
    if env:
        return [env.rstrip("/")]
    return [g.rstrip("/") for g in DEFAULT_GATEWAYS]


def http_get_json(url: str, timeout: int = 15):
    """GET 一个 JSON。返回 (数据, 错误信息)；错的时候数据是 None。"""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None, f"{url} 不是 http(s) 地址"
    port = parts.port or (443 if parts.scheme == "https" else 80)
    target = parts.path or "/"
    if parts.query:
        target += "?" + parts.query
    connection = (
        http.client.HTTPSConnection
        if parts.scheme == "https"
        else http.client.HTTPConnection
    )
    client = connection(parts.hostname, port, timeout=timeout)
    try:
        client.request("GET", target)
        response = client.getresponse()
        body = response.read().decode("utf-8", errors="replace")
    except Exception as exc:  # 网关没起、网络不通
        return None, f"{url} 拉不到：{exc}"
    finally:
        client.close()
    try:
        return json.loads(body), ""
    except ValueError as exc:
        return None, f"{url} 返回的不是 JSON：{exc}"


def fetch_from_gateways(gateways: list, path: str, timeout: int = 15):
    """挨个候选网关试。返回 (数据, 用到的网关, 错误信息)。"""
    last = ""
    for base in gateways:
        data, err = http_get_json(base + path, timeout=timeout)
        if data is not None:
            return data, base, ""
        last = err
    return None, "", last


# ------------------------------------------------------------------ 会话


def session_id_of(name: str | None):
    """pi 会话名里的 id。

    pi 的会话名是 `<时间戳>_<id>`；名字里带 UUID 时取那个 UUID，
    只有下划线时取下划线后面那段。两者都没有（比如 `subagent-artifacts`）
    就不是会话，返回 None。
    """
    trimmed = (name or "").strip()
    if not trimmed:
        return None
    found = UUID_RE.findall(trimmed)
    if found:
        return found[-1]
    cut = trimmed.rfind("_")
    if 0 <= cut < len(trimmed) - 1:
        return trimmed[cut + 1:]
    return None


def pi_session_dirs(root, cwd: str) -> list:
    """某个工作目录在 pi 会话根目录下的那一个（或几个）目录。

    pi 用工作目录的绝对路径当目录名：斜杠换成横线，外面再包一层 `--`。
    """
    base = pathlib.Path(root)
    raw = str(cwd)
    slug = raw.replace("/", "-").strip("-")
    dirs = [base / f"--{slug}--"]
    loose = base / ("--" + raw.replace("/", "-") + "--")
    if loose not in dirs:
        dirs.append(loose)
    return dirs


def _text_of(content) -> str:
    """消息正文：字符串直接给，数组就拼里面的 text。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(p for p in parts if p)
    return ""


def first_user_message(path) -> str:
    """会话记录里第一条用户消息（当标题用）。读不到就空串。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(record, dict) or record.get("type") != "message":
                    continue
                message = record.get("message")
                if not isinstance(message, dict) or message.get("role") != "user":
                    continue
                text = _text_of(message.get("content")).strip()
                if text:
                    return text
    except OSError:
        return ""
    return ""


def pi_sessions(root, cwd: str) -> list:
    """当前目录的 pi 会话，按最后更新倒序。

    会话要么是一个 `<时间戳>_<id>.jsonl` 文件，要么是一个同名目录
    （transcript 在目录里的 session.jsonl，或旁边的同名 .jsonl）。
    没有 transcript 的目录不是会话 —— 子代理产物目录就是这样，跳过。
    """
    found = {}
    for directory in pi_session_dirs(root, cwd):
        if not directory.is_dir():
            continue
        for entry in sorted(directory.iterdir()):
            if entry.is_dir():
                inner = entry / "session.jsonl"
                sibling = entry.parent / (entry.name + ".jsonl")
                if inner.exists():
                    transcript = inner
                elif sibling.exists():
                    transcript = sibling
                else:
                    continue
                sid = session_id_of(entry.name)
                if not sid:
                    continue
                record = {
                    "client": "pi",
                    "id": sid,
                    "name": entry.name,
                    "path": str(transcript.resolve()),
                    "updated_ms": transcript.stat().st_mtime * 1000,
                }
                found.setdefault(sid, record)
            elif entry.name.endswith(".jsonl"):
                sid = session_id_of(entry.name[: -len(".jsonl")])
                if not sid:
                    continue
                record = {
                    "client": "pi",
                    "id": sid,
                    "name": entry.name[: -len(".jsonl")],
                    "path": str(entry.resolve()),
                    "updated_ms": entry.stat().st_mtime * 1000,
                }
                found.setdefault(sid, record)
    sessions = list(found.values())
    for record in sessions:
        record["title"] = first_user_message(record["path"])
    sessions.sort(key=lambda r: r["updated_ms"], reverse=True)
    return sessions


def to_ms(value) -> int:
    """时间戳：数字就是毫秒；字符串按 ISO 解析（结尾的 Z 也认）。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.datetime.fromisoformat(text)
        except ValueError:
            return 0
        if parsed.tzinfo is None:
            parsed = parsed.astimezone()
        return int(parsed.timestamp() * 1000)
    return 0


def parse_opencode_sessions(payload) -> list:
    """`opencode session list --format json` 的输出。"""
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("sessions") or []
    else:
        items = []
    sessions = []
    for item in items:
        if not isinstance(item, dict):
            continue
        sid = str(
            item.get("id")
            or item.get("sessionID")
            or item.get("sessionId")
            or item.get("session_id")
            or ""
        ).strip()
        if not sid:
            continue
        raw_time = item.get("time")
        time = raw_time if isinstance(raw_time, dict) else {}
        updated = (
            item.get("updatedAt")
            or item.get("updated")
            or time.get("updated")
            or time.get("created")
        )
        sessions.append(
            {
                "client": "opencode",
                "id": sid,
                "title": str(item.get("title") or item.get("name") or ""),
                "updated_ms": to_ms(updated),
            }
        )
    return sessions


def _run_opencode_list(cwd):
    proc = subprocess.run(
        ["opencode", "session", "list", "--format", "json"],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "").strip()[:300])
    return proc.stdout


def opencode_sessions(cwd: str, runner=None) -> tuple:
    """当前目录的 opencode 会话。runner 可以换成假的（单测用）。

    返回 (会话列表, 错误信息)。
    """
    run = runner or _run_opencode_list
    try:
        raw = run(cwd)
    except Exception as exc:
        return [], str(exc)
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        return [], f"opencode 的输出不是 JSON：{exc}"
    return parse_opencode_sessions(payload), ""


# ------------------------------------------------------------------ 跑命令


class CommandFailed(Exception):
    """命令没跑成（超时、找不到可执行文件）。"""

    def __init__(self, message: str, stderr: str = ""):
        super().__init__(message)
        self.stderr = stderr or ""


def _as_text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value or "")


def run_command(argv: list, cwd=None, timeout: int = 1800):
    """跑一条命令。返回 (退出码, stdout, stderr)。

    超时和找不到可执行文件都算失败，抛 CommandFailed。
    """
    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise CommandFailed(f"超时（{timeout}s）", _as_text(exc.stderr)) from exc
    except FileNotFoundError as exc:
        raise CommandFailed(f"找不到命令：{argv[0] if argv else ''}") from exc
    return proc.returncode, proc.stdout, proc.stderr


# ------------------------------------------------------------------ 归档


def archive(path, when=None) -> pathlib.Path:
    """发成功了把待办改名归档：`.buddy-todo.md` → `.buddy-todo.sent-<时间戳>.md`。"""
    src = pathlib.Path(path)
    stamp = (when or datetime.datetime.now()).strftime("%Y%m%d-%H%M%S")
    dst = src.with_name(f"{src.stem}.sent-{stamp}{src.suffix}")
    src.rename(dst)
    return dst


def format_time(ms) -> str:
    """毫秒时间戳 → 本地时间 `2026-10-26 11:59`。"""
    if not ms:
        return "?"
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")
