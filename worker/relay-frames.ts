import { validateBotCreate } from '../shared/roster.ts'
import { validateModelSelection } from '../shared/models.ts'
import { gunzipSync, gzipSync } from 'node:zlib'

// Orca's terminal stream drops some spaces and keeps only the newest 2000 lines, so replies
// are short space-free lines sent a window at a time. Gzip's checksum catches any damage.
export const FRAME_SIZE = 48
export const WINDOW = 400
export const NEXT = 'n'
export const READY = '@bt:ready'

export const pack = (value: unknown): string => gzipSync(JSON.stringify(value)).toString('base64')
export const unpack = (data: string): any =>
  JSON.parse(gunzipSync(Buffer.from(data, 'base64')).toString('utf8'))

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

/** Splits raw terminal input into complete lines, keeping a partial last line for later. */
export function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let end: number
    while ((end = buffer.search(/[\r\n]/)) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line) onLine(line)
    }
  }
}

/** Panel requests answered by a paired server; host selection and plugin updates stay local. */
export const RELAYED = [
  'models.list',
  'mcp.list',
  'mcp.act',
  'status',
  'bots.list',
  'bots.create',
  'bots.act',
  'groups.rename',
  'thread.read',
  'computer.status',
  'desktop.status',
  'desktop.step',
  'desktop.act',
  'desktop.settings',
  'browser.install',
  'learning.read',
  'learning.skill',
  'learning.settings',
  'team.export',
  'team.export.status',
  'memory.save',
  'schedules.list',
  'schedules.act',
  'message.send',
  'bots.addMausBot',
  'chat.open',
  'setup.get',
  'setup.answer',
  'prefs.get',
  'prefs.set',
  'server.install',
  'server.stop'
] as const
export const PING = 'relay.ping'

export function validateRelayInput(name: unknown, input: unknown): void {
  if (name === 'bots.create') validateBotCreate(input)
  if (name !== 'bots.act' || !input || typeof input !== 'object') return
  const action = input as Record<string, unknown>
  if (action.action === 'model') validateModelSelection(action.instanceId, action.model)
}
