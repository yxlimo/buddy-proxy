import type { ModelBilling } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 上游报的这份计费在面板上怎么写。
 *
 * 只看 `billing` 自己那几个字段，不看是哪个平台报的：换平台、换方言都不改动这里。
 * 写不出来就返回 `null`（界面上什么都不摆），不写「没报」这类占位说法。
 *
 * `unknown === true` 是第一等判据：上游报了一份全 0 又没单位的东西，那是「不知道」，
 * 不是「免费」。写出来就成了把不知道说成 0 元，所以这种情况下一个字都不给。
 */
export function billingLine(billing: ModelBilling | undefined): string | null {
  if (!billing || billing.unknown) return null
  const price = priceText(billing)
  if (price === null) return null
  const windows = multipliersText(billing.multipliers)
  return windows === null ? price : `${price}，${windows}`
}

/** 币种符号：认得的写符号，不认得的把币种原样写在数字前面，没有币种就只写数字。 */
const CURRENCIES: Record<string, string> = {
  CNY: '¥',
  USD: '$',
}

/** 数：整数不带小数点，小数按需保留（最多六位，不给一串浮点尾巴）。 */
const priceFormat = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 6,
})

function currencyPrefix(currency: string): string {
  const code = currency.trim().toUpperCase()
  if (code === '') return ''
  const symbol = CURRENCIES[code]
  return symbol === undefined ? `${code} ` : symbol
}

function priceText(billing: ModelBilling): string | null {
  const mode = billing.mode.trim()
  if (mode === 'token') {
    const unit = currencyPrefix(billing.currency)
    const parts: string[] = []
    const add = (label: string, value: number | undefined) => {
      if (value === undefined || !Number.isFinite(value)) return
      parts.push(`${label} ${unit}${priceFormat.format(value)}`)
    }
    add('输入', billing.inputPerMillion)
    add('输出', billing.outputPerMillion)
    add('缓存读', billing.cacheReadPerMillion)
    if (parts.length === 0) return null
    return `${parts.join(' / ')} 每百万 token`
  }
  if (mode === 'multiplier') {
    const credits = billing.credits
    if (credits === undefined || !Number.isFinite(credits)) return null
    return `倍率 ×${priceFormat.format(credits)}`
  }
  // `none` 与还没有说法的模式：不摆。
  return null
}

/** 分时段倍率：只写 factor，几段就用 `/` 连起来。 */
function multipliersText(multipliers: number[]): string | null {
  const factors = multipliers
    .filter((factor) => Number.isFinite(factor))
    .map((factor) => `×${priceFormat.format(factor)}`)
  if (factors.length === 0) return null
  return `分时段倍率 ${factors.join('/')}`
}
