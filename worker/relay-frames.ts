import { gunzipSync, gzipSync } from 'node:zlib'

// Orca's terminal stream drops some spaces and keeps only the newest 2000 lines, so replies
// are short space-free lines sent a window at a time. Gzip's checksum catches any damage.
export const FRAME_SIZE = 48
export const WINDOW = 400
export const NEXT = 'n'
export const READY = '@bt:ready'

export const pack = (value: unknown): string => gzipSync(JSON.stringify(value)).toString('base64')
/** The largest packed line and unpacked request a host reads from a client. */
export const MAX_LINE = 400_000
export const MAX_REQUEST_BYTES = 1_000_000
/** The largest reply a client unpacks: a full page of long messages fits with room to spare. */
export const MAX_REPLY_BYTES = 16_000_000
export const unpack = (data: string, maxBytes = MAX_REPLY_BYTES): any =>
  JSON.parse(gunzipSync(Buffer.from(data, 'base64'), { maxOutputLength: maxBytes }).toString('utf8'))

export function frames(id: string, value: unknown): string[] {
  const parts = pack(value).match(new RegExp(`.{1,${FRAME_SIZE}}`, 'g')) ?? ['']
  return parts.map((part, i) => `@bt:${id}:${i + 1}:${parts.length}:${part}`)
}

export type Frame = { id: string; index: number; total: number; data: string }
export function parseFrame(line: string): Frame | undefined {
  const match = /^@bt:([A-Za-z0-9-]+):(\d+):(\d+):([A-Za-z0-9+/=]*)$/.exec(line.trim())
  return match
    ? { id: match[1], index: Number(match[2]), total: Number(match[3]), data: match[4] }
    : undefined
}

/**
 * Splits raw terminal input into complete lines, keeping a partial last line for later. A line
 * longer than `maxLine` is dropped whole, up to its end, so input without a line break cannot grow
 * the buffer without limit.
 */
export function lineReader(onLine: (line: string) => void, maxLine = Infinity): (chunk: string) => void {
  let buffer = ''
  let skipping = false
  return (chunk) => {
    buffer += chunk
    let end: number
    while ((end = buffer.search(/[\r\n]/)) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (skipping) skipping = false
      else if (line && line.length <= maxLine) onLine(line)
    }
    if (buffer.length > maxLine) {
      buffer = ''
      skipping = true
    }
  }
}

/** Panel requests answered by a paired server; choosing the host stays on this computer. */
export const RELAYED = ['status', 'bots.list', 'thread.read', 'message.send'] as const
export const PING = 'relay.ping'

/** Nothing reaches a server's worker unshaped: every relayed input is a small plain object. */
export function validateRelayInput(name: unknown, input: unknown): void {
  if (input === undefined || input === null) return
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request.')
  if (JSON.stringify(input).length > 40000) throw new Error('This request is too large.')
  void name
}
