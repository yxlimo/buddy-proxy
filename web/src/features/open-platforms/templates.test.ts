import { describe, expect, it } from 'vitest'
import { PLATFORM_TEMPLATES } from './templates'
import templatesRaw from './templates.json?raw'

/** 仓库里那份数据文件的原文（?raw 走 vite，读的是磁盘上的文件）。 */
function readRawTemplates(): unknown {
  return JSON.parse(templatesRaw)
}

describe('模板的数据文件', () => {
  it('JSON 与面板用的表是同一份，每条都有 id/label/baseUrl', () => {
    const rows = readRawTemplates()

    // 数据文件本身：条数固定，少一条就是有人动过。
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(88)

    // 与类型层导出的那张表逐条对得上。
    expect(PLATFORM_TEMPLATES).toHaveLength((rows as unknown[]).length)
    expect(PLATFORM_TEMPLATES).toEqual(rows)

    for (const row of rows as Record<string, unknown>[]) {
      expect(typeof row.id).toBe('string')
      expect(typeof row.label).toBe('string')
      expect(typeof row.baseUrl).toBe('string')
      expect(row.id).not.toBe('')
      expect(row.label).not.toBe('')
      expect(row.baseUrl).not.toBe('')
    }
  })
})
