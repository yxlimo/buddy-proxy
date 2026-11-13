/**
 * 凭据是哪一种。
 *
 * 服务端给的是契约里的枚举值（session / api_key / cookie）：那一串对运维等于
 * 内部术语，界面上换成看得懂的词。没登记的值原样返回，不自创「未知类型」这类
 * 说法 —— 认不出的值本身就是后端要收敛的信号，藏起来反而看不见。
 *
 * 平台页的凭据表和总览页的凭据行都用这一张表，不另写第二份。
 */
const CREDENTIAL_KIND_LABELS: Record<string, string> = {
  session: '登录会话',
  api_key: '推理 Key',
  cookie: '额度 Cookie',
}

/** 把一个凭据 kind 换成界面上的说法；空值给空串，没登记的值原样给回。 */
export function credentialKindLabel(kind: string | undefined): string {
  if (!kind) {
    return ''
  }
  return CREDENTIAL_KIND_LABELS[kind] ?? kind
}
