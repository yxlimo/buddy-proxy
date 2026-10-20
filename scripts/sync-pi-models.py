#!/usr/bin/env python3
"""Update pi's ~/.pi/agent/models.json zen-proxy provider.

Reads live model metadata from the local proxy (/v1/models), then rewrites the
zen-proxy provider entry to:
  - use the anthropic-messages API (needed for thinking-level passthrough)
  - set baseUrl to the proxy root (the Anthropic SDK appends /v1/messages)
  - refresh the model list to what's currently served
  - attach per-model reasoning / contextWindow / maxTokens from proxy metadata

Never prints the API key; it is preserved from the existing config (or taken
from the repo's api-keys.json admin entry on first setup).
"""
import json
import os
import sys
import urllib.request

PROXY = os.environ.get("PROXY_URL", "http://127.0.0.1:6447")
PI_MODELS = os.path.expanduser("~/.pi/agent/models.json")
REPO_KEYS = os.environ.get(
    "REPO_KEYS",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "api-keys.json"),
)


def http_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    with open(PI_MODELS) as f:
        cfg = json.load(f)
    providers = cfg.setdefault("providers", {})
    zen = providers.get("zen-proxy", {})

    # API key: keep existing, else fall back to repo admin key
    api_key = zen.get("apiKey")
    if not api_key:
        with open(REPO_KEYS) as f:
            api_key = json.load(f)["admin"]

    # Fetch live metadata (Anthropic-style x-api-key auth)
    models = http_json(f"{PROXY}/v1/models", {"x-api-key": api_key})["data"]

    new_models = []
    for m in models:
        entry = {"id": m["id"]}
        if m.get("reasoning"):
            entry["reasoning"] = True
        if m.get("context_length"):
            entry["contextWindow"] = m["context_length"]
        if m.get("max_output_tokens"):
            entry["maxTokens"] = m["max_output_tokens"]
        new_models.append(entry)

    providers["zen-proxy"] = {
        "name": zen.get("name", "ZEN Free (local proxy)"),
        "baseUrl": PROXY,  # no /v1 — the SDK appends /v1/messages
        "api": "anthropic-messages",
        "apiKey": api_key,
        "models": new_models,
    }

    # Atomic write; permissions restricted since it holds a key
    tmp = PI_MODELS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, PI_MODELS)

    print(f"zen-proxy updated: {len(new_models)} models, api=anthropic-messages")
    for m in new_models:
        flags = []
        if m.get("reasoning"):
            flags.append("reasoning")
        if m.get("contextWindow"):
            flags.append(f"ctx={m['contextWindow']}")
        if m.get("maxTokens"):
            flags.append(f"out={m['maxTokens']}")
        print(f"  {m['id']:36} {' '.join(flags)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
