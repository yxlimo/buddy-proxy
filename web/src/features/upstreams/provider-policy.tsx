import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useProviderKinds, useSetProviderPolicy } from '@/features/upstreams/api'
import { ProviderPolicy } from '@/gen/buddy/admin/v1/admin_pb'
import type { Upstream } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 策略的中文标签。
 *
 * 后端也有一份：lib/admin/policy.ts 的 POLICY_LABELS。两边要一起改 ——
 * 后端的 toast（策略改成了降级）与面板的下拉是同屏出现的。
 */
const POLICY_LABELS: Partial<Record<ProviderPolicy, string>> = {
  [ProviderPolicy.SINGLE]: '单一',
  [ProviderPolicy.FALLBACK]: '降级',
  [ProviderPolicy.EXPIRY_FIRST]: '余额到期优先',
}

/**
 * 一个策略的标签。
 *
 * 兜底是给契约外的值留的（后端给了个没登记的枚举）：把枚举名给出来，
 * 别装作没有。
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
 * 说明跟着当前策略走：不同策略做的事不一样（单一不换人，降级才换人），
 * 一句通用的话对只登记了「单一」的那一类上游是不准的。
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
        ? '服务端没给这个上游的策略'
        : '服务端给了一个面板不认识的策略'
  }
}

/**
 * 上游的「生效策略」。
 *
 * 一个上游名下有多个账号（租户）时，这个策略决定先调谁、失败后换谁。
 * 可选的策略来自后端（这一类上游支持哪些），当前值来自上游自己。
 */
export function ProviderPolicySelect({
  upstream,
  listUpdatedAt,
}: {
  upstream: Upstream
  /**
   * 上游列表这一次的取数时间。
   *
   * 列表每取回来一次，面板就以服务端的值为准。看的不是服务端的值有没有变
   * —— 值没变的时候（保存没落库、别的面板改回去了）也要回到它。
   */
  listUpdatedAt: number
}) {
  const kinds = useProviderKinds()
  const setPolicy = useSetProviderPolicy()

  // 这一类上游支持哪些策略：面板不问后端有哪些类，它问。
  const kind = kinds.data?.kinds.find((item) => item.kind === upstream.kind)
  const offered = kind?.policies ?? []
  // 策略列表还没取到、取失败，和「这一类上游没有可选策略」是三件事。
  const kindsPending = kinds.isPending
  const kindsFailed = kinds.isError
  const kindsReady = !kindsPending && !kindsFailed

  // 账号数由后端给：上游的形态不一样（开放平台一把 key 一个租户，中转站一个
  // 账号一个钱包），面板自己数账号列表会数错。
  const accountCount = upstream.accountCount

  // 只有一个账号就没有「先调谁」可选：显示出来，但禁用。
  const onlyOneAccount = accountCount === 1
  // 后端没给这一类上游列出策略：没什么可选的。
  const noChoice = kindsReady && offered.length === 0

  // 刚选的值：等服务端的答复回来之前，先把用户选的显示出来。
  const [picked, setPicked] = useState<ProviderPolicy | null>(null)
  // 列表取回来一次就以服务端的值为准：没落库的值不留在屏幕上。
  useEffect(() => {
    setPicked(null)
  }, [listUpdatedAt, upstream.id])

  const current = picked ?? upstream.policy
  const currentLabel = policyLabel(current)
  // 当前值不在后端给的选项里（这一类后来不登记这个策略了，或者库里存着一个
  // 这一类不支持的值）：把它补进选项，标成「当前」且不可选 —— 不能让占位符
  // 替服务端说话，服务端有值，面板就说有值。
  const outsideOptions =
    upstream.policy !== ProviderPolicy.UNSPECIFIED &&
    !offered.includes(upstream.policy)
      ? upstream.policy
      : null
  const options = outsideOptions === null ? offered : [...offered, outsideOptions]
  const selectId = `provider-policy-${upstream.id}`
  const descId = `${selectId}-desc`

  const stateText = kindsPending
    ? '正在取这一类上游支持的策略'
    : kindsFailed
      ? '取策略列表失败'
      : onlyOneAccount
        ? '这个上游只有一个账号，策略不生效'
        : noChoice
          ? '这一类上游没有可选策略'
          : accountCount === 0
            ? '这个上游没有可切换的账号，策略先设着'
            : ''
  // 有状态要说状态（为什么是禁用、为什么取不到），没有状态才说这个策略
  // 管什么。
  const description =
    stateText ||
    (current === ProviderPolicy.UNSPECIFIED || offered.includes(current)
      ? policyHint(current)
      : `当前：${currentLabel}（这一类上游没有这个选项）`)

  return (
    <div className='grid gap-2 p-4 pb-0'>
      <div className='flex flex-wrap items-center gap-3'>
        <Label htmlFor={selectId}>生效策略</Label>
        <Select
          // UNSPECIFIED 是契约外的值（服务端没给这个字段，或者给了个没登记
          // 的枚举）：空值让 Radix 显占位符。
          value={current === ProviderPolicy.UNSPECIFIED ? '' : String(current)}
          disabled={onlyOneAccount || noChoice || !kindsReady || setPolicy.isPending}
          onValueChange={(value) => {
            const policy = Number(value) as ProviderPolicy
            setPicked(policy)
            setPolicy.mutate(
              { upstreamId: upstream.id, policy },
              {
                // 没改成：回到服务端给的值，别把没保存的当生效了。
                onError: () => setPicked(null),
              }
            )
          }}
        >
          <SelectTrigger
            id={selectId}
            className='w-48'
            aria-label='生效策略'
            aria-describedby={descId}
          >
            {/* 触发器上的字由面板给。Radix 自己找选项里的字：当前值不在选项里
                的时候它找不到，值就成了占位符「未设置」——那是替服务端说话。 */}
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
      </div>
      <div className='flex items-center gap-2'>
        <p
          id={descId}
          aria-live='polite'
          className='text-xs text-muted-foreground'
        >
          {description}
        </p>
        {/* 取策略列表失败没有别的入口：给个重试，别让用户刷新整个页面。 */}
        {kindsFailed ? (
          <Button
            variant='ghost'
            size='sm'
            onClick={() => void kinds.refetch()}
          >
            重试
          </Button>
        ) : null}
      </div>
    </div>
  )
}
