import type { ProfileRuntime } from '@vfox/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { type Locale, locale, setLocale } from '../i18n'

const LAST_STARTED_KEY = 'vfox.lastStarted'

/**
 * UI-only preferences. `lastStarted` is a display convenience, never authoritative: the live
 * runtime value always wins, and this cache only fills the gap after the app restarts (the
 * engine's runtime registry is in-memory by design).
 */
export const usePrefsStore = defineStore('prefs', () => {
  const language = ref<Locale>(locale.value)
  const lastStarted = ref<Record<string, string>>(readLastStarted())

  function readLastStarted(): Record<string, string> {
    try {
      const raw = globalThis.localStorage?.getItem(LAST_STARTED_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
    } catch {
      return {}
    }
  }

  function persist(): void {
    try {
      globalThis.localStorage?.setItem(LAST_STARTED_KEY, JSON.stringify(lastStarted.value))
    } catch {
      // A full quota must never break the UI.
    }
  }

  function rememberStarted(runtime: ProfileRuntime): void {
    if (runtime.status !== 'running' || !runtime.startedAt) return
    if (lastStarted.value[runtime.profileId] === runtime.startedAt) return
    lastStarted.value = { ...lastStarted.value, [runtime.profileId]: runtime.startedAt }
    persist()
  }

  function forget(profileId: string): void {
    if (!(profileId in lastStarted.value)) return
    const next = { ...lastStarted.value }
    delete next[profileId]
    lastStarted.value = next
    persist()
  }

  function lastStartedOf(profileId: string, live: string | null): string | null {
    return live ?? lastStarted.value[profileId] ?? null
  }

  function useLanguage(next: Locale): void {
    language.value = next
    setLocale(next)
  }

  return { language, lastStarted, rememberStarted, forget, lastStartedOf, useLanguage }
})
