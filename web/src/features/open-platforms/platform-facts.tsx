import type {
  QuotaPlugin,
  Upstream,
} from '@/gen/buddy/admin/v1/admin_pb'
import { hasQuota, QuotaSummary } from '@/features/balance/quota'
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
 *
 * 额度的三种「不知道」都是未知，不是 0：没选插件、插件没登记、快照里没这一份。
 * 0 说的是「一点不剩」，那是替上游说它没说过的话。
 */
export function OpenPlatformFacts({
  upstream,
  plugins,
  refresh,
}: {
  upstream: Upstream
  plugins: QuotaPlugin[]
  /** 上一次刷新模型目录的结果。 */
  refresh?: RefreshOutcome
}) {
  const plugin = plugins.find((item) => item.id === upstream.quotaPlugin)

  return (
    <div className='grid gap-0.5 text-xs whitespace-normal text-muted-foreground'>
      <span className='font-mono break-all'>{upstream.baseUrl}</span>
      <span>{modelLine(upstream)}</span>
      <span>{pluginLine(upstream, plugin)}</span>
      <span>{quotaLine(upstream, plugin)}</span>
      {refresh ? (
        <span className={refresh.ok ? undefined : 'text-destructive'}>
          刷新：{refresh.message}
        </span>
      ) : null}
    </div>
  )
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

/** 额度插件：登记了的说它的名字，没登记的说它的 id。 */
function pluginLine(upstream: Upstream, plugin?: QuotaPlugin): string {
  if (!upstream.quotaPlugin) return '额度插件：未选插件'
  if (!plugin) return `额度插件：${upstream.quotaPlugin}（没登记）`
  return `额度插件：${plugin.label}`
}

/**
 * 额度：插件算出来的值，或者「未知」。
 *
 * 三种「不知道」都不是 0：没选插件、插件没登记、快照里没这一份。
 */
function quotaLine(upstream: Upstream, plugin?: QuotaPlugin) {
  if (!upstream.quotaPlugin) {
    return '额度：未知（没选插件）'
  }
  if (!plugin) {
    return '额度：未知（插件没登记）'
  }
  if (!hasQuota(upstream.quota)) {
    return '额度：未知（还没问到）'
  }
  return (
    <div className='grid gap-0.5'>
      <span>额度：{plugin.label}</span>
      <QuotaSummary quota={upstream.quota} align='start' />
    </div>
  )
}
