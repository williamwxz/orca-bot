// The panel <-> worker contract.
import type { Bot, Entry } from '../shared/model'

export type Status = { ok: boolean; message: string }

export type Requests = {
  status: { input: Record<string, never>; output: Status }
  'bots.list': { input: Record<string, never>; output: Bot[] }
  'bots.create': { input: { name: string; instructions?: string }; output: Bot[] }
  'bots.update': {
    input: { id: string; name?: string; instructions?: string; hidden?: boolean }
    output: Bot[]
  }
  'bots.delete': { input: { id: string }; output: Bot[] }
  'thread.read': { input: { id: string; limit?: number }; output: Entry[] }
  'message.send': { input: { id: string; text: string }; output: { sent: true } }
}
