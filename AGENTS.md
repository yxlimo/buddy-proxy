# llm 代理网关
对外提供 Openai 和 Anthropic 两种方言接口
对内模拟 Minimax Code, Qoder, Workbuddy 等桌面客户端向上游转发请求

## 术语定义
Agent: 指调用本网关对外接口的通用 agent client。比如 pi, opencode，hermes 等
客户端：指网关对内模拟的桌面客户端
