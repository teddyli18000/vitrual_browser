/// <reference types="vite/client" />

import type { VfoxBridge } from '../../shared/bridge'

declare global {
  interface Window {
    vfox: VfoxBridge
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

export {}
