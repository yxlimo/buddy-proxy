思考内容会被塞进 message.content（实测 content='We need answer exactly JSON {"i":1}...'）。但走我们的客户端 + 实验台时 JSON 解析没出问题（三轮全绿） 

复现命令

 ```bash
   cd /home/shay/projects/strmforge && set -a && . ./.env && set +a
   curl -s "$LITEPAN_LLM_END_POINT/chat/completions" \
     -H "Authorization: Bearer $LITEPAN_LLM_API_KEY" -H 'Content-Type: application/json' \
     -d '{"model":"MiniMax-M3.1-Flash","reasoning_effort":"none",
          "messages":[{"role":"user","content":"只输出 JSON：{\"k\":1}"}]}'
 ```

 实测：不是参数问题，是随机的

 短提示词，每组跑 3 次：

 ┌───────────────────────┬────────────────┬────────────┬─────────────────────────────────┐
 │ 参数                  │ 有 system 消息 │ 干净的次数 │ 内容示例                        │
 ├───────────────────────┼────────────────┼────────────┼─────────────────────────────────┤
 │ 裸请求                │ 无             │ 1/3        │ We need answer exactly JSON?... │
 ├───────────────────────┼────────────────┼────────────┼─────────────────────────────────┤
 │ 裸请求                │ 有             │ 0/3        │ We need output exactly JSON?... │
 ├───────────────────────┼────────────────┼────────────┼─────────────────────────────────┤
 │ reasoning_effort=low  │ 无             │ 1/3        │ {"k":1}                         │
 ├───────────────────────┼────────────────┼────────────┼─────────────────────────────────┤
 │ reasoning_effort=low  │ 有             │ 0/3        │ We need respond exactly JSON... │
 ├───────────────────────┼────────────────┼────────────┼─────────────────────────────────┤
 │ reasoning_effort=none │ 无             │ 1/3        │ {"k":1}                         │
 ├───────────────────────┼────────────────┼────────────┼─────────────────────────────────┤
 │ reasoning_effort=none │ 有             │ 0/3        │ We need answer only JSON...     │
 └───────────────────────┴────────────────┴────────────┴─────────────────────────────────┘

 长提示词（接近生产规模），连跑 3 次：

 ```
   run1  starts_with='W'  len=636   reasoning_content=True
   run2  starts_with='W'  len=1652  reasoning_content=True
   run3  starts_with='W'  len=1441  reasoning_content=True
 ```

 结论：与 reasoning_effort、response_format 都无关，就是这个网关/模型把思考内容拼进了 content 前面，而且 reasoning_content 字段同时存在——等于同一段思考被写了两处。加了 system 消息后更容易触发（0/3）。

 但生产链路是好的，原因我找到了

 实验台日志里模型的原始返回是干净的：

 ```
   ─── 第一阶段 · 模型原始返回 ───
   {"success":[{"id":"1","media_type":"tv","season":1,"episode":1,"keyword":["Yellowstone"],...
 ```

 差别在于生产请求的形状：system 是完整的 8KB 提示词、user 是一批结构化 JSON。这种输入下模型不"想"（或者想了但没有往 content 里塞）。

 也就是说：短提示词 + 简单的"只输出 JSON"指令会触发泄漏；完整的生产提示词不会。我上一条说"端点在泄漏、生产也没问题"是蒙对了结论但理由说错了——不是客户端参数救的，是提示词规模。




