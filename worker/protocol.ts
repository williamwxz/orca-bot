import type { Bot, Status, Thread } from '../shared/bots.ts'
import type { Hosts } from './paired-host.ts'

export type Requests = {
  /** Whether Hermes can be reached on the bot host. */
  status: { input: { retry?: boolean }; output: Status }
  'bots.list': { input: Record<string, never>; output: Bot[] }
  /** A page of the bot's Bot Chat: the newest, or the one before `older`. */
  'thread.read': { input: { botId: string; older?: string; limit?: number }; output: Thread }
  'message.send': { input: { botId: string; text: string }; output: { ok: true } }
  'hosts.get': { input: Record<string, never>; output: Hosts }
  'hosts.select': { input: { id: string }; output: Hosts }
}

declare module 'orca' {
  interface PluginRequests extends Requests {}
}
