#!/usr/bin/env python3
"""列出 opencode web UI 里需要开启的模型，并生成一次性开启的脚本。

opencode v2 的 web 界面把"模型选择器里显示哪些模型"记在浏览器的
localStorage 里（键 `opencode.global.dat:model`），不在配置文件里。所以：

  * 终端版 opencode（TUI）不受影响 —— 它的模型选择器另外有 Favorites / Recent
  * 每个浏览器各自一份 —— 换浏览器要重做
  * 自定义 provider 的模型默认不显示，得在 "Manage models" 里打开

这个脚本读本机的 opencode 配置，列出所有自定义 provider 的模型，并生成一段
可以粘进浏览器控制台（DevTools → Console）的代码，一次全开。
"""

import json
import pathlib
import sys

CONFIG = pathlib.Path.home() / ".config/opencode/opencode.jsonc"

# opencode 自带的 provider，它们的模型在 web UI 里本来就可见。
BUILTIN = {
    "opencode",
    "anthropic",
    "openai",
    "openrouter",
    "google",
    "google-vertex",
    "google-vertex-anthropic",
    "azure",
    "bedrock",
    "openai-compatible",
    "github-copilot",
    "ai-gateway",
    "vercel-ai-gateway",
    "deepseek",
    "modelsdev",
}


def load_config() -> dict:
    return json.loads(CONFIG.read_text())


def custom_models(config: dict) -> list[tuple[str, str]]:
    providers = config.get("provider") or config.get("providers") or {}
    out: list[tuple[str, str]] = []
    for pid, provider in providers.items():
        if pid in BUILTIN:
            continue
        models = provider.get("models") or {}
        if isinstance(models, dict):
            for mid in models:
                out.append((pid, mid))
        else:
            for m in models:
                out.append((pid, m.get("id", "")))
    return sorted(out)


def snippet(models: list[tuple[str, str]]) -> str:
    entries = ",\n".join(
        f'  {{providerID: {json.dumps(pid)}, modelID: {json.dumps(mid)}, visibility: "show"}}'
        for pid, mid in models
    )
    return f"""(() => {{
  const KEY = 'opencode.global.dat:model';
  const wanted = [
{entries}
  ];
  let cur = {{ user: [], recent: [], variant: {{}} }};
  try {{ cur = JSON.parse(localStorage.getItem(KEY) || 'null') || cur; }} catch {{}}
  const key = (u) => u.providerID + '/' + u.modelID;
  const map = new Map((cur.user || []).map((u) => [key(u), u]));
  for (const u of wanted) map.set(key(u), u);
  cur.user = [...map.values()];
  localStorage.setItem(KEY, JSON.stringify(cur));
  location.reload();
  console.log('enabled', wanted.length, 'models');
}})()"""


def main() -> None:
    only: list[str] = []
    args = sys.argv[1:]
    if "--provider" in args:
        i = args.index("--provider")
        only = [p.strip() for p in args[i + 1].split(",") if p.strip()]

    config = load_config()
    models = custom_models(config)
    if only:
        models = [(pid, mid) for pid, mid in models if pid in only]
    if not models:
        print("配置里没有匹配的自定义 provider 模型。")
        return
    print(f"自定义 provider 共 {len(models)} 个模型：\n")
    by_provider: dict[str, list[str]] = {}
    for pid, mid in models:
        by_provider.setdefault(pid, []).append(mid)
    for pid, mids in by_provider.items():
        print(f"  {pid}  ({len(mids)})")
        for mid in mids:
            print(f"    - {mid}")
    print()
    print("在浏览器里打开 opencode web 界面，按 F12 → Console，粘贴下面这段，")
    print("回车即可全部开启（每个浏览器各做一次）：\n")
    print(snippet(models))


if __name__ == "__main__":
    main()
