// lib/qiniu/config.ts — 七牛云 AI 推理的地址。
//
// 两个域名，两个用途：
//
//   api.qnaigc.com   推理端点。OpenAI 方言，一把 API key 作 Bearer。
//   portal.qiniu.com 门户。额度（资源包）在那里，而且只认门户的 cookie ——
//                     推理用的那把 key 在门户上没有用。
//
// 所以额度查不到不是推理的问题：两个凭据是分开的两段。

/** 推理端点的根。`/chat/completions` 与 `/models` 接在后面。 */
export const QINIU_INFER_BASE = "https://api.qnaigc.com/v1";

/** 门户的根。它不是推理域名，鉴权方式也不同（cookie）。 */
export const QINIU_PORTAL_BASE = "https://portal.qiniu.com";

/** 门户上「本月资源包概览」的路径。 */
export const QINIU_RESPACK_PATH =
  "/api/proxy/finance/janus/api/proxy/respack/v1/respack/month-overview";
