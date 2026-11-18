import type { FoundAgents } from '../shared/agents.ts'
import type { Tool, ImportResult } from './import-tools.ts'
import type { Thread } from '../shared/chat.ts'
import type { Bot, BotAction } from '../shared/roster.ts'
import type { Hosts } from './paired-host.ts'
import type { Updates } from './updates.ts'

export type Status = {
  state: 'needs_install' | 'running' | 'starting' | 'needs_node' | 'install_failed' | 'start_failed'
  message: string
  needsInstall?: boolean
  port?: number
  version?: string
  testedVersion: string
}

export type Setup = { answered: boolean; agents: FoundAgents } & Partial<SetupAnswer>
export type SetupAnswer = { shareTools: boolean; linkAgents: boolean }
export type Preferences = SetupAnswer & { agents: FoundAgents }

export type Requests = {
  'tools.find': { input: Record<string, never>; output: { tools: Tool[] } }
  'tools.import': { input: Record<string, never>; output: ImportResult }
  'setup.get': { input: Record<string, never>; output: Setup }
  'setup.answer': { input: SetupAnswer; output: { answered: true } }
  'thread.read': { input: { botId: string; limit?: number }; output: Thread }
  'message.send': { input: { botId: string; text: string }; output: { sendId: string } }
  'chat.open': { input: { botId?: string }; output: { message: string } }
  'bots.addMausBot': { input: { botId: string }; output: { message: string } }
  'bots.act': { input: BotAction; output: { ok: true } }
  'bots.list': { input: Record<string, never>; output: Bot[] }
  status: { input: { retry?: boolean }; output: Status }
  'prefs.get': { input: Record<string, never>; output: Preferences }
  'prefs.set': { input: Partial<SetupAnswer>; output: Preferences }
  'updates.get': { input: { check?: boolean }; output: Updates }
  'updates.install': { input: Record<string, never>; output: Updates }
  'updates.auto': { input: { on: boolean }; output: Updates }
  'hosts.get': { input: Record<string, never>; output: Hosts }
  'hosts.select': { input: { id: string }; output: Hosts }
  'server.install': { input: Record<string, never>; output: { accepted: true } }
  'server.stop': { input: Record<string, never>; output: { stopped: boolean; message: string } }
}

declare module 'orca' {
  interface PluginRequests extends Requests {}
}
