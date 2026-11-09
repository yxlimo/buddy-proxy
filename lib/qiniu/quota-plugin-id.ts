// lib/qiniu/quota-plugin-id.ts — 七牛云额度插件的 id。
//
// 这个文件没有 import，是有意的：插件模块与 register 模块互相引用（插件要登记，
// register 要插件的 id），id 若住在插件模块里，register 在模块求值期读它就会撞上
// 「还在初始化」。id 住在一个没有依赖的地方，那条引用就不再参与环。

export const QINIU_QUOTA_PLUGIN_ID = "qiniu";
