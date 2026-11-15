// The panel <-> worker contract. A write answers with the fresh bot list, or null when the
// write worked but the list could not be read; the panel then reloads the list itself.
import type { StatusLine } from '../shared/status.ts'
import type { Bot, Entry } from '../shared/model.ts'

export type Status = { ok: boolean; message: string }

export type Requests = {
  'status.read': { input: { id: string }; output: StatusLine }
  status: { input: Record<string, never>; output: Status }
  'bots.list': { input: Record<string, never>; output: Bot[] }
  'bots.create': { input: { name: string; instructions?: string }; output: Bot[] | null }
  'bots.update': {
    input: { id: string; name?: string; instructions?: string; hidden?: boolean }
    output: Bot[] | null
  }
  'bots.delete': { input: { id: string }; output: Bot[] | null }
  'thread.read': { input: { id: string; limit?: number }; output: Entry[] }
  'message.send': { input: { id: string; text: string }; output: { sent: true } }
}
