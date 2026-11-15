import { readThread, sendMessage, newSendId } from './omb-chat.ts'
import type { OrcaWorkerApi } from 'orca/worker'
import { openChat, validBotId } from './omb-open.ts'
import type { OpenInput, OpenResult } from './omb-open.ts'
import { listBots, addMausBot } from './omb-roster.ts'
import { defaultHttpDeps } from './omb-http.ts'
import { defaultCliDeps } from './omb-cli.ts'
import type { Bot } from '../shared/roster.ts'
import type { Status } from './protocol.ts'
import { ensureServer, stopServer, ServerError, defaultServerDeps, isPluginServer, serverHealthy } from './omb-server.ts'
import type { ServerResult, StopResult } from './omb-server.ts'
import { TESTED_OPENMAUSBOT_VERSION, compareVersions } from '../shared/omb-version.ts'

export type WorkerDeps = {
  checkHealth: (port: number) => Promise<boolean>
  now: () => number
  ensureServer: () => Promise<ServerResult>
  stopServer: () => Promise<StopResult>
  openChat: (input: OpenInput) => Promise<OpenResult>
  addMausBot: (input: { port: number; botId: string }) => Promise<void>
  readThread: typeof readThread
  sendMessage: typeof sendMessage
  listBots: (input: { port: number }) => Promise<Bot[]>
}

function defaults(): WorkerDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject worker dependencies')
  const deps = defaultServerDeps()
  const cli = defaultCliDeps()
  const http = defaultHttpDeps()
  return {
    checkHealth: (port) => serverHealthy(port, deps),
    now: Date.now,
    ensureServer: () => ensureServer(deps),
    stopServer: () => stopServer(deps),
    openChat: async (input) => openChat({ ...input, startedByPlugin: input.startedByPlugin && await isPluginServer(input.port, deps) }, cli),
    addMausBot: (input) => addMausBot(input, http),
    readThread: (input) => readThread(input, cli),
    sendMessage: (input) => sendMessage(input, cli),
    listBots: (input) => listBots(input, http)
  }
}

export function versionMessage(version: string): string {
  const tested = TESTED_OPENMAUSBOT_VERSION
  const comparison = compareVersions(version, tested)
  if (comparison === undefined) return `OpenMausBot is running, but its version (${version}) is unknown. Bot Deck cannot compare it with the tested version (${tested}).`
  if (comparison > 0) return `OpenMausBot ${version} is newer than the version Bot Deck was tested with (${tested}). It should work; tell us if something looks wrong.`
  if (comparison < 0) return `OpenMausBot ${version} is older than Bot Deck expects (${tested}). Update OpenMausBot.`
  return ''
}

export function register(orca: OrcaWorkerApi, deps: WorkerDeps = defaults()): void {
  let status: Status | undefined
  let pending: Promise<void> | undefined
  let stopped = false
  let startedByPlugin = false
  let lastRoster: Bot[] = []
  let opening: Promise<OpenResult> | undefined
  let lastHealthCheck = -Infinity
  let checking: Promise<void> | undefined
  orca.panels.handle('status', async (input: { retry?: boolean } = {}): Promise<Status> => {
    if (status?.state === 'running') {
      if (!checking && deps.now() - lastHealthCheck >= 2000) {
        const checked = status
        lastHealthCheck = deps.now()
        checking = Promise.resolve().then(() => deps.checkHealth(checked.port!)).catch(() => false).then((healthy) => {
          if (!healthy && status === checked) { status = undefined; startedByPlugin = false; lastRoster = [] }
        }).finally(() => { checking = undefined })
      }
      await checking
    }
    if (input.retry && !pending) {
      lastRoster = []
      status = undefined
      stopped = false
    }
    if (!status && !pending && !stopped) {
      status = { state: 'starting', message: 'Starting OpenMausBot… The first start downloads about 75 MB and can take a minute.', testedVersion: TESTED_OPENMAUSBOT_VERSION }
      pending = Promise.resolve().then(() => deps.ensureServer()).then((server) => {
        startedByPlugin = server.startedByPlugin
        status = { state: 'running', message: versionMessage(server.version), port: server.port, version: server.version, testedVersion: TESTED_OPENMAUSBOT_VERSION }
      }).catch((error: unknown) => {
        status = {
          state: error instanceof ServerError ? error.state : 'start_failed',
          message: error instanceof ServerError ? error.message : 'Could not start OpenMausBot. Press Retry to try again.',
          testedVersion: TESTED_OPENMAUSBOT_VERSION
        }
      }).finally(() => { pending = undefined })
    }
    return status!
  })
  const runningPort = (): number => {
    if (status?.state !== 'running' || status.port === undefined) throw new Error('OpenMausBot is not running yet.')
    return status.port
  }
  const chat = (input: { botId?: string } = {}): Promise<OpenResult> => {
    const port = runningPort()
    if (!input || typeof input !== 'object' || (input.botId !== undefined && !validBotId(input.botId))) throw new Error('Invalid bot ID.')
    // Coalesce rapid clicks so a first-open pairing link is not replaced by another click.
    if (opening) return opening
    const activeTaskId = lastRoster.find((bot) => bot.id === input.botId)?.activeTaskId
    opening = Promise.resolve().then(() => deps.openChat({ port, startedByPlugin, botId: input.botId, ...(activeTaskId ? { activeTaskId } : {}) })).finally(() => { opening = undefined })
    return opening
  }
  const knownBot = (input: { botId: string }): number => {
    const port = runningPort()
    if (!input || !validBotId(input.botId)) throw new Error('Invalid bot ID.')
    if (!lastRoster.some((bot) => bot.id === input.botId && !bot.addable)) throw new Error('This bot is not in the roster. Refresh the roster.')
    return port
  }
  orca.panels.handle('thread.read', (input: { botId: string; limit?: number }) => deps.readThread({ port: knownBot(input), botId: input.botId, limit: input.limit }))
  orca.panels.handle('message.send', (input: { botId: string; text: string }) => deps.sendMessage({ port: knownBot(input), botId: input.botId, text: input.text, sendId: newSendId() }))
  orca.panels.handle('chat.open', (input: { botId?: string }) => chat(input))
  orca.panels.handle('bots.list', async () => {
    const port = runningPort()
    const bots = await deps.listBots({ port })
    if (status?.state === 'running' && status.port === port) lastRoster = bots
    return bots
  })
  orca.panels.handle('bots.addMausBot', async (input: { botId: string }) => {
    const port = runningPort()
    if (!input || !validBotId(input.botId)) throw new Error('Invalid bot ID.')
    await deps.addMausBot({ port, botId: input.botId })
    return { message: 'MausBot added.' }
  })
  orca.commands.register('botdeck.open', () => chat())
  const stop = async (): Promise<StopResult> => {
    // Wait for our own startup so a stop command cannot leave it running afterwards.
    await pending
    const result = await deps.stopServer()
    if (result.stopped) {
      lastRoster = []
      stopped = true
      status = { state: 'start_failed', message: 'OpenMausBot was stopped. Press Retry to start it again.', testedVersion: TESTED_OPENMAUSBOT_VERSION }
    }
    return result
  }
  orca.panels.handle('server.stop', stop)
  orca.commands.register('botdeck.stopServer', stop)
}

export default function activate(orca: OrcaWorkerApi): void {
  register(orca)
}
