#!/usr/bin/env python3
"""把 Qoder 接到 opencode 和 pi 的客户端配置里。

两个客户端都走 NAS 上的统一入口（router，6450）：请求用 Anthropic 方言，
模型名用裸名，router 按目录自己认上游（Qoder 优先，认不出再找 MiniMax）。

环境变量：
  ROUTER_URL      router 地址，默认 http://192.168.50.4:6450
  ROUTER_API_KEY  客户端 api key。router 默认跑 public 模式（不校验 key），
                  所以默认填 "public"；只有开了 REQUIRE_API_KEY 才需要真 key。
"""
import json
import os
import pathlib
import urllib.request

ROUTER = os.environ.get("ROUTER_URL", "http://192.168.50.4:6450").rstrip("/")
API_KEY = os.environ.get("ROUTER_API_KEY", "public")

CONTEXT = 200000
OUTPUT = 4096

# Qoder 网关认的是 model key，不是显示名。实测（api2-v2.qoder.sh）只接受这 8 个，
# 其余返回 invalid_model_error。括号里是网关回显的实际后端。
#
# 下面是内置兜底表；真实清单以 router 的 /v1/models 为准（下面会先拉一次），
# 源表在 lib/qoder-models.ts。全球区只列新协议能服务的 6 个 —— 老协议那批
# （版本锁定的模型）被上游限流/额度卡住，不该出现在列表里。
FALLBACK_GLOBAL = [
    ("auto", "Auto (Qoder qwen3-coder-plus)", True),
    ("qwen3.7-plus", "Qwen3.7-Plus (bailian)", False),
    ("kimi-k2.8-preview", "Kimi-K2.8-Preview", False),
    ("glm-5.3", "GLM-5.3", False),
    ("deepseek-v4-pro", "DeepSeek-V4-Pro", False),
    ("minimax-m3.1-flash", "MiniMax-M3.1-Flash (→ M2.5)", False),
]

# 中国区走老协议，能多认出几个版本锁定的模型（deepseek-flash 在排队，不列）。
FALLBACK_CN = [
    ("auto", "Auto (Qoder 中国区)", True),
    ("qwen3.7-plus", "Qwen3.7-Plus (中国区)", False),
    ("kimi-k2.8-preview", "Kimi-K2.8-Preview (中国区)", False),
    ("glm-5.3", "GLM-5.3 (中国区)", False),
    ("deepseek-v4-pro", "DeepSeek-V4-Pro (中国区)", False),
    ("minimax-m3.1-flash", "MiniMax-M3.1-Flash (中国区)", False),
    ("qwen3.8-flash", "Qwen3.8-Flash (中国区)", False),
    ("qwen3.8-max", "Qwen3.8-Max (中国区)", False),
    ("qwen3.7-max", "Qwen3.7-Max (中国区)", False),
    ("kimi-k3", "Kimi-K3 (中国区)", False),
    ("glm-5.3-flash", "GLM-5.3-Flash (中国区)", False),
    ("cantus", "Cantus (中国区)", False),
    ("sonus", "Sonus (中国区)", False),
]

FALLBACK_MODELS = FALLBACK_GLOBAL + [(f"cn-{i}", n, t) for i, n, t in FALLBACK_CN]

# 思考等级。只对 tier 型模型（auto）有意义 —— 固定模型不能调思考强度。
EFFORTS = ["low", "medium", "high", "max"]


def fetch_models() -> list:
    """Ask the router which Qoder models it serves right now.

    The router lists the two regions with different prefixes: `qoder/` for the
    global account, `qoder-cn/` for the Chinese one. A client model id cannot
    contain a slash, so the CN ones become `cn-<id>`.
    """
    try:
        with urllib.request.urlopen(f"{ROUTER}/v1/models?dialect=anthropic", timeout=15) as r:
            data = json.load(r)
    except Exception as exc:  # router down, or the network is not there
        print(f"  (router 不可达：{exc}，用内置表)")
        return FALLBACK_MODELS

    out = []
    for m in data.get("data", []):
        mid = m.get("id", "")
        if mid.startswith("qoder-cn/"):
            out.append(
                (
                    f"cn-{mid[len('qoder-cn/'):]}",
                    f"{m.get('display_name') or mid} (中国区)",
                    bool(m.get("effort_options")),
                )
            )
        elif mid.startswith("qoder/"):
            out.append((mid[len("qoder/"):], m.get("display_name") or mid, bool(m.get("effort_options"))))
    return out or FALLBACK_MODELS


ALL = fetch_models()


def patch_opencode() -> None:
    p = pathlib.Path.home() / ".config/opencode/opencode.jsonc"
    cfg = json.loads(p.read_text())
    providers = cfg.setdefault("providers", {})

    models = {}
    for mid, name, is_tier in ALL:
        reasoning = {"supported": True}
        if is_tier:
            # opencode 据此生成 low/medium/high/max 变体，用 -m provider/model#high 选
            reasoning["effort"] = EFFORTS
        entry = {
            "name": name,
            "limit": {"context": CONTEXT, "output": OUTPUT},
            "capabilities": {
                "tools": True,
                "input": ["text", "image"],
                "output": ["text"],
                "reasoning": reasoning,
            },
        }
        models[mid] = entry

    providers["qoder"] = {
        "name": "Qoder (NAS router)",
        "package": "@ai-sdk/anthropic",
        "settings": {
            # Anthropic 方言：baseURL 带 /v1，客户端自己拼 /messages
            "baseURL": f"{ROUTER}/v1",
            "apiKey": API_KEY,
        },
        "models": models,
    }
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
    print(f"opencode: added provider 'qoder' with {len(models)} models")


def patch_pi() -> None:
    p = pathlib.Path.home() / ".pi/agent/models.json"
    cfg = json.loads(p.read_text())
    providers = cfg.setdefault("providers", {})

    models = []
    for mid, name, is_tier in ALL:
        entry = {
            "id": mid,
            "name": name,
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": CONTEXT,
            "maxTokens": OUTPUT,
            "thinkingLevelMap": {
                "minimal": None,
                "low": "low",
                "medium": "medium",
                "high": "high",
                "max": "max",
            },
        }
        if not is_tier:
            # 固定模型不能调思考强度，pi 不该生成档位变体。
            entry["thinkingLevelMap"] = {
                "minimal": None,
                "low": None,
                "medium": None,
                "high": None,
                "max": None,
            }
        models.append(entry)

    providers["qoder"] = {
        "name": "Qoder (NAS router)",
        # Anthropic 方言：pi 自己拼 /v1/messages，所以 baseUrl 是根地址
        "baseUrl": ROUTER,
        "api": "anthropic-messages",
        "apiKey": API_KEY,
        "models": models,
    }
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
    print(f"pi: added provider 'qoder' with {len(models)} models")


if __name__ == "__main__":
    patch_opencode()
    patch_pi()
