import type { Thread } from '../shared/chat.ts'
import type { Bot } from '../shared/roster.ts'

export type Status = {
  state: 'running' | 'starting' | 'needs_node' | 'install_failed' | 'start_failed'
  message: string
  port?: number
  version?: string
  testedVersion: string
}

export type Setup = { answered: boolean; agents: { claude: boolean; codex: boolean } }
export type SetupAnswer = { shareTools: boolean; linkAgents: boolean }

export type Requests = {
  'setup.get': { input: Record<string, never>; output: Setup }
  'setup.answer': { input: SetupAnswer; output: { answered: true } }
  'thread.read': { input: { botId: string; limit?: number }; output: Thread }
  'message.send': { input: { botId: string; text: string }; output: { sendId: string } }
  'chat.open': { input: { botId?: string }; output: { message: string } }
  'bots.addMausBot': { input: { botId: string }; output: { message: string } }
  'bots.list': { input: Record<string, never>; output: Bot[] }
  status: { input: { retry?: boolean }; output: Status }
  'server.stop': { input: Record<string, never>; output: { stopped: boolean; message: string } }
}
