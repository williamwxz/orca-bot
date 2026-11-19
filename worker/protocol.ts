import type { Models } from '../shared/models.ts'
import type { Connectors, ConnectorAction } from './mcp-connectors.ts'
import type { FoundAgents } from '../shared/agents.ts'
import type { Thread } from '../shared/chat.ts'
import type { Upload, Uploaded } from '../shared/attachments.ts'
import type { BotCreate, BotCreated, Bot, BotAction, ComputerStatus, DesktopAction, DesktopSettings, DesktopStatus, GroupRename } from '../shared/roster.ts'
import type { Hosts } from './paired-host.ts'
import type { ExportJob, Learning, LearningSettings } from '../shared/learning.ts'
import type { Schedule, ScheduleAction, ScheduleResult } from '../shared/schedules.ts'
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
  'models.list': { input: Record<string, never>; output: Models }
  'mcp.list': { input: Record<string, never>; output: Connectors }
  'mcp.act': { input: ConnectorAction; output: Connectors }
  'setup.get': { input: Record<string, never>; output: Setup }
  'setup.answer': { input: SetupAnswer; output: { answered: true } }
  'thread.read': { input: { botId: string; limit?: number }; output: Thread }
  'message.send': { input: { botId: string; text: string; attachments?: string[] }; output: { sendId: string } }
  'computer.status': { input: { botId: string }; output: ComputerStatus }
  'desktop.status': { input: { botId?: string }; output: DesktopStatus }
  'desktop.step': { input: Record<string, never>; output: { step?: NonNullable<DesktopStatus['step']> } }
  'desktop.act': { input: { action: DesktopAction; botId?: string }; output: { step: NonNullable<DesktopStatus['step']> } }
  'desktop.settings': { input: Partial<DesktopSettings>; output: DesktopSettings }
  'browser.install': { input: Record<string, never>; output: { installing: true } }
  'learning.read': { input: { botId: string }; output: Learning }
  'learning.skill': { input: { botId: string; name: string; enabled: boolean }; output: Learning }
  'learning.settings': { input: { autoLearn?: boolean }; output: LearningSettings }
  'team.export': { input: Record<string, never>; output: ExportJob }
  'team.export.status': { input: Record<string, never>; output: { job?: ExportJob } }
  'memory.save': { input: { botId: string; text: string; hash: string }; output: Learning }
  'schedules.list': { input: { botId: string }; output: Schedule[] }
  'schedules.act': { input: { botId: string } & ScheduleAction; output: ScheduleResult }
  'attachment.upload': { input: Upload; output: Uploaded }
  'chat.open': { input: { botId?: string }; output: { message: string } }
  'bots.addMausBot': { input: { botId: string }; output: { message: string } }
  'groups.rename': { input: GroupRename; output: { ok: true } }
  'bots.act': { input: BotAction; output: { ok: true } }
  'bots.create': { input: BotCreate; output: BotCreated }
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
