# 专项场景与工具配方（v3.7.0）

按场景读取；历史站点现象只能作为候选解释，当前工具参数以 MCP 契约为准。

## 常见签名分析场景速查（10 个场景）

### 场景 1：请求参数签名（sign/m/token）

```
特征：请求 URL 或 Body 中包含看似随机的签名参数
定位：搜索参数名 → 追踪赋值来源 → 定位签名函数
常见算法：MD5(拼接字符串)、HMAC-SHA256、自定义哈希

MCP 操作：
- search_code(keyword="sign=|m=|token=")
- inject_hook_preset(preset="xhr") → get_request_initiator → 直接定位签名函数
- hook_function(function_path="签名函数名", mode='trace', log_stack=true)
```

### 场景 2：动态 Cookie 生成

```
特征：Cookie 中有频繁变化的字段，页面 JS 动态写入
定位：Hook document.cookie setter → 追踪写入来源
类型：
  a. eval 首包：请求返回混淆 JS → eval 执行 → 写入 Cookie
  b. 预热请求：/api2 等接口返回 JS → 注入 window 变量 → 计算 Cookie
  c. 指纹 Cookie：收集浏览器信息 → base64 编码 → 写入

MCP 操作：
- hook_function(function_path="Document.prototype.cookie",
    hook_code="console.log('Cookie set:', arguments)", position='before')
- inject_hook_preset(preset="crypto") → 捕获加密 I/O
- evaluate_js(expression="document.cookie")
- list_network_requests → 识别预热请求
```

### 场景 3：响应数据加密

```
特征：接口返回的不是明文 JSON，而是加密字符串
定位：Hook JSON.parse 或定位解密函数入口
常见算法：AES-CBC/ECB、DES、RC4、自定义异或

MCP 操作：
- search_code(keyword="decrypt|JSON.parse|atob")
- inject_hook_preset(preset="crypto") → 自动捕获 btoa/atob/JSON.stringify
- hook_function(function_path="解密函数路径", mode='trace', log_args=true, log_return=true)
```

### 场景 4：JS 混淆/OB 混淆

```
特征：大量 _0x 前缀变量、十六进制字符串数组、控制流平坦化
还原：字符串数组还原 → 变量重命名 → 控制流平坦化还原

MCP 操作：
- scripts(action='save', url='<混淆脚本URL>', save_path='./config/obfuscated.js')
- search_code(keyword="关键逻辑关键词") → 定位
- evaluate_js → 在浏览器执行解密函数还原字符串
```

### 场景 5：WASM 加密

```
特征：加密函数调用 WebAssembly 导出函数
还原：Node.js 直接加载 .wasm 文件，调用导出函数
注意：检查 wasm imports，可能需要补环境

MCP 操作：
- search_code(keyword="WebAssembly|.wasm|instantiate")
- list_network_requests → 找 .wasm 文件
- evaluate_js → 测试 wasm 函数的 I/O
```

### 场景 6：TLS 指纹/协议检测

```
特征：算法全对但请求仍失败（token failed / 403）
原因：服务器通过 TLS Client Hello 或 HTTP 协议版本识别客户端
解法：
  a. Camoufox 自带反检测 TLS 指纹，直接使用浏览器自动化验证
  b. 使用支持自定义 TLS 指纹的库（curl_cffi / got-scraping）
  c. 使用 HTTP/2 协议

MCP 操作：
- 在 Camoufox 中验证请求成功 → 确认是 TLS 问题
- 换用 curl_cffi（Python）或 got-scraping（Node.js）
```

### 场景 7：WebSocket 通信

```
特征：数据通过 WebSocket 传输，非 HTTP 接口

MCP 操作：
- inject_hook_preset(preset="websocket") → 一键 Hook WebSocket
- get_console_logs → 获取 WS 消息日志
- evaluate_js → 手动发送/接收 WS 消息
```

### 场景 8：字体映射还原

```
特征：页面数字/文字使用自定义字体，复制出来是乱码
还原：下载字体文件 → 解析 CMAP 映射表 → 建立字符映射关系

MCP 操作：
- list_network_requests → 找字体文件（.woff/.woff2/.ttf）
- evaluate_js → 读取页面实际渲染的文字
```

### 场景 9：反检测站点分析

```
特征：目标站点有 Cloudflare、瑞数、极验等反爬检测

MCP 操作：
- launch_browser(humanize=true) → 启动人性化鼠标移动
- navigate → 观察 redirect_chain 判断反爬类型
- intercept_request(url_pattern="**/*", action="log") → 监控所有请求
- inject_hook_preset(preset="debugger_bypass") → 绕过反调试
```

### 场景 10：JSVMP + 环境伪装（jsdom/vm 沙箱执行）

```
特征：JSVMP 不可拆解，签名算法封装在字节码中，与环境指纹深度绑定
判断依据：
  - JSVMP 劫持 XHR/fetch 请求链路
  - 服务端静默拒绝（HTTP 200 + 空 body）
  - 改变环境值导致签名变化

方法论（路径 B 环境伪装六步法）：
1. 用 Camoufox + evaluate_js 分批采集真实浏览器环境
2. 在 jsdom 中运行完全相同的采集代码
3. 逐项 diff，按影响分级修复（致命级→高危→中危）
4. 编写 patchEnvironment() 全量修复
5. 从 jsdom 内部（win.eval）验证所有检测点通过
6. 端到端验证：生成签名 → 请求接口 → 返回有效数据

最关键的 5 项修复：
- Function.prototype.toString → WeakSet + 源码正则 + 实例覆写
- navigator.plugins → 完整 PluginArray/Plugin/MimeType 对象树
- navigator.webdriver → false
- document.hasFocus() → true
- DOM offsetHeight/Width → 非零值

MCP 操作：
- launch_browser → navigate → 搭建采集环境
- compare_env → 采集浏览器基准数据
- evaluate_js → 分批采集细粒度环境值（4-5 批次）
- 本地运行 jsdom 对比脚本 → 生成差异报告
- 迭代修复 → 再次对比 → 直到差异归零 → 端到端验证

⚠️ 环境伪装关键红线：
- Firefox UA 严禁补 userAgentData / connection / getBattery / window.chrome / performance.memory
- Function.prototype.toString 整个 patch 只能覆盖一次
- env-patch 体量超 800 行触发审查
- 命中相关案例时，精读案例的"禁动清单"和"UA 分支矩阵"段
```

---

## 调试环境保护策略（反调试对抗速查表）

| 反调试手段 | 检测方式 | 绕过方案 |
|---|---|---|
| `debugger` 定时器 | `setInterval(() => { debugger; }, 100)` | `inject_hook_preset(preset="debugger_bypass")` |
| `Function.toString` 检测 | 检查 Hook 函数的 toString 是否暴露 | `hook_function(..., non_overridable=true)` |
| 时间差检测 | `Date.now()` 前后差值判断是否被调试 | 不暂停执行，用 trace 模式 |
| 控制台检测 | 检测 `console` 对象是否被修改 | 不修改 console，用 MCP 的 `get_console_logs` |
| 原型链检测 | 检查 `XMLHttpRequest.prototype.open.toString()` | `non_overridable=true` 自动伪装 toString |
| 堆栈深度检测 | 通过 Error.stack 行数判断是否有 Hook 层 | 使用 `position="replace"` 减少堆栈层数 |
| `window.outerHeight - window.innerHeight` | 检测 DevTools 是否打开 | 先观察实际浏览器与页面行为，不据此保证不可检测 |

### 反调试处理流程

```
1. 首次 navigate 后如果页面卡住/白屏：
   → inject_hook_preset(preset="debugger_bypass")
   → instrumentation(action='reload')

2. 如果 Hook 被页面 JS 覆盖：
   → hook_function(..., non_overridable=true)
   → 或 inject_hook_preset 前加 persistent=true

3. 如果 console.log 被重写导致看不到输出：
   → 用 get_console_logs（MCP 层面捕获，不依赖页面 console）
```

---

## 工具使用最佳实践

### MCP 工具配合模式

```
黄金路径（最快定位签名函数）：
  network_capture(action='start') → 触发请求 → list_network_requests
  → get_request_initiator(request_id=N) → 直达签名函数

环境伪装路径：
  compare_env → evaluate_js(分批采集) → 本地 diff → 补丁 → verify_signer_offline

JSVMP 插桩路径：
  instrumentation(action='install', url_pattern=..., mode='ast')
  → instrumentation(action='reload')
  → instrumentation(action='log', type_filter='tap_get') → hot_keys

Cookie 归因路径：
  network_capture(action='start', capture_body=true)
  → inject_hook_preset(preset="cookie", persistent=true)
  → 触发场景 → analyze_cookie_sources(name_filter="目标cookie名")
```

### 效率原则

- 优先用 `get_request_initiator` 而非 `search_code` 定位签名函数
- 优先用 `inject_hook_preset` 而非手写 Hook
- 优先用 `instrumentation(action='install')` 而非逐个 `hook_function`
- 分析产物第一时间写入 `config/` 文件，不要内联长字符串
- `inject_hook_preset` 默认持久化；`hook_function` 需要跨导航时显式传 `persistent=True`
- `hook_function(..., non_overridable=True)` 防止页面 JS 覆盖你的 Hook

### 调试方法论

```
源码级插桩判定与后续策略：

| hot_methods 包含 | hot_keys 环境属性数 | 策略 |
|-----------------|---------------------|------|
| CryptoJS.MD5 / SubtleCrypto.digest / btoa | 少（< 15） | 纯算法还原 |
| 大量自定义 fn 名 | 少（< 15） | 提取 VMP 子片段 + vm 沙箱 |
| CryptoJS / SubtleCrypto | 多（40+） | jsdom 环境伪装（路径 B） |
```

### 使用 inject_hook_preset 一键 Hook

```
inject_hook_preset(preset="xhr")              → Hook 所有 XHR 请求
inject_hook_preset(preset="fetch")            → Hook 所有 fetch 请求
inject_hook_preset(preset="crypto")           → Hook btoa/atob/JSON.stringify
inject_hook_preset(preset="websocket")        → Hook WebSocket 消息
inject_hook_preset(preset="debugger_bypass")  → 绕过反调试
inject_hook_preset(preset="cookie")           → Hook document.cookie 写入
inject_hook_preset(preset="runtime_probe")    → 广谱运行时探针
```

### 使用 hook_function 自定义 Hook

```
hook_function(
  function_path="XMLHttpRequest.prototype.open",
  hook_code="console.log('[XHR]', arguments[0], arguments[1])",
  position="before",
  non_overridable=true    → 防覆盖
)
```

### 使用源码级插桩（通用 VMP 利器）

```
# 1. 确认是 VMP（case_count > 50 基本是）
search_code(keyword='switch', script_url="<VMP脚本URL>", context_chars=500)

# 2. 装插桩
instrumentation(action='install',
  url_pattern="**/sdenv-*.js",
  mode="ast",
  tag="vmp1",
  rewrite_member_access=true,
  rewrite_calls=true
)

# 3. 重载让插桩生效
instrumentation(action='reload')

# 4. 触发操作后读日志
instrumentation(action='log', tag_filter="vmp1", type_filter="tap_get", limit=200)
  → summary.hot_keys 是 VMP 读取的环境属性 top 30

instrumentation(action='log', tag_filter="vmp1", type_filter="tap_method", limit=200)
  → summary.hot_methods 是 VMP 调用的方法 top 30

# 5. 完工移除
instrumentation(action='stop', url_pattern="**/sdenv-*.js")
```

### 使用 pre_inject_hooks 解决首屏挑战页

```
# RS 412 / Akamai 首包检测场景：
# 普通 navigate 时 challenge JS 已经跑完了，hook 完全漏掉
# 正确做法：
navigate(
  url="https://target.com/",
  wait_until="networkidle",
  pre_inject_hooks=["xhr", "fetch", "cookie"]
)
# 返回 initial_status / final_status / redirect_chain
```

### Cookie 归因分析

```
# 搞清楚某个 Cookie 到底是谁写的（JS / HTTP Set-Cookie / 混合）

# 1. 前置条件：网络抓包 + cookie hook 同时开
network_capture(action='start', capture_body=true)
inject_hook_preset(preset="cookie", persistent=true)

# 2. 触发场景（刷新 / 登录 / 点业务按钮）

# 3. 一键归因
analyze_cookie_sources(name_filter="ttwid")
# name_filter 是子串；其他名称分别查询，不使用 | 当作正则
→ 返回：
  cookies[name].sources: ["http_set_cookie" | "js_document_cookie"]
  cookies[name].http_responses: [{url, ts, header}]
  cookies[name].js_writes: [{value, stack, ts}]

# 4. 按归因结果进一步分析
  a. 纯 http_set_cookie → 看 http_responses[].url 是哪个接口
  b. 纯 js_document_cookie → 看 js_writes[].stack 定位写入函数
  c. 两者都有 → 两步都做
```

### hook_jsvmp_interpreter 模式选择

```
# proxy 模式（全覆盖，但可被检测）— 仅行为型反爬可用
hook_jsvmp_interpreter(mode='proxy', persistent=true)

# transparent 模式（安全，低覆盖）— 签名型反爬必须用这个
hook_jsvmp_interpreter(mode='transparent', persistent=true)

# 区别：
# proxy: 装 Proxy 在 navigator/screen/document 等对象上，能看到所有属性读取
# transparent: 只替换 prototype getter，不装 Proxy，不改 Function.prototype
# 签名型反爬（RS/Akamai）用 proxy 会破坏签名，必须用 transparent
```

### verify_signer_offline 离线验证

```
# 用真实样本验证签名代码正确性
verify_signer_offline(
  signer_code="(sample) => { return {a_bogus: generateABogus(sample.url)}; }",
  samples=[
    {id: "req1", input: {url: "..."}, expected: {a_bogus: "DFSz..."}},
    {id: "req2", input: {url: "..."}, expected: {a_bogus: "EGTa..."}},
  ]
)
→ 返回 pass_rate + first_divergence（字符级定位首偏差点）
```

---
