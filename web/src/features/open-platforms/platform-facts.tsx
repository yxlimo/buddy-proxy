import type {
  QuotaPlugin,
  Upstream,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { QuotaRegistry } from '@/features/accounts/provider-key-fields'
import { hasQuota, quotaStateText, QuotaSummary } from '@/features/balance/quota'
import {
  platformKindReadout,
  simulatedPresetOf,
  type PlatformKindList,
} from '@/features/open-platforms/platform-kinds'
import { formatLocalMoment } from '@/lib/format'

/** 一次「刷新模型目录」的结果：服务端给的，面板照它显示。 */
export type RefreshOutcome = {
  ok: boolean
  message: string
  models: string[]
}

/**
 * 开放平台的那几格：地址、模型目录、额度插件、额度。
 *
 * 面板知道的都以服务端给的为准：
 *
 *   地址、插件 id、模型目录、目录来源、上次拉取的时刻   Upstream（ListUpstreams）
 *   额度插件叫什么                                      额度插件登记表（ListQuotaPlugins）
 *   额度现在的结论                                       Upstream.quota.quotaState
 *
 * 模拟客户端（预置的那几条）不摆地址与额度插件：两格都是空串，摆出来只会让人
 * 以为要填。它们靠 id 与 kind 从清单里认出来（两个 Qoder 的 kind 相同）。
 *
 * 额度按服务端给的结论说：`ok` 给数字，其余各说一句（额度用尽、平台说这个账号
 * 不能用、凭据被拒、被限流、还没填凭据、未知），没有结论就不说这一栏。
 * 这些结论都不是 0：0 说的是「一点不剩」，那是替上游说它没说过的话。
 */
export function OpenPlatformFacts({
  upstream,
  kinds,
  registry,
  refresh,
}: {
  upstream: Upstream
  /** 建平台时能选的类型清单：三档（加载中 / 取不到 / 到手）。 */
  kinds: PlatformKindList
  /** 额度插件登记表：三档（加载中 / 取不到 / 到手）。 */
  registry: QuotaRegistry
  /** 上一次刷新模型目录的结果。 */
  refresh?: RefreshOutcome
}) {
  const simulated = simulatedPresetOf(kinds, upstream) !== undefined
  return (
    <div className='grid gap-0.5 text-xs whitespace-normal text-muted-foreground'>
      {simulated ? null : (
        <span className='font-mono break-all'>{upstream.baseUrl}</span>
      )}
      {kindLine(upstream, kinds)}
      <span>{modelLine(upstream)}</span>
      {simulated ? null : <span>{pluginLine(upstream, registry)}</span>}
      {quotaLine(upstream, registeredPlugin(upstream, registry))}
      {refresh ? (
        <span className={refresh.ok ? undefined : 'text-destructive'}>
          刷新：{refresh.message}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 类型那一行。
 *
 * 清单没到手（还在加载 / 取不到）不显示这一行 —— 那种时候说不出名字，也不该
 * 拿 raw 值顶上或者写「未知」。清单到手但没有这一条（服务端加了新方言）就摆
 * raw 值：那是服务端说的，不是猜的。判据在 platform-kinds.ts，弹窗用的是同一个。
 */
function kindLine(upstream: Upstream, kinds: PlatformKindList) {
  const kind = platformKindReadout(kinds, upstream)
  if (!kind) return null
  return <span>{`类型：${kind}`}</span>
}

/**
 * 模型目录：哪来的，外加上次拉取的时刻。
 *
 * 目录本身、来源、时刻都是服务端给的（Upstream 上的那三格）：auto 说这份目录
 * 是自动拉来的，manual 说人写的。时刻是 0 的时候说「没拉过」—— 别显示 0，
 * 也别显示 1970（那是 Unix 纪元，不是「没拉过」）。
 */
function modelLine(upstream: Upstream): string {
  const source = upstream.modelsSource
  if (source === 'manual') {
    // 目录本身也在 Upstream 上：数它有几条，不问别处。
    return `模型目录：手动配 · ${upstream.models.length} 个模型`
  }
  if (source !== 'auto') {
    // 服务端没说哪来的：不说「自动」，也不说「手动」。
    return '模型目录：来源未知'
  }
  const at =
    upstream.modelsFetchedAtMs > 0n
      ? formatLocalMoment(upstream.modelsFetchedAtMs)
      : '没拉过'
  return `模型目录：自动拉 · 上次拉取：${at}`
}

/**
 * 登记表里这个平台选的那个插件。
 *
 * 只有登记表到手了才说得准「有没有这一条」：加载中、取不到的时候一律 undefined，
 * 那种时候说「没登记」是错的。
 */
function registeredPlugin(
  upstream: Upstream,
  registry: QuotaRegistry
): QuotaPlugin | undefined {
  if (registry.status !== 'ready') return undefined
  return registry.plugins.find((item) => item.id === upstream.quotaPlugin)
}

/**
 * 额度插件那一行：三档各说一句。
 *
 *   登记表到手且里面有这个 id   插件自己的名字
 *   登记表到手但没有这个 id     未知插件 <id>
 *   加载中 / 取不到             说登记表还没到手 / 取不到 —— 不说成「没登记」
 */
function pluginLine(upstream: Upstream, registry: QuotaRegistry): string {
  const id = upstream.quotaPlugin
  if (!id) return '额度插件：未选'
  const plugin = registeredPlugin(upstream, registry)
  if (plugin) return `额度插件：${plugin.label}`
  if (registry.status === 'pending') return `额度插件：${id}（列表还在加载）`
  if (registry.status === 'error') return `额度插件：${id}（列表取不到）`
  return `额度插件：未知插件 ${id}`
}

/**
 * 额度那一栏。
 *
 * 先说结论，再说数字 —— 两样不会同时有（契约里只有 `ok` 带数字）：
 *
 *   `ok`                数字那几行
 *   `no_quota`          额度用尽（有恢复时刻就说什么时候恢复）
 *   `blocked`           平台说这个账号不能用 + 恢复时刻
 *   `unauthorized`      凭据被拒
 *   `rate_limited`      被限流 + 恢复时刻
 *   `missing`           还没填凭据
 *   `unknown`           未知
 *   其余值（服务端新加的） 原样显示
 *   空串（没有结论）     整栏不显示
 *
 * 结论只看 `quotaState`：插件登记表到没到手，跟服务端说的结论无关 —— 登记表没
 * 到手就藏掉「额度用尽」，等于把服务端的话丢了。只有数字那几行需要插件名，
 * 名字说不准的时候摆 id。
 */
function quotaLine(upstream: Upstream, plugin?: QuotaPlugin) {
  const quota = upstream.quota
  if (!quota) return null

  const state = quotaStateText(quota)
  if (state) {
    return (
      <div className='grid gap-0.5'>
        <span>{state}</span>
        {/* 插件那句话放第二行：状态名在上面，不会因为这句话为空就变成猜。 */}
        {quota.message ? <span>{quota.message}</span> : null}
      </div>
    )
  }
  // 没有结论也没有数字：这一份答复对额度什么都没说。
  if (!hasQuota(quota)) return null
  return (
    <div className='grid gap-0.5'>
      {/* 插件名说不准（登记表没到手 / 没有这一条）的时候摆 id：不猜名字，也不
          因为这就不显示数字。 */}
      <span>额度：{plugin?.label ?? upstream.quotaPlugin}</span>
      <QuotaSummary quota={quota} align='start' />
    </div>
  )
}
