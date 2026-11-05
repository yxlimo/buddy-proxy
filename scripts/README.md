# scripts

仓库里的一次性/维护脚本，用 Node 26 直接跑（`--experimental-strip-types`，不编译、不加依赖）。

| 脚本 | 干什么 |
| --- | --- |
| `workbuddy-catalog.ts` | 从 WorkBuddy 桌面客户端的 product config 生成 `lib/workbuddy/cn-catalog.json` |

## 生成 WorkBuddy 的 cn 模型目录

网关公布 WorkBuddy cn 那批模型时，倍率（credits）和思考档位（efforts）不能靠上游：
上游的 `GET /v3/config` 在 cn 账号上不给这两样，换请求头也没用。这两样只有客户端
自己的 product config 里有，而官方选择器就是照它画出来的，所以 cn 区的目录以它为准，
生成一份写死的表放仓库里。

客户端更新之后重跑一次就行，不要手改 JSON：

```bash
mise run helper:catalog            # 写 lib/workbuddy/cn-catalog.json，并打印差异
mise run helper:catalog:check      # 只比对：过期退出码 1
node --experimental-strip-types scripts/workbuddy-catalog.ts --dry-run   # 只打印要写什么
node --experimental-strip-types scripts/workbuddy-catalog.ts --config <path>  # 指定输入
```

输入按顺序找：`--config` > `~/.workbuddy/cache/acc-product-config-v3-*.json` >
`/mnt/c/Users/*/.workbuddy/cache/acc-product-config-v3-*.json`（WSL 里读 Windows 那份）。
多个候选时取 mtime 最新的那个，并打印用了哪个文件、它的 `genieVersion` 与 mtime。

输出是确定的：同一份输入两次跑出来的文件逐字节相同（固定排序、不写时间戳），所以
`--check` 报的差异只有「客户端换了什么」。差异按模型列，例如：

```text
deepseek-v4-flash credits: 0.17 → 0.19
glm-5.2 efforts: [] → [high,xhigh]
新增 kimi-k3.2
消失 glm-5.1
```

口径：

- `credits` 取 `x0.69` 里的数，空串写 `null`（没有倍率，不是免费）
- `contextWindow` 取 `maxInputTokens`，没有再退 `maxAllowedSize`
- 只收 chat 模型：视频、补全（`codewise-*` / `completion-*`）、图像、`default-*` 别名、
  没有上下文窗口的小模型、多云变体（`-volc` / `-lkeap` / `-taiji`）、客户端选择器里
  没列出的自建变体
- 只给固定 `effort` 的模型写成 `efforts: []` + `defaultEffort`：那是一档固定，不是
  只有一个选项的下拉

上游那份仍然可以补模型、改字段，但只在它真给了某个字段时才算数 —— 缺字段不覆盖表里的值。
