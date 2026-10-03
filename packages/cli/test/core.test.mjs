import { describe, expect, it } from 'vitest'

import { CliError, parseProxyUrl, resolveGroup, resolveProfile } from '../dist/core.js'

describe('parseProxyUrl', () => {
  it('parses a socks5 URL with credentials', () => {
    expect(parseProxyUrl('socks5://user:p%40ss@127.0.0.1:1080')).toEqual({
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'user',
      password: 'p@ss',
    })
  })

  it('parses http and https URLs', () => {
    expect(parseProxyUrl('http://proxy.local:3128')).toEqual({
      type: 'http',
      host: 'proxy.local',
      port: 3128,
    })
    expect(parseProxyUrl('https://proxy.local')).toEqual({
      type: 'https',
      host: 'proxy.local',
      port: 443,
    })
  })

  it('defaults a scheme port when none is given', () => {
    expect(parseProxyUrl('socks5://proxy.local').port).toBe(1080)
    expect(parseProxyUrl('http://proxy.local').port).toBe(8080)
  })

  it('rejects an unsupported scheme', () => {
    expect(() => parseProxyUrl('ftp://proxy.local:21')).toThrow(/Unsupported proxy scheme/)
  })

  it('rejects a bare host:port, which URL() reads as a scheme', () => {
    expect(() => parseProxyUrl('proxy.local:1080')).toThrow(/Unsupported proxy scheme/)
  })

  it('rejects a URL without a host', () => {
    expect(() => parseProxyUrl('socks5://:1080')).toThrow(/--proxy must be a URL/)
  })
})

function fakeCore(profiles) {
  return {
    profiles: {
      get: async id => profiles.find(profile => profile.id === id),
      list: async () => profiles,
    },
    groups: {
      list: async () => [],
      create: async name => ({ id: `g-${name}`, name, createdAt: 'now' }),
    },
  }
}

describe('resolveProfile', () => {
  const profiles = [
    { id: 'p1', name: 'Alpha' },
    { id: 'p2', name: 'Beta' },
  ]

  it('resolves by id', async () => {
    expect((await resolveProfile(fakeCore(profiles), 'p1')).name).toBe('Alpha')
  })

  it('resolves by name case-insensitively', async () => {
    expect((await resolveProfile(fakeCore(profiles), 'beta')).id).toBe('p2')
  })

  it('fails on an unknown target', async () => {
    await expect(resolveProfile(fakeCore(profiles), 'ghost')).rejects.toThrow(CliError)
    await expect(resolveProfile(fakeCore(profiles), 'ghost')).rejects.toThrow(/Unknown profile/)
  })

  it('fails on an ambiguous name', async () => {
    const duplicated = [
      { id: 'p1', name: 'Same' },
      { id: 'p2', name: 'same' },
    ]
    await expect(resolveProfile(fakeCore(duplicated), 'Same')).rejects.toThrow(/ambiguous/)
  })
})

describe('resolveGroup', () => {
  const core = fakeCore([])

  it('creates the group when asked', async () => {
    expect(await resolveGroup(core, 'Work', { create: true })).toMatchObject({ name: 'Work' })
  })

  it('fails when the group is missing and creation is not allowed', async () => {
    await expect(resolveGroup(core, 'Nope', { create: false })).rejects.toThrow(/Unknown group/)
  })
})
