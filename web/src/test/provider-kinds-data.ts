/**
 * 种类登记表的数据（测试夹具的真相）。
 *
 * 面板不留自己那张按 kind 查的表：格子由服务端的种类声明说
 * （`lib/provider-kinds.ts` 的 `selectableKinds()`）。所以这一份**必须与后端
 * 一致** —— 手写出后端不会返回的格子，测试就绿在假数据上（开放平台的推理 Key
 * 那一格曾经就是这样：夹具里有，后端返回空数组，面板一格也画不出来）。
 *
 * 对账在 `test/credential-plan-check.ts`：它逐字段比这一份与后端声明，对不上就红。
 * 后端改了声明，这里跟着改；不要反过来让后端迁就夹具。
 *
 * 只列面板测试用到的那几类；别的种类当成「没登记」（凭据入口是 none）。
 */

/** 一格凭据（与契约的 CredentialField 同形）。 */
export interface ProviderKindFixtureField {
  name: string
  label: string
  hint?: string
  placeholder?: string
}

/** 一个种类（与 selectableKinds() 的那一行同形）。 */
export interface ProviderKindFixtureRow {
  kind: string
  label: string
  login: string
  policies: string[]
  credentialTitle: string
  credentialFields: ProviderKindFixtureField[]
}

export const PROVIDER_KIND_ROWS: ProviderKindFixtureRow[] = [
  {
    kind: 'openai',
    label: '开放平台（OpenAI 兼容）',
    login: 'api_key',
    policies: ['single', 'fallback'],
    credentialTitle: '开放平台的凭据',
    credentialFields: [
      {
        name: 'api-key',
        label: '推理 Key',
        hint: '发模型请求用的那一把；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ],
  },
  {
    kind: 'anthropic',
    label: 'Anthropic 兼容',
    login: 'api_key',
    policies: ['single', 'fallback'],
    credentialTitle: '开放平台的凭据',
    credentialFields: [
      {
        name: 'api-key',
        label: '推理 Key',
        hint: '发模型请求用的那一把；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ],
  },
  {
    kind: 'qiniu',
    label: '七牛云',
    login: 'api_key',
    policies: ['single', 'fallback'],
    credentialTitle: '七牛云凭据',
    credentialFields: [
      {
        name: 'api-key',
        label: '推理 Key',
        hint: '发模型请求用的那一把',
        placeholder: 'sk-…',
      },
      {
        name: 'portal-cookie',
        label: '额度 Cookie',
        hint: '只用来查资源包额度，可以留空',
        placeholder: 'c=…',
      },
    ],
  },
  {
    kind: 'xinghuo',
    label: '讯飞星火',
    login: 'api_key',
    policies: ['single', 'fallback'],
    credentialTitle: '讯飞星火 API Key',
    credentialFields: [
      {
        name: 'api-key',
        label: '推理 Key',
        hint: '在讯飞星火控制台创建的推理 key，整串粘贴',
        placeholder: '在讯飞星火控制台复制的 API Key',
      },
    ],
  },
  {
    kind: 'sensenova',
    label: 'SenseNova',
    login: 'password',
    policies: ['single', 'fallback'],
    credentialTitle: 'SenseNova API Key',
    credentialFields: [
      {
        name: 'api-key',
        label: '推理 Key',
        hint: '发模型请求用的那一把；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ],
  },
  {
    kind: 'intern-ai',
    label: '书生·端砚',
    login: 'code',
    policies: ['single', 'fallback'],
    credentialTitle: '书生·端砚的凭据',
    credentialFields: [
      {
        name: 'discovery-key',
        label: '推理 Key',
        hint: '推理走的就是这把 key；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ],
  },
  {
    kind: 'tokenrhythm',
    label: 'TokenRhythm',
    login: 'password',
    policies: ['single', 'fallback', 'expiry_first'],
    credentialTitle: 'TokenRhythm API Key',
    credentialFields: [
      {
        name: 'api-key',
        label: '推理 Key',
        hint: '钱包里那把推理用的 key；留空表示清掉它',
        placeholder: 'sk-…',
      },
    ],
  },
  // 会话型的四家：凭据是登录会话，一格也不填。
  {
    kind: 'minimax',
    label: 'MiniMax Code',
    login: 'device',
    policies: ['single', 'fallback'],
    credentialTitle: 'MiniMax Code 的凭据',
    credentialFields: [],
  },
  {
    kind: 'qoder',
    label: 'Qoder',
    login: 'device',
    policies: ['single', 'fallback'],
    credentialTitle: 'Qoder 的凭据',
    credentialFields: [],
  },
  {
    kind: 'workbuddy',
    label: 'WorkBuddy',
    login: 'browser',
    policies: ['single', 'fallback'],
    credentialTitle: 'WorkBuddy 的凭据',
    credentialFields: [],
  },
  {
    kind: 'zcode',
    label: 'ZCode',
    login: 'browser',
    policies: ['single', 'fallback'],
    credentialTitle: 'ZCode 的凭据',
    credentialFields: [],
  },
]
