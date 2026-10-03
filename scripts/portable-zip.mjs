/**
 * portable-zip.mjs — turn electron-builder's plain `zip` artifact into a self-contained
 * portable build by adding the two entries the runtime looks for next to `VFox.exe`:
 *
 *   portable      a marker file (the runtime's portable-mode switch)
 *   data/         the directory every profile, setting and the downloaded engine goes into
 *   data/README.txt   so `data/` survives every extractor, not just the ones that honour
 *                     zero-length directory entries
 *
 * electron-builder builds `win-unpacked/` once and then produces both the NSIS installer and
 * the zip from it, so the markers cannot be injected through `extraFiles` without also
 * putting them inside the installed app — which would silently move the *installed* build
 * into portable mode. Instead the finished zip is amended in place.
 *
 * The amendment is append-only and never re-compresses an existing entry:
 *   [old local entries + data][new local entries][old central directory][new cd][new EOCD]
 * Every pre-existing local-header offset stays valid because nothing before the central
 * directory is moved, which keeps a ~300 MB archive a sub-second operation.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const DIRECTORY_ATTRIBUTE = 0x10
const VERSION_MADE_BY = 20
/** Fixed DOS timestamp (1980-01-01 00:00) keeps the added entries byte-reproducible. */
const DOS_TIME = 0
const DOS_DATE = 33

export const PORTABLE_MARKER = 'portable'
export const PORTABLE_DATA_DIR = 'data/'
export const PORTABLE_DATA_README = 'data/README.txt'

const MARKER_TEXT = `VFox portable mode marker.

While this file exists next to VFox.exe (or a "data" directory does), VFox keeps every
profile, setting and the downloaded Camoufox engine inside the data/ directory beside the
executable instead of %APPDATA%\\VFox. The whole folder can be moved to another machine or
drive and keeps working.

Delete this file to go back to %APPDATA%\\VFox.
`

const DATA_README_TEXT = `This is VFox's portable data directory.

It holds your profiles, your settings and the downloaded Camoufox engine. Move this folder
together with VFox.exe and everything keeps working.

A real file is shipped inside this directory on purpose: zip tools are not required to
preserve empty directories, and VFox only switches to portable mode when "data" exists.
`

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

/** @param {Buffer} buffer @returns {number} */
function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** @param {string} zipPath @returns {number} the End Of Central Directory record offset */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error(`${zipPath} has no End Of Central Directory record`)
}

/**
 * Append `entries` to an existing zip file without rewriting any existing byte.
 *
 * @param {string} zipPath
 * @param {{ name: string, data?: Buffer, directory?: boolean }[]} entries
 * @returns {string[]} the names that were added
 */
export function appendZipEntries(zipPath, entries) {
  const buffer = readFileSync(zipPath)
  const eocd = findEndOfCentralDirectory(buffer)

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error(`${zipPath} uses ZIP64, which this append-only writer does not support`)
  }
  if (buffer.readUInt32LE(centralOffset) !== CENTRAL_SIGNATURE) {
    throw new Error(`${zipPath} has a corrupt central directory at offset ${centralOffset}`)
  }

  const beforeCentral = buffer.subarray(0, centralOffset)
  const centralDirectory = buffer.subarray(centralOffset, centralOffset + centralSize)

  const localParts = []
  const centralParts = []
  let localOffset = beforeCentral.length

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.directory ? Buffer.alloc(0) : (entry.data ?? Buffer.alloc(0))
    const checksum = crc32(data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(VERSION_MADE_BY, 4)
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    name.copy(local, 30)
    localParts.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(VERSION_MADE_BY, 4)
    central.writeUInt16LE(VERSION_MADE_BY, 6)
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(0, 10) // method: stored
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(entry.directory ? DIRECTORY_ATTRIBUTE : 0, 38)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    centralParts.push(central)

    localOffset += local.length + data.length
  }

  const newLocalBytes = Buffer.concat(localParts)
  const newCentralBytes = Buffer.concat(centralParts)
  // The new file is [beforeCentral][newLocalBytes][centralDirectory][newCentralBytes][EOCD],
  // so the central directory now begins right after the appended local entries.
  const newCentralOffset = beforeCentral.length + newLocalBytes.length
  const newCentralSize = centralDirectory.length + newCentralBytes.length
  const newEntryCount = entryCount + entries.length
  if (newEntryCount > 0xffff) {
    throw new Error(`${zipPath} would exceed the 65535-entry zip limit`)
  }

  const newEocd = Buffer.alloc(22)
  newEocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  newEocd.writeUInt16LE(0, 4)
  newEocd.writeUInt16LE(0, 6)
  newEocd.writeUInt16LE(newEntryCount, 8)
  newEocd.writeUInt16LE(newEntryCount, 10)
  newEocd.writeUInt32LE(newCentralSize, 12)
  newEocd.writeUInt32LE(newCentralOffset, 16)
  newEocd.writeUInt16LE(0, 20)

  writeFileSync(
    zipPath,
    Buffer.concat([beforeCentral, newLocalBytes, centralDirectory, newCentralBytes, newEocd]),
  )
  return entries.map(entry => entry.name)
}

/**
 * Make a built portable zip self-contained. Idempotent: running it twice adds nothing.
 *
 * @param {string} zipPath
 * @returns {string[]} the names that were added
 */
export function addPortableMarkers(zipPath) {
  const buffer = readFileSync(zipPath)
  const eocd = findEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const existing = new Set()
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(
        `${zipPath}: central directory record ${i + 1} of ${entryCount} is missing at ` +
          `offset ${offset} — refusing to append to a file this writer cannot read back`,
      )
    }
    const nameLength = buffer.readUInt16LE(offset + 28)
    existing.add(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }

  const wanted = [
    { name: PORTABLE_MARKER, data: Buffer.from(MARKER_TEXT, 'utf8') },
    { name: PORTABLE_DATA_DIR, directory: true },
    { name: PORTABLE_DATA_README, data: Buffer.from(DATA_README_TEXT, 'utf8') },
  ].filter(entry => !existing.has(entry.name))

  if (wanted.length === 0) return []
  return appendZipEntries(zipPath, wanted)
}
