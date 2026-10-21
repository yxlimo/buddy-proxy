# Qoder CLI 模型目录解密 — 结果与复现方法

## 结论（一句话）

**官方目录里根本没有 `max_output_tokens` 这个字段**（v6 / v7 两个版本都没有，出现次数 0）。
客户端自己用 `Ob()` 把它兜底成 **32000**，然后发到上游。

所以：`max_output_tokens` 对**所有 25 个模型都是 32000，没有任何例外**。
我们现在用的常量 `4096` 是错的。

---

## 1. 证据链

### 1.1 目录里没有这个字段

对解密后的 `catalog-v7`（69812 字节 JSON，103 个模型条目）全文搜索：

```
$ grep -o "max_[a-z_]*" catalog-v7.json | sort | uniq -c
     98 max_input_tokens
```

`max_output_tokens` 出现 0 次；`catalog-v6` 同样 0 次。
整份 JSON 里连任何包含 `output` 的字段名都没有。

### 1.2 客户端自己的兜底逻辑（`~/.qodersec/bin/qodercli`）

```js
function Ob(A){                                   // bundle 内 @98137198
  let H = typeof A==="number" ? A
        : typeof A==="string" && A.trim().length>0 ? Number(A)
        : Number.NaN;
  return Number.isSafeInteger(H) && H>0 ? H : 32000;   // ← 兜底 32000
}
var br=32000;                                     // 同作用域的常量
```

`parseModelList()`（@98153866）把目录条目转成内部模型对象：

```js
K = { key:U, display_name:..., max_input_tokens:Number(w.max_input_tokens??0),
      ..., max_output_tokens:Ob(w.max_output_tokens), ... }
```

`GmE()`（@103421577）取模型时：

```js
let L = H.getModel(A),
    Q = L?.max_input_tokens ?? 200000,
    x = Ob(L?.max_output_tokens),        // ← 32000
    ...
return { resolvedModelKey:I, modelConfig:G, isReasoning:B, defaultMaxOutputTokens:x, ... }
```

`S4A()`（@103419917）把它写进请求参数：

```js
let g = A4H(f?.generation);
if (f?.maxOutputTokens !== void 0) g.max_tokens = Ob(f.maxOutputTokens);
else if (g.max_tokens === void 0)  g.max_tokens = Ob(M);   // M = defaultMaxOutputTokens = 32000
```

> 注：客户端**不是**完全忽略调用方。命令行 `--max-output-tokens` / `f.maxOutputTokens`
> 会被优先采用（`Ob()` 同样兜底到 32000）。默认路径才是 32000。

另外，BYOK / 外部 provider 路径的默认值也是同一个数：
`var tPH=1e6, ByD=128000, fyD=200000, $b$=32000, EyD=60000, QyD=180000, xyD=600000`

### 1.3 抓包实证（真实请求体解密）

把官方 CLI 的推理请求截下来并解出明文：

* 方法：`https_proxy` 指向一个自签 CA 的 MITM 代理 + `NODE_EXTRA_CA_CERTS` 让 CLI 信任它；
  代理记录请求体，再用 `qoder/decode_legacy_body.js` 反解 Qoder 私有 base64。
* 抓到的请求：

```
POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
content-type: application/json
x-model-key: auto
```

* 解出来的明文里：

```json
"model_config": { "key":"auto", "display_name":"Auto", "max_input_tokens":200000, ... },
"parameters":   { "max_tokens": 32000 }
```

逐模型扫了 15 个模型（1826 条推理请求），**`max_tokens` 全部是 32000**：

| model key | wire max_tokens | wire model_config.max_input_tokens | 目录 max_input_tokens |
|---|---|---|---|
| auto | 32000 | 200000 | 200000 |
| cmodel | 32000 | 180000 | 180000 |
| dfmodel | 32000 | 1000000 | 1000000 |
| dmodel | 32000 | 1000000 | 1000000 |
| efficient | 32000 | 200000 | 200000 |
| gfmodel | 32000 | 1000000 | 1000000 |
| gmodel | 32000 | 180000 | 180000 |
| kmodel | 32000 | **0** | **null（目录里没有）** |
| kmodel_latest | 32000 | 180000 | 180000 |
| mmodel | 32000 | 180000 | 180000 |
| qfmodel | 32000 | 180000 | 180000 |
| qmodel | 32000 | 1000000 | 1000000 |
| qmodel_38max | 32000 | 180000 | 180000 |
| smodel | 32000 | 180000 | 180000 |
| ultimate | 32000 | 1000000 | 1000000 |

`model_config.max_input_tokens` 和目录里的 `max_input_tokens` **逐个模型完全对得上**
（`kmodel` 是唯一例外，见下文）。

**`--max-output-tokens` 会被忽略**：分别用 1234 / 4096 / 100000 跑，抓到的 198 条推理请求
`max_tokens` 一律是 32000。也就是说客户端在首个请求里恒定发它自己的目录值。

---

## 2. 交付物

| 路径 | 内容 |
|---|---|
| `/tmp/opencode/qoder-catalog-decrypted.json` | 解密后的目录 + per-model 表（v7，含抓包实证） |
| `/tmp/opencode/qoder-catalog-v6-decrypted.json` | 同上（v6，更早的快照，24 个模型） |
| `/tmp/opencode/qoder-catalog-v7-raw.json` | catalog-v7 的完整解密明文（原始 JSON） |
| `/tmp/opencode/qoder-catalog-v6-raw.json` | catalog-v6 的完整解密明文 |
| `/tmp/opencode/qoder-wire-capture.json` | 逐模型抓包结果（wire max_tokens） |
| `/tmp/opencode/qoder-captured-infer-request-body.json` | 一条真实推理请求的解密明文（127 KB） |
| `/tmp/opencode/README-qoder-catalog.md` | 本文档 |
| `/tmp/opencode/reproduce.sh` | 一键复现（提取 WASM → 解密 → 出表） |
| `/tmp/opencode/qoder/extract_qoder_wasm.py` | 从 `qodercli` 里抠出 WASM + wbindgen 胶水层 |
| `/tmp/opencode/qoder/qoder_wasm_glue.cjs` | 抠出来的胶水层（CommonJS） |
| `/tmp/opencode/qoder/qoder_auth_wasm.wasm` | 抠出来的 `qoder_auth_wasm`（297238 字节） |
| `/tmp/opencode/qoder/decrypt.js` | `model_cache_decrypt(text, uid)` 调用器 |
| `/tmp/opencode/qoder/build_report.js` | 生成 per-model 表 |
| `/tmp/opencode/qoder/decode_legacy_body.js` | 推理请求体编码的逆变换 |
| `/tmp/opencode/qoder/capture_server.js` | 明文 HTTP 回显服务器 |
| `/tmp/opencode/qoder/decode_sweep.js` | 汇总抓包结果 |
| `/tmp/opencode/qoder/sweep_models.sh` | 逐模型抓包脚本 |
| `/tmp/opencode/mitm/mitm_proxy.js` | 抓包用的 MITM 代理（需 `ca.pem`/`srv.pem`） |

复现解密：

```bash
/tmp/opencode/reproduce.sh
```

只读 `~/.qoder/` 和 `~/.qodersec/bin/qodercli`，不修改任何东西。

复现抓包（需要 openssl 生成自签 CA，见 `mitm/` 里的 `ca.pem`/`srv.pem`）：

```bash
node /tmp/opencode/mitm/mitm_proxy.js 8888 /tmp/opencode/mitm/out.jsonl reject &
https_proxy=http://127.0.0.1:8888 NODE_EXTRA_CA_CERTS=/tmp/opencode/mitm/ca.pem \
  ~/.qodersec/bin/qodercli --config-dir /tmp/opencode/qoder-home -p hi --model auto
node /tmp/opencode/qoder/decode_sweep.js /tmp/opencode/mitm sweep-
```

---

## 3. 解密方法（路线 A，直接调 WASM）

官方 CLI 的 Bun bundle 里内嵌了完整的 `qoder_auth_wasm`：

* WASM 本体：`var YjB="<base64>"`（396320 base64 字符 → 297238 字节，`\0asm\x01\0\0\0`）
* 胶水层：`ub0()`（wasm-bindgen import object）、`kjB()`（`model_cache_decrypt` 的包装）、`vC/oU/CI/...`

提取脚本把它们**原样**抠出来，只把 `import.meta.url` 换成字符串以便 CommonJS 加载，
然后：

```js
pb0init();
const mod = new WebAssembly.Module(fs.readFileSync('qoder_auth_wasm.wasm'));
yb0(new WebAssembly.Instance(mod, ub0()), mod);
const plain = kjB(catalogText, uid);   // = WASM model_cache_decrypt(text, uid)
```

校验：解密结果 69812 字节合法 JSON；`model_cache_encrypt` 回灌得到同长度密文，
头部 `51 4D 43 01`（"QMC"+版本）一致、其后不同 —— AES-GCM 随机 nonce，符合预期。

---

## 4. per-model 表（catalog-v7，25 个模型）

`max_output_tokens` 一律 `null`（目录里没这个字段），`effective` 一律 `32000`。

| model key | display_name | max_output_tokens (raw) | effective | max_input_tokens | scenes |
|---|---|---|---|---|---|
| auto | Auto | null | 32000 | 200000 | chat,assistant,inline,qwake,app |
| cmodel | Cantus | null | 32000 | 180000 | chat,assistant,quest,experts,qwake,app |
| dfmodel | DeepSeek-Flash | null | 32000 | 1000000 | chat,assistant,quest,qwake,app |
| dmodel | DeepSeek-V4-Pro | null | 32000 | 1000000 | chat,assistant,quest,qwake,app |
| efficient | Efficient | null | 32000 | 200000 | chat,assistant,inline,quest,qwake,app |
| experts-auto | Auto | null | 32000 | 200000 | experts |
| experts-ultimate | Ultimate | null | 32000 | 1000000 | experts |
| fast | Fast | null | 32000 | 200000 | chat,assistant,quest,qwake,app |
| gfmodel | GLM-5.3-Flash | null | 32000 | 1000000 | chat,assistant,quest,qwake,app |
| gmodel | GLM-5.3 | null | 32000 | 180000 | chat,assistant,quest,experts,qwake,app |
| kmodel | Kimi-K2.8-Preview | null | 32000 | **null** | chat,assistant,quest,qwake,app |
| kmodel_latest | Kimi-K3 | null | 32000 | 180000 | chat,assistant,quest,qwake,app |
| mmodel | MiniMax-M3.1-Flash | null | 32000 | 180000 | chat,assistant,quest,qwake,app |
| nap-auto | Auto | null | 32000 | 180000 | nap |
| qfmodel | Qwen3.8-Flash | null | 32000 | 180000 | chat,assistant,quest,qwork,qwake,app |
| qmodel | Qwen3.7-Plus | null | 32000 | 1000000 / 180000(qwork) | chat,assistant,quest,qwork,qwake,app |
| qmodel_38max | Qwen3.8-Max | null | 32000 | 180000 | chat,assistant,quest,qwork,experts,qwake,app |
| qmodel_latest | Qwen3.7-Max | null | 32000 | 1000000 | chat,assistant,quest,qwork,qwake,app |
| quest-auto | Auto | null | 32000 | 200000 | quest |
| quest-ultimate | Ultimate | null | 32000 | 1000000 | quest |
| qwork-advanced | Advanced | null | 32000 | 180000 | qwork |
| qwork-auto | Standard | null | 32000 | 180000 | qwork |
| qwork-ultimate | Premium | null | 32000 | 180000 | qwork |
| smodel | Sonus | null | 32000 | 180000 | chat,assistant,quest,qwork,experts,qwake,app |
| ultimate | Ultimate | null | 32000 | 1000000 | chat,assistant,inline,qwake,app |

`catalog-v6` 同样没有 `max_output_tokens`，24 个模型（比 v7 少 `fast` / `qmodel_latest`，
多一个 `performance`），effective 也一律 32000。

### 两个 `max_input_tokens` 的坑

* `kmodel`（Kimi-K2.8-Preview）目录里**没有** `max_input_tokens`。
  `parseModelList` 存成 `0`，而 `GmE()` 用的是 `L?.max_input_tokens ?? 200000`
  —— `0` 不是 nullish，所以客户端实际拿到的是 **0**（抓包已确认 wire 上就是 `0`），
  不是 200000。
* `qmodel`（Qwen3.7-Plus）在 `qwork` 场景是 180000，其它场景是 1000000。

---

## 5. 对网关的影响（建议，未改动仓库）

`lib/qoder-models.ts:220` 的

```ts
export const QODER_CLIENT_MAX_TOKENS = 4096;
```

用来在 `lib/router/upstreams.ts:163`（`openaiBody.max_tokens`）和
`:204`（`maxTokens:`）填请求。

* 要**像官方客户端**：`QODER_CLIENT_MAX_TOKENS` 应改成 **32000**。
* 注意区分两个概念：
  * `QODER_CLIENT_MAX_TOKENS` = 网关往上游声明的 `max_tokens` → 应为 **32000**。
  * 每个模型的 `maxOutput`（`lib/qoder-models.ts` 里 65536 / 131072 / 393216 那些）
    = 模型真实输出上限，只是给客户端看的模型信息，和客户端发什么无关。

由于网关不强制这个数，改成 32000 只是"更像"，不影响答案长度。
