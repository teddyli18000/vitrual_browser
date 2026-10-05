import { FingerprintSchema } from '@vfox/shared'
import { describe, expect, it, vi } from 'vitest'
import { toEngineOptions, toEngineProxy } from '../src/fingerprint.js'

const base = FingerprintSchema.parse({})

describe('toEngineOptions', () => {
  it('maps every fingerprint field onto the engine option names', () => {
    const fingerprint = FingerprintSchema.parse({
      os: 'macos',
      screen: { minWidth: 1280, maxWidth: 1920, minHeight: 800, maxHeight: 1080 },
      window: { width: 1440, height: 900 },
      webgl: { vendor: 'Google Inc.', renderer: 'ANGLE (Intel)' },
      fonts: ['Arial'],
      locale: 'en-US,en',
      geoip: false,
      humanize: true,
      blockImages: true,
      blockWebrtc: true,
      blockWebgl: true,
      disableCoop: true,
      hardwareConcurrency: 8,
      userAgent: 'Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/152.0',
      config: { 'navigator.maxTouchPoints': 5 },
    })

    expect(toEngineOptions(fingerprint, { type: 'socks5', host: '10.0.0.1', port: 1080 })).toEqual({
      os: 'macos',
      screen: { minWidth: 1280, maxWidth: 1920, minHeight: 800, maxHeight: 1080 },
      window: [1440, 900],
      webgl_config: ['Google Inc.', 'ANGLE (Intel)'],
      fonts: ['Arial'],
      locale: 'en-US,en',
      geoip: false,
      humanize: true,
      block_images: true,
      block_webrtc: true,
      block_webgl: true,
      disable_coop: true,
      config: {
        'navigator.maxTouchPoints': 5,
        'navigator.hardwareConcurrency': 8,
        'navigator.userAgent': 'Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/152.0',
      },
      proxy: { server: 'socks5://10.0.0.1:1080', username: undefined, password: undefined },
    })
  })

  it('leaves the engine to generate everything that is null', () => {
    expect(toEngineOptions(base, null)).toEqual({
      os: 'windows',
      screen: undefined,
      window: undefined,
      webgl_config: undefined,
      fonts: undefined,
      locale: undefined,
      geoip: true,
      // `base` is `FingerprintSchema.parse({})`, so this is the *default* the engine is handed;
      // `humanize` defaults to true (see the humanize-default test in packages/shared).
      humanize: true,
      block_images: false,
      block_webrtc: false,
      block_webgl: false,
      disable_coop: false,
      config: {},
      proxy: undefined,
    })
  })

  it('merges the raw config escape hatch last, so it wins over the derived keys', () => {
    const fingerprint = FingerprintSchema.parse({
      hardwareConcurrency: 8,
      config: { 'navigator.hardwareConcurrency': 99 },
    })
    expect(toEngineOptions(fingerprint, null).config).toEqual({
      'navigator.hardwareConcurrency': 99,
    })
  })

  it('reports deviceMemory instead of silently dropping or faking it', () => {
    const warn = vi.fn()
    const fingerprint = FingerprintSchema.parse({ deviceMemory: 16 })
    const options = toEngineOptions(fingerprint, null, warn)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('deviceMemory')
    expect(options.config).toEqual({})
  })
})

describe('toEngineProxy', () => {
  it('builds <type>://<host>:<port> and keeps the credentials', () => {
    expect(
      toEngineProxy({
        type: 'https',
        host: 'proxy.example.com',
        port: 8443,
        username: 'user',
        password: 'secret',
      }),
    ).toEqual({ server: 'https://proxy.example.com:8443', username: 'user', password: 'secret' })
  })

  it('is undefined without a proxy', () => {
    expect(toEngineProxy(null)).toBeUndefined()
    expect(toEngineProxy(undefined)).toBeUndefined()
  })
})
