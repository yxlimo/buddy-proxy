import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSetPlatformPolicy } from '@/features/upstreams/api'
import { ProviderPolicy } from '@/gen/buddy/admin/v1/admin_pb'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 策略的中文标签。
 *
 * 后端也有一份：lib/platforms.ts 的 POLICY_TEXT。两边要一起改 —— 后端的 toast
 * （策略改成了降级）与面板的下拉是同屏出现的。
 */
const POLICY_LABELS: Partial<Record<ProviderPolicy, string>> = {
  [ProviderPolicy.SINGLE]: '单一',
  [ProviderPolicy.FALLBACK]: '降级',
  [ProviderPolicy.EXPIRY_FIRST]: '余额到期优先',
}

/**
 * 一个策略的标签。
 *
 * 兜底是给契约外的值留的（后端给了个没登记的枚举）：把枚举名给出来，别装作
 * 没有。
 */
function policyLabel(policy: ProviderPolicy): string {
  const label = POLICY_LABELS[policy]
  if (label) return label
  const name = (ProviderPolicy as Record<number, string>)[policy]
  return name ?? String(policy)
}

/**
 * 这个策略管什么。
 *
 * 说明跟着当前策略走：不同策略做的事不一样（单一不换人，降级才换人）。
 *
 * 兜底是给契约外的值留的：面板不知道它管什么，不编一个说法。
 */
function policyHint(policy: ProviderPolicy): string {
  switch (policy) {
    case ProviderPolicy.SINGLE:
      return '只用一个账号，不换'
    case ProviderPolicy.FALLBACK:
      return '名下的账号挨个试，一个接不了就换下一个'
    case ProviderPolicy.EXPIRY_FIRST:
      return '先用赠金最先到期的那本，不换'
    default:
      return policy === ProviderPolicy.UNSPECIFIED
        ? '服务端没给这个平台的策略'
        : '服务端给了一个面板不认识的策略'
  }
}

/**
 * 平台的「生效策略」。
 *
 * 一个平台下有几个账号时，这个策略决定先调谁、失败后换谁。可选的是哪几个由
 * 平台自己说（`policies`），当前值是平台自己说（`policy`）—— 面板不按 kind
 * 猜。
 */
export function ProviderPolicySelect({
  upstream,
  listUpdatedAt,
}: {
  /** 一个平台：平台视图的那一行。 */
  upstream: Upstream
  /**
   * 平台列表这一次的取数时间。
   *
   * 列表每取回来一次，面板就以服务端的值为准。看的不是服务端的值有没有变 ——
   * 值没变的时候（保存没落库、别的面板改回去了）也要回到它。
   */
  listUpdatedAt: number
}) {
  const setPolicy = useSetPlatformPolicy()

  // 这个平台支持哪几个策略：后端在这一行上说了，不用另问一次。
  const offered = upstream.policies
  // 平台下的账号数：后端给。自己数 accounts 会跟后端不一致（页面拿到的列表也
  // 可能是旧的）。
  const accountCount = upstream.accountCount

  // 只有一个账号就没有「先调谁」可选：显示出来，但禁用。
  const onlyOneAccount = accountCount === 1
  // 后端没给这个平台列出策略：没什么可选的。
  const noChoice = offered.length === 0

  // 刚选的值：等服务端的答复回来之前，先把用户选的显示出来。
  const [picked, setPicked] = useState<ProviderPolicy | null>(null)
  // 列表取回来一次就以服务端的值为准：没落库的值不留在屏幕上。
  useEffect(() => {
    setPicked(null)
  }, [listUpdatedAt, upstream.id])

  const current = picked ?? upstream.policy
  const currentLabel = policyLabel(current)
  // 当前值不在后端给的选项里（这个平台后来不登记这个策略了，或者库里存着一个
  // 不支持的值）：把它补进选项，标成「当前」且不可选 —— 不能让占位符替服务端
  // 说话，服务端有值，面板就说有值。
  const outsideOptions =
    upstream.policy !== ProviderPolicy.UNSPECIFIED &&
    !offered.includes(upstream.policy)
      ? upstream.policy
      : null
  const options = outsideOptions === null ? offered : [...offered, outsideOptions]
  const selectId = `platform-policy-${upstream.id}`
  const descId = `${selectId}-desc`

  const stateText = onlyOneAccount
    ? '这个平台只有一个账号，策略不生效'
    : noChoice
      ? '这个平台没有可选策略'
      : accountCount === 0
        ? '这个平台还没有账号，策略先设着'
        : ''
  // 有状态要说状态（为什么是禁用、为什么取不到），没有状态才说这个策略管什么。
  const description =
    stateText ||
    (current === ProviderPolicy.UNSPECIFIED || offered.includes(current)
      ? policyHint(current)
      : `当前：${currentLabel}（这个平台没有这个选项）`)

  return (
    <div className='grid gap-0.5'>
      <Label htmlFor={selectId} className='sr-only'>
        {`生效策略（${upstream.id}）`}
      </Label>
      <Select
        // UNSPECIFIED 是契约外的值（服务端没给这个字段，或者给了个没登记的
        // 枚举）：空值让 Radix 显占位符。
        value={current === ProviderPolicy.UNSPECIFIED ? '' : String(current)}
        disabled={onlyOneAccount || noChoice || setPolicy.isPending}
        onValueChange={(value) => {
          const policy = Number(value) as ProviderPolicy
          setPicked(policy)
          setPolicy.mutate(
            { platform: upstream.id, policy },
            {
              // 没改成：回到服务端给的值，别把没保存的当生效了。
              onError: () => setPicked(null),
            }
          )
        }}
      >
        <SelectTrigger
          id={selectId}
          className='w-40'
          // 名字带上平台：九个平台各有一个这样的选择器，同名的话读屏器和
          // 自动化都分不清点的是哪一个。
          aria-label={`生效策略（${upstream.id}）`}
          aria-describedby={descId}
        >
          {/* 触发器上的字由面板给。Radix 自己找选项里的字：当前值不在选项里的
              时候它找不到，值就成了占位符「未设置」——那是替服务端说话。 */}
          <SelectValue placeholder='未设置'>{currentLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((policy) => (
            <SelectItem
              key={policy}
              value={String(policy)}
              disabled={policy === outsideOptions}
            >
              {policy === outsideOptions
                ? `${policyLabel(policy)}（当前）`
                : policyLabel(policy)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={descId} aria-live='polite' className='text-xs text-muted-foreground'>
        {description}
      </p>
    </div>
  )
}
