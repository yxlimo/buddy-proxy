# llm 代理网关
对外提供 Openai 和 Anthropic 两种方言接口
对内模拟 Minimax Code, Qoder, Workbuddy 等桌面客户端向上游转发请求

## 术语定义
Agent: 指调用本网关对外接口的通用 agent client。比如 pi, opencode，hermes 等
客户端：指网关对内模拟的桌面客户端

## 排查问题 
优先查日志定位原因，查不到日志再考虑构建请求复现问题。解决问题后要复盘这个问题能不能通过提前加日志解决

## 本地材料
TokenRhythm 这条上游的调研材料在 `docs/token-rhythm/`（平台接口、多租户、cc-switch 用量脚本）
`docs/` 不进版本库，只在本机

