import type { Bot } from '../shared/roster.ts'

export type Status = {
  state: 'running' | 'starting' | 'needs_node' | 'install_failed' | 'start_failed'
  message: string
  port?: number
  version?: string
  testedVersion: string
}

export type Requests = {
  'chat.open': { input: { botId?: string }; output: { message: string } }
  'chat.signIn': { input: Record<string, never>; output: { message: string } }
  'bots.list': { input: Record<string, never>; output: Bot[] }
  status: { input: { retry?: boolean }; output: Status }
  'server.stop': { input: Record<string, never>; output: { stopped: boolean; message: string } }
}
