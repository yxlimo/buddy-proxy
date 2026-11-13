import { create } from '@bufbuild/protobuf'
import {
  CredentialFieldSchema,
  ListProviderKindsResponseSchema,
  ProviderKindSchema,
  ProviderPolicy,
} from '@/gen/buddy/admin/v1/admin_pb'
import { PROVIDER_KIND_ROWS } from '@/test/provider-kinds-data'

/**
 * 假的服务端种类登记表：种类 → 标题与凭据格子。
 *
 * 数据在 `provider-kinds-data.ts`，那份与后端声明逐字段对账
 * （`test/credential-plan-check.ts`）。这里只把它换成契约的形状：面板不该自己
 * 补格子，测试也不该手写出后端不会返回的格子。
 */

/** 策略的名字 → 契约里的枚举。 */
const POLICY: Record<string, ProviderPolicy> = {
  single: ProviderPolicy.SINGLE,
  fallback: ProviderPolicy.FALLBACK,
  expiry_first: ProviderPolicy.EXPIRY_FIRST,
}

const KINDS = PROVIDER_KIND_ROWS.map((row) =>
  create(ProviderKindSchema, {
    kind: row.kind,
    label: row.label,
    login: row.login,
    policies: row.policies.map((policy) => POLICY[policy] ?? ProviderPolicy.SINGLE),
    credentialTitle: row.credentialTitle,
    credentialFields: row.credentialFields.map((field) =>
      create(CredentialFieldSchema, {
        name: field.name,
        label: field.label,
        hint: field.hint ?? '',
        placeholder: field.placeholder ?? '',
      })
    ),
  })
)

/** ListProviderKinds 的答复。 */
export function listProviderKinds() {
  return create(ListProviderKindsResponseSchema, { kinds: KINDS })
}
