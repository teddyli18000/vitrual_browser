/**
 * Generates the app icon (electron-builder), the window icon and the tray icon.
 *
 * Dependency-free on purpose: a 200-line PNG writer with zlib beats adding an image library to
 * the product's dependency budget for three static files that are generated once.
 *
 *   node scripts/generate-icons.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------------- PNG writer */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------------- the artwork */

const BG_FROM = [0x4a, 0x6c, 0xf7]
const BG_TO = [0x22, 0xc1, 0xc3]
const GLYPH = [0xff, 0xff, 0xff]

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/** Signed distance to a rounded square centred at 0.5,0.5 in normalised units. */
function roundedSquare(x, y, half, radius) {
  const dx = Math.abs(x - 0.5) - (half - radius)
  const dy = Math.abs(y - 0.5) - (half - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/** Distance from a point to a line segment, for the two strokes of the "V". */
function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

/** One sample: is this point inside the mark, and what colour is it? */
function sample(x, y) {
  const plate = roundedSquare(x, y, 0.5, 0.22)
  if (plate > 0) return null

  const stroke = 0.052
  const left = segmentDistance(x, y, 0.3, 0.28, 0.5, 0.7)
  const right = segmentDistance(x, y, 0.5, 0.7, 0.7, 0.28)
  if (Math.min(left, right) <= stroke) return GLYPH

  return mix(BG_FROM, BG_TO, Math.min(1, Math.max(0, (x + y) / 2)))
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = size >= 128 ? 3 : 4
  const step = 1 / (size * samples)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let hits = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px * samples + sx + 0.5) * step
          const y = (py * samples + sy + 0.5) * step
          const color = sample(x, y)
          if (!color) continue
          r += color[0]
          g += color[1]
          b += color[2]
          hits += 1
        }
      }
      const total = samples * samples
      const offset = (py * size + px) * 4
      if (hits === 0) continue
      rgba[offset] = Math.round(r / hits)
      rgba[offset + 1] = Math.round(g / hits)
      rgba[offset + 2] = Math.round(b / hits)
      rgba[offset + 3] = Math.round((hits / total) * 255)
    }
  }
  return encodePng(size, size, rgba)
}

/* ----------------------------------------------------------------------------- output */

// `build/` is gitignored repo-wide, so the icons live in `resources/`, which is both the
// electron-builder buildResources directory and the extraResources payload.
const targets = [
  { file: 'resources/icon.png', size: 512 },
  { file: 'resources/tray.png', size: 32 },
]

for (const target of targets) {
  const file = join(root, target.file)
  mkdirSync(dirname(file), { recursive: true })
  const png = render(target.size)
  writeFileSync(file, png)
  console.log(`${target.file}  ${target.size}x${target.size}  ${png.length} bytes`)
}
