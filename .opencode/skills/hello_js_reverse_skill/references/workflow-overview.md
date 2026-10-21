# 工作流选择（v3.7.0）

1. 先读已有需求代码和基线；明确数据字段、分页方式、鉴权和最终运行环境。
2. 接口无自定义签名：直接使用协议采集器，见 [general-collection.md](general-collection.md)。
3. 有签名或动态参数：浏览器抓样本，区分鉴权状态、标准加密、混淆、WASM 和环境依赖。
4. 标准算法走 `templates/node-request` 或 `templates/python-request`；原始 JS 可独立运行走 `templates/vm-sandbox`；WASM 走 `templates/wasm-loader`。
5. JSVMP 按实际证据选 [路径 A](path-a-four-tools.md) 或 [路径 B](path-b-env-emulation.md)，不要把某站点经验推广为所有平台的规则。
6. TLS/协议问题需与输入、Cookie、权限和服务端错误区分，不能只凭状态码下结论。
7. 默认交付无浏览器依赖的协议程序。用户明确要求页面自动化时才使用 `templates/browser-auto`，并在交付说明中声明浏览器依赖；该模板使用 Chrome，不是 Camoufox。
8. 每次改版使用旧样本回归，再验证当前真实响应。无法验证的部分保存证据与限制，不把猜测或短时通过宣称为长期稳定。
