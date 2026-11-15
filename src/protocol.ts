import type { Thread } from '../shared/chat.ts'
import type { ModelGroup } from '../shared/models.ts'
import type { Bot } from '../shared/roster.ts'

export type Status = {
  state: 'running' | 'starting' | 'needs_node' | 'install_failed' | 'start_failed'
  message: string
  port?: number
  version?: string
  testedVersion: string
}

export type Requests = {
  'thread.read': { input: { botId: string; limit?: number }; output: Thread }
  'message.send': { input: { botId: string; text: string }; output: { sendId: string } }
  'chat.open': { input: { botId?: string }; output: { message: string } }
  'models.list': { input: Record<string, never>; output: ModelGroup[] }
  'bots.create': { input: { name: string; model: string }; output: { id: string; activeTaskId?: string } }
  'bots.model': { input: { botId: string; model: string }; output: { message: string } }
  'bots.addMausBot': { input: { botId: string }; output: { message: string } }
  'bots.list': { input: Record<string, never>; output: Bot[] }
  status: { input: { retry?: boolean }; output: Status }
  'server.stop': { input: Record<string, never>; output: { stopped: boolean; message: string } }
}
