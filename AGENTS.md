# llm 代理网关
对外提供 Openai 和 Anthropic 两种方言接口
对内模拟 Minimax Code, Qoder, Workbuddy 等桌面客户端向上游转发请求

## 术语定义

**Agent**：专指 buddyProxy API 的调用方。比如 pi, opencode, hermes, dsh 等。

**模拟端**：有些上游 API 仅限自家封闭客户端调用，buddyProxy 需要在调用时将请求的指纹信息与上游对应的封闭客户端对齐，达到欺骗效果。保持这些封闭客户端的会话活跃，模拟请求指纹的行为主题（代码模块）就叫**模拟客户端**，简称**模拟端**。

**Upstream**：指上游的 API。一个 upstream 对应一个平台的某个服务（一个平台可能会有多个服务，比如 MiniMax 的开放 API（API Key 认证）和 MiniMax Code（OAuth 认证），权益不同，属于不同的 upstream）。

**Provider**：指单个账号，通过 OAuth 登录或者账号密码登录。一个平台会有多个账号，即一个 upstream 会有一个或多个 provider。

Upstream 内部可以设置多 provider 的策略（fallback、balance 等）。主路由直接接入 upstream，而不是接入 provider。主路由的策略与 upstream 的策略互相独立，共同生效。

## 排查问题
优先查日志定位原因，查不到日志再考虑构建请求复现问题。解决问题后要复盘这个问题能不能通过提前加日志解决

## 本地材料
TokenRhythm 这条上游的调研材料在 `docs/token-rhythm/`（平台接口、多租户、cc-switch 用量脚本）
`docs/` 不进版本库，只在本机
