import { ref } from 'vue'
import { en } from './en'
import { type MessageKey, type Messages, zhCN } from './zh-CN'

export type { MessageKey, Messages } from './zh-CN'

export type Locale = 'zh-CN' | 'en'

const dictionaries: Record<Locale, Messages> = { 'zh-CN': zhCN, en }

const STORAGE_KEY = 'vfox.locale'

function initialLocale(): Locale {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY)
  if (stored === 'zh-CN' || stored === 'en') return stored
  return 'zh-CN'
}

export const locale = ref<Locale>(initialLocale())

export function setLocale(next: Locale): void {
  locale.value = next
  globalThis.localStorage?.setItem(STORAGE_KEY, next)
}

/**
 * Translate `key`, replacing `{name}` placeholders. Reading `locale.value` inside the function is
 * what makes every template that calls `t()` re-render when the language changes.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = dictionaries[locale.value][key] ?? zhCN[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}
