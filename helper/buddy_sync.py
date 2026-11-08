#!/usr/bin/env python3
"""把网关公布的模型同步到本机几个 agent 客户端的 provider 配置里。

默认只同步**主路由**：网关那边改了主路由公布的模型，跑一次这个脚本就更新好。

    python3 helper/buddy_sync.py                 # 只同步主路由
    python3 helper/buddy_sync.py --providers     # 主路由 + 各上游分组
    python3 helper/buddy_sync.py --dry-run       # 只看要改什么，不写文件
    python3 helper/buddy_sync.py --check         # 只比对，不写；不一致退出码 1

命令行：
  --gateway URL    网关地址（优先于 BUDDY_GATEWAY 和配置文件）
  --set-gateway URL  把网关地址写进 ~/.config/buddy-helper/config.json
  --api-key KEY    客户端 api key，默认 public（网关跑 public 模式时不校验 key）
  --providers      同时同步各上游分组的 provider（默认不同步）
  --dry-run        只打印要改什么，不写文件
  --check          只比对不写：一致退出码 0，有差异退出码 1
  --keep-legacy    保留 qoder / minimax-code / minimax / token-rhythm 这些老名字

只改这几处：

    $OPENCODE_CONFIG（没设就是 ~/.config/opencode/opencode.jsonc）
        WSL 的 opencode（JSONC）
    ~/.pi/agent/models.json                            WSL 的 pi（JSON）
    /mnt/c/Users/<你>/.config/opencode/opencode.jsonc  Windows 的 opencode（JSONC）

opencode 的配置分几份，深合并、后来的覆盖前面的：远端 .well-known/opencode、
全局 ~/.config/opencode/opencode.json{,c}、OPENCODE_CONFIG 指的那份、项目级
opencode.json{,c} 与 .opencode/、OPENCODE_CONFIG_CONTENT。

全局那份是 nix 管的（插件、MCP、compaction 这些基础设施），模型交给本脚本 ——
写进 OPENCODE_CONFIG 指的那份。那份没有就建，建出来只有 $schema 与 providers：
mcp / plugins 归 nix，不往那儿抄。

主路由的 provider 名字叫 buddy，显示名 Buddy (主路由)：
  opencode  baseURL = {GATEWAY}/v1     package = @ai-sdk/anthropic（客户端自己拼 /messages）
  pi        baseUrl  = {GATEWAY}       api     = anthropic-messages（pi 自己拼 /v1/messages）

模型清单都取自网关：
  主路由      GET {GATEWAY}/v1/models
  上游分组    GET {GATEWAY}/{group}/v1/models

拉不到就明确报出来并跳过 —— 不往客户端里写一份空配置（那会把人家已有的
provider 清空）。别的 provider 一个都不动。
"""
import argparse
import collections
import copy
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import common  # noqa: E402  （同目录，放进 sys.path 之后才能 import）

DEFAULT_API_KEY = "public"

DEFAULT_CONTEXT = 200000
DEFAULT_OUTPUT = 4096

# 主路由的 provider 名字与显示名。
ROOT_NAME = "buddy"
ROOT_LABEL = "Buddy (主路由)"

# 旧的 provider：qoder 是单 provider 的老布局，minimax-code 直连 6448 ——
# 和网关的 minimax 是同一个上游，保留一份就够了。minimax 是中途用过的名字。
# token-rhythm 是直连 tokenrhythm 平台的，现在统一走网关。
# minimax-tokenplan 是另一个上游（官方 API，不是 Code 网关），不动。
LEGACY_PROVIDERS = ["qoder", "minimax-code", "minimax", "token-rhythm"]

EFFORTS = ["low", "medium", "high", "max"]

# pi 的思考档位 → 上游实际有的档位。上游不一定四档齐全（DeepSeek 的思考模式
# 只有 low/high/max），所以按已有的档位映射，而不是照抄。
PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"]

# 三个目标：(显示用的名字, 路径, 是不是 JSONC)
# Windows 那份不写死用户名：WSL 里 Windows 用户名跟 Linux 用户名常常不是
# 同一个，写死一个名字只会写到不存在的路径上 —— 按 /mnt/c/Users 下面实际
# 存在的目录找。
WINDOWS_USERS_ROOT = pathlib.Path("/mnt/c/Users")

# opencode 读配置的地方。模型写进 OPENCODE_CONFIG 指的那份，而不是全局那份：
# 全局那份由 nix 生成（插件、MCP、compaction 这些基础设施），它是只读软链，
# 而且 nix 每次重建都会盖回去。OPENCODE_CONFIG 那份本来就是给本脚本写的 ——
# 没有就建。
OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG"
OPENCODE_SCHEMA = "https://opencode.ai/config.json"

# 一个目标：显示用的名字、路径、是不是 JSONC、没有时要不要建、是不是归本脚本管。
# exclusive 的意思是「这份文件只放 providers（外加 $schema）」：别的键不抄过来。
Target = collections.namedtuple("Target", "label path is_jsonc create exclusive")


def windows_opencode_config() -> pathlib.Path | None:
    """Windows 那份 opencode 配置。没有就返回 None（那一处跳过）。"""
    if not WINDOWS_USERS_ROOT.is_dir():
        return None
    for entry in sorted(WINDOWS_USERS_ROOT.iterdir()):
        candidate = entry / ".config" / "opencode" / "opencode.jsonc"
        if candidate.is_file():
            return candidate
    return None


def opencode_config_path() -> tuple:
    """WSL 的 opencode 目标：OPENCODE_CONFIG 指的那份，否则全局那份。

    返回 (路径, 是不是 OPENCODE_CONFIG 指的那份)。环境变量里可能有 ~，
    要展开；相对路径按当前目录算成绝对的，免得报告里写个相对路径看着像在别处。
    """
    raw = os.environ.get(OPENCODE_CONFIG_ENV, "").strip()
    if raw:
        path = pathlib.Path(raw).expanduser()
        if not path.is_absolute():
            path = pathlib.Path.cwd() / path
        return path, True
    return pathlib.Path.home() / ".config/opencode/opencode.jsonc", False


def targets() -> list:
    """这次要同步的几处：WSL 的 opencode、WSL 的 pi，Windows 的 opencode（有才有）。"""
    opencode_path, from_env = opencode_config_path()
    out = [
        Target(
            "opencode (WSL, OPENCODE_CONFIG)" if from_env else "opencode (WSL)",
            opencode_path,
            True,
            True,     # 没有就建：这份文件本来就该由本脚本生成，跳过等于永远不生效
            from_env, # OPENCODE_CONFIG 那份只放 providers（+ $schema），mcp / plugins 归 nix
        ),
        Target("pi (WSL)", pathlib.Path.home() / ".pi/agent/models.json", False, False, False),
    ]
    windows = windows_opencode_config()
    if windows:
        # Windows 那份是别人（用户自己）维护的：没有就不写，也不动别的键。
        out.append(Target("opencode (Windows)", windows, True, False, False))
    return out

# 真正答话的网关（拉到了清单的那个）与写进客户端的 api key。
GATEWAY = ""
API_KEY = DEFAULT_API_KEY


def sort_efforts(efforts: list) -> list:
    """档位按强弱排，不按字母（字母序会把 high 排到 low 前面）。

    比对两边都过一遍这个排序：网关报的先后与配置里写的先后不该算差异。
    """
    rank = {level: i for i, level in enumerate(PI_LEVELS)}
    return sorted(efforts, key=lambda e: (rank.get(e, len(PI_LEVELS)), e))


def level_map(efforts: list) -> dict:
    """把 pi 的思考档位映到上游有的档位上。"""
    if not efforts:
        return dict.fromkeys(PI_LEVELS)
    if sorted(efforts) == sorted(EFFORTS):
        return {"minimal": None, "low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "max"}
    # 档位要按强弱排，不是按字母（"high" 在字母上排在 "low" 前面）。
    rank = {"low": 1, "medium": 2, "high": 3, "xhigh": 4, "max": 5}
    ordered = sorted(efforts, key=lambda e: rank.get(e, 99))
    lowest = ordered[0]
    highest = ordered[-1]
    middle = ordered[len(ordered) // 2]
    return {
        "minimal": lowest,
        "low": lowest,
        "medium": middle,
        "high": middle,
        "xhigh": middle,
        "max": highest,
    }


# ------------------------------------------------------------------ 模型清单


def fetch_providers(gateway: str) -> tuple:
    """问网关现在有哪些 provider。

    返回 (清单, 错误信息)。清单是 [(唯一 id, 显示名)] —— 唯一 id 是路径里
    那一段，也是客户端里那个 provider 的名字；显示名是面板上用户给它起的。

    清单从 /health 拿：那个接口是公开的（面板自己的令牌只管面板），里面
    已经带了每个 provider 的这两个值。用户自己在面板上加的 provider 也在
    里面 —— 写死一份表就会漏掉新的。
    """
    url = f"{gateway}/health"
    data, err = common.http_get_json(url)
    if err:
        return [], err
    if not isinstance(data, dict):
        return [], f"{url} 返回的不是 JSON 对象"

    rows = data.get("providers")
    if not isinstance(rows, list) or not rows:
        return [], f"{url} 没有 providers 那一段 —— 网关是旧的？"

    out = []
    for row in rows:
        pid = str(row.get("id") or "").strip()
        if not pid:
            continue
        name = str(row.get("name") or "").strip() or pid
        out.append((pid, name))
    return out, ""


def fetch_models(gateway: str, base_path: str) -> tuple:
    """问网关某个路径现在有哪些模型。

        返回 (模型表, 错误信息)。模型表是 (id, 显示名, 档位, 上下文, 输出上限) 的列表。
    拉不到就返回 (None, 错误信息) —— 不用内置表兜底，写进去的是旧清单，
    比写空更麻烦。

    档位那一格：网关没给 `effort_options` 就是 None（= 这套模型没有档位），
    不是空列表。比对时要分清「没有这一格」和「有几个档位」，写配置时两者一样。
    """
    url = f"{gateway}{base_path}/v1/models"
    data, err = common.http_get_json(url)
    if err:
        return None, err
    if not isinstance(data, dict):
        return None, f"{url} 返回的不是 JSON 对象"

    out = []
    for m in data.get("data", []):
        mid = m.get("id") or ""
        if not mid:
            continue
        efforts = m.get("effort_options")
        if not isinstance(efforts, list) or not efforts:
            efforts = None
        out.append(
            (
                mid,
                m.get("display_name") or mid,
                efforts,
                int(m.get("context_window") or DEFAULT_CONTEXT),
                int(m.get("max_output_tokens") or DEFAULT_OUTPUT),
            )
        )
    return out, None


def collect_sources(gateway: str, with_providers: bool) -> tuple:
    """要去写的 provider 清单。

    返回 (sources, failures)：
      sources  = [(provider 名, 显示名, base 路径, 模型表)]
      failures = [(说明, 错误)]，拉不到的都在这里报出来
    """
    sources = []
    failures = []

    models, err = fetch_models(gateway, "")
    if err:
        failures.append(("主路由", err))
    elif not models:
        failures.append(("主路由", f"{gateway}/v1/models 返回了空清单 —— 不写 buddy，客户端里现有的留着"))
    else:
        sources.append((ROOT_NAME, ROOT_LABEL, "", models))

    if with_providers:
        providers, err = fetch_providers(gateway)
        if err:
            failures.append(("上游清单", err))
        else:
            for pid, label in providers:
                models, err = fetch_models(gateway, f"/{pid}")
                if err:
                    failures.append((f"上游 {pid}", err))
                    continue
                if not models:
                    continue
                # 客户端里那个 provider 的名字就是唯一 id。
                sources.append((pid, label, f"/{pid}", models))

    return sources, failures


# ------------------------------------------------------------- provider 形状


def opencode_provider(models: list, name: str, label: str) -> dict:
    """一个 provider 的 opencode 形状。"""
    entries = {}
    for mid, display, efforts, context, output in models:
        reasoning = {"supported": True}
        if efforts:
            # opencode 据此生成档位变体，用 -m provider/model#high 选。
            # 用模型自己有的档位，别把上游没有的也报上去。
            reasoning["effort"] = efforts
        entries[mid] = {
            "name": display,
            "limit": {"context": context, "output": output},
            "capabilities": {
                "tools": True,
                "input": ["text", "image"],
                "output": ["text"],
                "reasoning": reasoning,
            },
        }
    return {
        "name": label,
        "package": "@ai-sdk/anthropic",
        "settings": {
            # Anthropic 方言：baseURL 带 /v1，客户端自己拼 /messages
            "baseURL": f"{GATEWAY}{name}/v1",
            "apiKey": API_KEY,
        },
        "models": entries,
    }


def pi_provider(models: list, name: str, label: str) -> dict:
    """一个 provider 的 pi 形状。"""
    entries = []
    for mid, display, efforts, context, output in models:
        entry = {
            "id": mid,
            "name": display,
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": context,
            "maxTokens": output,
            "thinkingLevelMap": level_map(efforts),
        }
        if not efforts:
            # 固定模型不能调思考强度，pi 不该生成档位变体。
            entry["thinkingLevelMap"] = dict.fromkeys(PI_LEVELS)
        entries.append(entry)
    return {
        "name": label,
        # Anthropic 方言：pi 自己拼 /v1/messages，所以 baseUrl 是根地址
        "baseUrl": f"{GATEWAY}{name}",
        "api": "anthropic-messages",
        "apiKey": API_KEY,
        # 让 pi 发 output_config.effort（档位原样），而不是把档位压成
        # 一个预算数字 —— 压成数字的话，顶档（max）在 Anthropic 方言里
        # 就分不出来了。
        #
        # sendSessionAffinityHeaders 让 pi 把会话 id 放在 x-session-id
        # 头里 —— 网关靠它知道这是哪个会话的请求。
        "compat": {"forceAdaptiveThinking": True, "sendSessionAffinityHeaders": True},
        "models": entries,
    }


# ----------------------------------------------------------------- JSONC 读写


def _find_comment(line: str) -> int:
    """行里 `//` 注释的起始位置（字符串里的不算）。没有就返回 -1。"""
    in_string = False
    escape = False
    for i, ch in enumerate(line):
        if escape:
            escape = False
            continue
        if ch == "\\":
            if in_string:
                escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if ch == "/" and not in_string and i + 1 < len(line) and line[i + 1] == "/":
            return i
    return -1


def _code_only(line: str) -> str:
    """把行里的字符串内容换成空格（算括号深度时用）。"""
    out = []
    in_string = False
    escape = False
    for ch in line:
        if escape:
            escape = False
            out.append(" ")
            continue
        if ch == "\\":
            if in_string:
                escape = True
            out.append(" ")
            continue
        if ch == '"':
            in_string = not in_string
            out.append(" ")
            continue
        out.append(" " if in_string else ch)
    return "".join(out)


def _key_of(stripped: str) -> str:
    """这一行是不是 `"键":` 开头？是的话返回键名，否则返回空串。"""
    if not stripped.startswith('"'):
        return ""
    parts = stripped.split('"', 2)
    if len(parts) < 3:
        return ""
    # 键名在第一对引号里（split 后是第 2 段），后面得跟冒号。
    if not parts[2].lstrip().startswith(":"):
        return ""
    return parts[1]


def parse_json(text: str, where: str) -> dict:
    """解析 JSON；坏了就说清是哪一份，不要让 traceback 淹掉重点。"""
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{where} 不是合法 JSON：{exc}") from None


def load_jsonc(path: pathlib.Path) -> tuple:
    """读 JSONC：整行的注释摘出来，记住它们属于哪个键。

    opencode 的配置是 JSONC，注释是给人看的 —— 写回去的时候要留着。

    返回 (配置, 整行注释, 行尾注释)：
      整行注释 = [(顶层键, [注释行...])]
      行尾注释 = {顶层键: 注释文本}
    """
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()

    code_lines = []       # 去掉注释后的行（整行注释留空行）
    full_comments = []    # (行号, 注释文本)
    trail_comments = {}   # 行号 -> 注释文本
    for idx, line in enumerate(lines):
        pos = _find_comment(line)
        if pos < 0:
            code_lines.append(line)
            continue
        code, comment = line[:pos], line[pos:]
        if code.strip() == "":
            # 整行注释：整行留着（含缩进），写回去时原样放回。
            full_comments.append((idx, line))
            code_lines.append("")
        else:
            trail_comments[idx] = comment
            code_lines.append(code)

    cfg = parse_json("\n".join(code_lines), str(path))

    # 每行属于哪个顶层键 —— 注释按这个归属。
    owners = []
    depth = 0
    current = ""
    for line in code_lines:
        stripped = line.strip()
        key = _key_of(stripped)
        if depth == 1 and key:
            current = key
        owners.append(current)
        code = _code_only(line)
        depth += code.count("{") + code.count("[")
        depth -= code.count("}") + code.count("]")

    # 整行注释挂到它后面那个顶层键上。
    full_by_line = {}
    for idx, comment in full_comments:
        full_by_line[idx] = comment
    comments = []
    pending = []
    for idx, _line in enumerate(code_lines):
        if idx in full_by_line:
            pending.append(full_by_line[idx])
            continue
        owner = owners[idx]
        if pending and owner:
            comments.append((owner, pending))
            pending = []
    if pending:
        comments.append(("", pending))

    trailing = {}
    for idx, comment in trail_comments.items():
        owner = owners[idx]
        if not owner:
            continue
        trailing.setdefault(owner, []).append(comment)

    return cfg, comments, trailing


def _body(value) -> str:
    """把一个值按 opencode 的缩进排出来。"""
    body = json.dumps(value, ensure_ascii=False, indent=2)
    parts = body.splitlines()
    if len(parts) == 1:
        return parts[0]
    # 第一行紧跟在 ": " 后面，后面的行往下缩两格。
    return parts[0] + "\n" + "\n".join("  " + line for line in parts[1:])


def dump_jsonc(cfg: dict, comments: list, trailing: dict) -> str:
    """把配置写回去，注释放回它们原来的键前面。"""
    by_key = {}
    for key, lines in comments:
        by_key.setdefault(key, []).extend(lines)
    out = []
    keys = list(cfg)
    for i, key in enumerate(keys):
        value = cfg[key]
        out.extend(by_key.get(key, []))
        # 最后一个键后面不留逗号。
        comma = "" if i == len(keys) - 1 else ","
        line = f"  {json.dumps(key, ensure_ascii=False)}: {_body(value)}{comma}"
        tails = trailing.get(key)
        if tails:
            line += "  " + " ".join(t.strip() for t in tails)
        out.append(line)
    out.extend(by_key.get("", []))
    return "{\n" + "\n".join(out) + "\n}\n"


# ------------------------------------------------------------------- 打补丁


def _diff_providers(before: dict, after: dict) -> tuple:
    """provider 层面的差异：新增了谁、删了谁、谁的内容变了。"""
    added = [k for k in after if k not in before]
    removed = [k for k in before if k not in after]
    changed = [k for k in after if k in before and after[k] != before[k]]
    return added, removed, changed


def _apply(providers: dict, sources: list, shape, keep_legacy: bool) -> list:
    """把 sources 写进 providers，顺手清掉老名字。返回被删掉的 provider。"""
    removed = []
    if not keep_legacy:
        for legacy in LEGACY_PROVIDERS:
            if legacy in providers:
                providers.pop(legacy)
                removed.append(legacy)

    for name, label, base_path, models in sources:
        providers[name] = shape(models, base_path, label)
    return removed


def patch_target(target, sources: list, dry_run: bool, keep_legacy: bool) -> dict:
    """同步一个目标。返回这次改了什么。

    target.create    没有这个文件就建一个
    target.exclusive 这份文件归本脚本管：只写 providers（外加 $schema），别的键不抄
    """
    label, path, is_jsonc = target.label, target.path, target.is_jsonc
    result = {
        "label": label,
        "path": path,
        "status": "ok",
        "added": [],
        "removed": [],
        "changed": [],
        "legacy": [],
        "created": False,
    }
    existed = path.exists()
    cfg: dict
    if not existed:
        if not target.create:
            result["status"] = "missing"
            return result
        # 新建的文件：带 $schema，别的键没有。
        cfg = {"$schema": OPENCODE_SCHEMA}
        comments, trailing = [], {}
        old_text = ""
    else:
        try:
            if is_jsonc:
                cfg, comments, trailing = load_jsonc(path)
                old_text = path.read_text(encoding="utf-8")
            else:
                old_text = path.read_text(encoding="utf-8")
                cfg = parse_json(old_text, str(path))
                comments, trailing = [], {}
        except OSError as exc:
            result["status"] = "error"
            result["error"] = f"读不出来：{exc}"
            return result

    if target.exclusive:
        # 这份文件只放 providers（外加 $schema）：mcp / plugins 那些归 nix，
        # 不往这儿抄，也不管原文件里有什么。
        old_providers = cfg.get("providers")
        before = copy.deepcopy(old_providers) if isinstance(old_providers, dict) else {}
        providers = {}
        cfg = {"$schema": OPENCODE_SCHEMA, "providers": providers}
        comments, trailing = [], {}
    else:
        providers = cfg.setdefault("providers", {})
        before = copy.deepcopy(providers)

    if is_jsonc:
        removed = _apply(providers, sources, opencode_provider, keep_legacy)
        # 老布局（opencode 的 provider 键）里的老名字也清掉。
        legacy_ns = cfg.get("provider")
        if isinstance(legacy_ns, dict) and not keep_legacy:
            for legacy in LEGACY_PROVIDERS:
                if legacy in legacy_ns:
                    legacy_ns.pop(legacy)
                    removed.append(f"provider/{legacy}")
    else:
        removed = _apply(providers, sources, pi_provider, keep_legacy)

    result["legacy"] = removed
    result["added"], result["removed"], result["changed"] = _diff_providers(before, providers)
    result["created"] = not existed

    if is_jsonc:
        new_text = dump_jsonc(cfg, comments, trailing)
    else:
        new_text = json.dumps(cfg, ensure_ascii=False, indent=2)
        # 原文件末尾有没有换行就跟着有没有 —— 别为了一个换行制造假差异。
        if old_text.endswith("\n"):
            new_text += "\n"

    result["changed_file"] = new_text != old_text
    if result["changed_file"] and not dry_run:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(new_text, encoding="utf-8")
        except OSError as exc:
            # 写不进去（比如全局那份是 nix 的只读软链）：报清楚，别让 traceback 淹掉重点。
            result["status"] = "error"
            result["error"] = f"写不进去：{exc}"
    return result


def report(result: dict, dry_run: bool) -> None:
    label, path = result["label"], result["path"]
    if result["status"] == "missing":
        print(f"  {label}  {path}")
        print("    没有这个文件，跳过")
        return
    if result["status"] == "error":
        print(f"  {label}  {path}")
        print(f"    !! {result.get('error', '写失败了')}")
        return
    added, removed, changed = result["added"], result["removed"], result["changed"]
    if not result["changed_file"]:
        print(f"  {label}  {path}")
        print("    无变化")
        return
    verb = "要改" if dry_run else "已改"
    print(f"  {label}  {path}")
    if result.get("created"):
        print(f"    {'要建' if dry_run else '已建'}：新文件")
        # 新建的文件谈不上「改」：下面几行直接说做了什么。
        prefix = ""
    else:
        prefix = f"{verb}："
    if added:
        print(f"    {prefix}新增 provider {len(added)} 个 — {', '.join(added)}")
    if removed:
        print(f"    {prefix}删除 provider {len(removed)} 个 — {', '.join(removed)}")
    if changed:
        print(f"    {prefix}更新 provider {len(changed)} 个 — {', '.join(changed)}")
    for legacy in result["legacy"]:
        print(f"    {prefix}清掉老名字 {legacy}")


# ------------------------------------------------------------------ 比对（--check）


def canonical_gateway_models(models: list) -> dict:
    """网关的模型表 → {模型 id: {字段: 值}}（字段名用网关那套）。

    档位排过序：网关给的顺序不该算差异（opencode 与 pi 侧都排过）。
    没有档位是 None，不是 [] —— 「本地没有这一格」也是 None，两边都空
    不该报差异。
    """
    out = {}
    for mid, display, efforts, context, output in models:
        out[mid] = {
            "display_name": display,
            "context_window": context,
            "max_output_tokens": output,
            "efforts": sort_efforts(efforts) if efforts else None,
        }
    return out


def canonical_opencode_models(cfg: dict, provider: str) -> dict:
    """opencode 配置里那个 provider 的模型 → 同一套字段名。"""
    out = {}
    providers = cfg.get("providers") or {}
    entry = providers.get(provider) or {}
    models = entry.get("models") or {}
    if not isinstance(models, dict):
        return out
    for mid, model in models.items():
        limit = (model or {}).get("limit") or {}
        reasoning = ((model or {}).get("capabilities") or {}).get("reasoning") or {}
        effort = reasoning.get("effort")
        out[mid] = {
            "display_name": (model or {}).get("name"),
            "context_window": limit.get("context"),
            "max_output_tokens": limit.get("output"),
            # 写进去的是模型自己的档位，没写这一格就是没有档位。
            "efforts": sort_efforts(effort) if isinstance(effort, list) and effort else None,
        }
    return out


def canonical_pi_models(cfg: dict, provider: str) -> dict:
    """pi 配置里那个 provider 的模型 → 同一套字段名。"""
    out = {}
    providers = cfg.get("providers") or {}
    entry = providers.get(provider) or {}
    models = entry.get("models") or []
    if not isinstance(models, list):
        return out
    for model in models:
        if not isinstance(model, dict):
            continue
        mid = model.get("id")
        if not mid:
            continue
        out[mid] = {
            "display_name": model.get("name"),
            "context_window": model.get("contextWindow"),
            "max_output_tokens": model.get("maxTokens"),
            # pi 没有「档位表」，只有一张「请求档位 → 上游档位」的映射。
            # 能问到的档位就是映射值里出现过的那些（去重排序）；全是 None
            # 的映射（固定档/不能调）等于没有档位。
            "efforts": _pi_efforts(model.get("thinkingLevelMap")),
        }
    return out


def _pi_efforts(levels):
    # 同一档位会被好几个 pi 档位指到（high、xhigh 都映到 high），映射值去重
    # 之后剩下的才是「这套模型能用的档位」。
    if not isinstance(levels, dict):
        return None
    offered = [v for v in dict.fromkeys(levels.values()) if isinstance(v, str) and v]
    return sort_efforts(offered) or None


def compare_models(gateway_models: dict, local_models: dict) -> list:
    """网关的模型和本地的比一遍。返回差异的文案列表。

    文案：`模型 字段: 网关 X / 本地 Y`（字段不同时），另有缺模型/多模型两行。
    档位按排序后的清单比，文案里用逗号连起来（`网关 low,high,max / 本地 high`）。
    """
    diffs = []
    for mid in sorted(gateway_models):
        gw = gateway_models[mid]
        local = local_models.get(mid)
        if local is None:
            diffs.append(f"{mid} model: 网关有 / 本地没有")
            continue
        for field in ("display_name", "context_window", "max_output_tokens", "efforts"):
            want = gw.get(field)
            have = local.get(field)
            if want == have:
                continue
            if field == "efforts":
                want = ",".join(want) if want else None
                have = ",".join(have) if have else None
            diffs.append(f"{mid} {field}: 网关 {want} / 本地 {have}")
    for mid in sorted(local_models):
        if mid not in gateway_models:
            diffs.append(f"{mid} model: 网关没有 / 本地有")
    return diffs


def pi_expectations(gateway_models: dict) -> dict:
    """把网关的档位换成 pi 那边「应该写成什么样」。

    pi 没有档位表，只有一张 6 槽到上游档位的映射，而这张映射是有损的：
    五档（low/medium/high/xhigh/max）压成三个值，三档与五档写出去可能
    一模一样。所以 pi 侧要比的是「按现在的 level_map 算出来该是什么」，
    不是网关的原始档位 —— 否则「映射有损」会一直显示成「配置过期」，
    而那种差异无从修。

    报什么、不报什么：
      - 网关档位变了、映射后也跟着变 → 报（真漂移）
      - 网关档位变了、映射后一样 → 不报（pi 表达不出这个差别）
      - level_map 自己改了规则 → 报（配置相对新代码过期了）
    """
    out = {}
    for mid, fields in gateway_models.items():
        mapped = [v for v in dict.fromkeys(level_map(fields.get("efforts") or []).values()) if v]
        out[mid] = {**fields, "efforts": sort_efforts(mapped) or None}
    return out


def check_target(label: str, path: pathlib.Path, is_jsonc: bool, models: list) -> list:
    """比对一个目标文件。返回这个文件上的差异文案。"""
    if not path.exists():
        return []
    gateway = canonical_gateway_models(models)
    if is_jsonc:
        cfg, _comments, _trailing = load_jsonc(path)
        local = canonical_opencode_models(cfg, ROOT_NAME)
    else:
        cfg = parse_json(path.read_text(encoding="utf-8"), str(path))
        local = canonical_pi_models(cfg, ROOT_NAME)
        # pi 是透传不了的那一侧：比映射后的预期，不比原始档位。
        gateway = pi_expectations(gateway)
    return compare_models(gateway, local)


def run_check(gateway: str, models: list) -> int:
    """只比对不写。返回退出码：0 一致，1 有差异。"""
    print(f"网关: {gateway}")
    print("模式: 只比对，不写文件")
    print("")
    print("结果：")
    total = 0
    for target in targets():
        print(f"  {target.label}  {target.path}")
        if not target.path.exists():
            print("    没有这个文件，跳过")
            continue
        diffs = check_target(target.label, target.path, target.is_jsonc, models)
        if not diffs:
            print("    一致")
            continue
        total += len(diffs)
        for line in diffs:
            print(f"    {line}")
    print("")
    if total:
        print(f"check：{total} 处不一致（网关改了模型，客户端配置过期了）。")
        return 1
    print("check：一致。")
    return 0


# ------------------------------------------------------------------- 入口


def main(argv: list) -> int:
    global GATEWAY, API_KEY

    parser = argparse.ArgumentParser(description="把网关公布的模型同步到客户端的 provider 配置")
    parser.add_argument("--gateway", default=None, help="网关地址（优先于 BUDDY_GATEWAY 和配置文件）")
    parser.add_argument("--set-gateway", default=None, metavar="URL", help="把网关地址写进 ~/.config/buddy-helper/config.json")
    parser.add_argument("--api-key", default=os.environ.get("ROUTER_API_KEY", DEFAULT_API_KEY), help="客户端 api key（默认 public）")
    parser.add_argument("--providers", action="store_true", help="同时同步各上游分组的 provider")
    parser.add_argument("--dry-run", action="store_true", help="只打印要改什么，不写文件")
    parser.add_argument("--check", action="store_true", help="只比对不写：一致退出码 0，有差异退出码 1")
    parser.add_argument("--keep-legacy", action="store_true", help="保留 qoder / minimax-code / minimax / token-rhythm 这些老名字")
    args = parser.parse_args(argv)

    if args.set_gateway:
        path = common.set_gateway(args.set_gateway)
        print(f"网关地址写到 {path}")
        return 0

    API_KEY = args.api_key

    # 网关地址：命令行 > 环境变量 > 配置文件；三个都没有就报错。
    gateway, gateway_err = common.resolve_gateway(args.gateway)
    if not gateway:
        print(gateway_err, file=sys.stderr)
        return common.EXIT_NO_GATEWAY

    sources, failures = collect_sources(gateway, args.providers)
    for what, err in failures:
        print(f"!! {what}：{err}", file=sys.stderr)

    if not sources:
        print("一个模型清单都没拉到，什么都不改。", file=sys.stderr)
        return 1
    GATEWAY = gateway

    if args.check:
        return run_check(GATEWAY, sources[0][3])

    print(f"网关: {GATEWAY}")
    print(f"模式: {'主路由 + 上游分组' if args.providers else '只同步主路由'}"
          f"{'（dry-run，不写文件）' if args.dry_run else ''}")
    print(f"要写的 provider: {', '.join(s[0] for s in sources)}")
    print("")

    results = []
    for target in targets():
        results.append(patch_target(target, sources, args.dry_run, args.keep_legacy))

    print("结果：")
    for result in results:
        report(result, args.dry_run)

    changed = [r for r in results if r.get("changed_file")]
    errors = [r for r in results if r.get("status") == "error"]
    written = [r for r in changed if r.get("status") != "error"]
    print("")
    if args.dry_run:
        print(f"dry-run：{len(changed)} 个文件待改，没有写入。")
    else:
        print(f"写了 {len(written)} 个文件，其余没动。")
    if errors:
        print(f"有 {len(errors)} 处没写进去（上面报了的那些）。")
    return 1 if (failures or errors) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
