import { linkError } from '../shared/agents.ts'
import type { FoundAgents } from '../shared/agents.ts'
import { defaultImportDeps, findTools, importTools, importMessage } from './import-tools.ts'
import type { Tool, ImportResult } from './import-tools.ts'
import { defaultLinkDeps, findAgents, syncAgentLinks } from './agent-link.ts'
import type { SetupAnswer } from './protocol.ts'
import { readThread, sendMessage, newSendId } from './omb-chat.ts'
import type { OrcaWorkerApi } from 'orca/worker'
import { openChat, repairChat, validBotId } from './omb-open.ts'
import type { OpenInput, OpenResult } from './omb-open.ts'
import { listBots, addMausBot, rosterBusy } from './omb-roster.ts'
import { defaultHttpDeps } from './omb-http.ts'
import { defaultCliDeps } from './omb-cli.ts'
import type { Bot } from '../shared/roster.ts'
import type { Status } from './protocol.ts'
import { ensureServer, stopServer, ServerError, defaultServerDeps, isPluginServer, serverHealthy, claudeSetupStatus } from './omb-server.ts'
import type { ServerResult, StopResult } from './omb-server.ts'
import { TESTED_OPENMAUSBOT_VERSION, compareVersions } from '../shared/omb-version.ts'

export type WorkerDeps = {
  findTools?: () => Promise<Tool[]>
  importTools?: (port: number) => Promise<ImportResult>
  findAgents?: () => FoundAgents
  syncAgentLinks?: (input: { enabled: boolean; owned: boolean; port: number }) => Promise<void>
  checkHealth: (port: number) => Promise<boolean>
  now: () => number
  ensureServer: (share: boolean) => Promise<ServerResult>
  claudeSetupStatus?: (port: number, share: boolean) => Promise<{ restart: boolean; message: string }>
  rosterBusy?: (port: number) => Promise<boolean>
  stopServer: () => Promise<StopResult>
  openChat: (input: OpenInput) => Promise<OpenResult>
  repairChat?: (input: OpenInput) => Promise<boolean>
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
  const links = defaultLinkDeps()
  const imports = defaultImportDeps()
  return {
    findTools: () => findTools(imports),
    importTools: port => importTools(port, imports),
    findAgents: () => findAgents(links),
    syncAgentLinks: async (input) => syncAgentLinks({ ...input, owned: input.owned && await isPluginServer(input.port, deps) }, links),
    checkHealth: (port) => serverHealthy(port, deps),
    now: Date.now,
    ensureServer: (share) => ensureServer(deps, share),
    claudeSetupStatus: (port, share) => claudeSetupStatus(port, share, deps),
    rosterBusy: (port) => rosterBusy(port, http),
    stopServer: () => stopServer(deps),
    openChat: async (input) => openChat({ ...input, startedByPlugin: input.startedByPlugin && await isPluginServer(input.port, deps) }, cli),
    repairChat: async (input) => repairChat({ ...input, startedByPlugin: input.startedByPlugin && await isPluginServer(input.port, deps) }, cli),
    addMausBot: (input) => addMausBot(input, http),
    readThread: (input) => readThread(input, cli),
    sendMessage: (input) => sendMessage(input, cli),
    listBots: (input) => listBots(input, http)
  }
}

export function versionMessage(version: string): string {
  const tested = TESTED_OPENMAUSBOT_VERSION
  const comparison = compareVersions(version, tested)
  if (comparison === undefined) return `OpenMausBot is running, but its version (${version}) is unknown. Orca Bot cannot compare it with the tested version (${tested}).`
  if (comparison > 0) return `OpenMausBot ${version} is newer than the version Orca Bot was tested with (${tested}). It should work; tell us if something looks wrong.`
  if (comparison < 0) return `OpenMausBot ${version} is older than Orca Bot expects (${tested}). Update OpenMausBot.`
  return ''
}

export function register(orca: OrcaWorkerApi, deps: WorkerDeps = defaults()): void {
  let status: Status | undefined
  let pending: Promise<void> | undefined
  let stopped = false
  let startedByPlugin = false
  let lastRoster: Bot[] = []
  let opening: Promise<OpenResult> | undefined
  let repairAt = -Infinity
  let repairFailedUntil = -Infinity
  const repair = (immediate = false): void => {
    if (!deps.repairChat || !startedByPlugin || status?.state !== 'running' || opening) return
    if (deps.now() < repairFailedUntil || (!immediate && deps.now() < repairAt)) return
    const port = status.port!
    repairAt = deps.now() + 30000
    opening = Promise.resolve().then(() => deps.repairChat!({ port, startedByPlugin: true })).catch(() => false).then(ok => {
      if (!ok) repairFailedUntil = deps.now() + 60000
      return { message: '' }
    }).finally(() => { opening = undefined })
  }
  let lastHealthCheck = -Infinity
  let checking: Promise<void> | undefined
  let importing: Promise<ImportResult> | undefined
  let answering: Promise<{ answered: true }> | undefined
  let linkSetting: boolean | undefined
  let linkRetryAt = -Infinity
  let linkMessage = ''
  const updateLinks = async (enabled: boolean, port: number): Promise<void> => {
    try {
      await deps.syncAgentLinks?.({ enabled, owned: true, port })
      linkMessage = ''
      linkRetryAt = -Infinity
    } catch (error) {
      linkMessage = error instanceof Error && linkError(error.message) ? error.message : 'Could not update Orca Bot setup.'
      linkRetryAt = deps.now() + 60000
      throw new Error(linkMessage)
    }
  }
  orca.panels.handle('setup.get', async () => ({
    answered: await orca.storage.get('setupAnswered') === true,
    agents: deps.findAgents?.() ?? { claude: false, codex: false }
  }))
  orca.panels.handle('setup.answer', (input: SetupAnswer) => {
    if (!input || typeof input.shareTools !== 'boolean' || typeof input.linkAgents !== 'boolean') throw new Error('Choose your setup options.')
    answering ??= (async (): Promise<{ answered: true }> => {
      if (await orca.storage.get('setupAnswered') === true) return { answered: true }
      try {
        linkRetryAt = -Infinity
        lastHealthCheck = -Infinity
        await orca.settings.set('shareClaudeSetup', input.shareTools)
        await orca.settings.set('linkAgents', input.linkAgents)
        linkSetting = input.linkAgents
        if (status?.state === 'running' && startedByPlugin) {
          await checking
          if (status?.state === 'running' && startedByPlugin) await updateLinks(input.linkAgents, status.port!)
        }
        await orca.storage.set('setupAnswered', true)
        lastHealthCheck = -Infinity
        return { answered: true }
      } catch { throw new Error('Could not finish setup. Please try again.') }
    })().finally(() => { answering = undefined })
    return answering
  })
  orca.panels.handle('status', async (input: { retry?: boolean } = {}): Promise<Status> => {
    const answered = await orca.storage.get('setupAnswered') === true
    const share = answered && await orca.settings.get('shareClaudeSetup') === true
    const nextLinkSetting = await orca.settings.get('linkAgents') === true
    if (linkSetting !== nextLinkSetting) {
      linkSetting = nextLinkSetting
      linkRetryAt = -Infinity
      lastHealthCheck = -Infinity
    }
    if (status?.state === 'running') {
      if (!checking && deps.now() - lastHealthCheck >= 2000) {
        const checked = status
        lastHealthCheck = deps.now()
        checking = Promise.resolve().then(() => deps.checkHealth(checked.port!)).catch(() => false).then(async (healthy) => {
          if (status !== checked) return
          if (!healthy) { status = undefined; startedByPlugin = false; lastRoster = []; return }
          if (!startedByPlugin || answering) return
          if (deps.now() >= linkRetryAt) {
            try { await updateLinks(answered && nextLinkSetting, checked.port!) }
            catch { /* Keep the failure visible while waiting to retry. */ }
          }
          repair()
          const setup = await deps.claudeSetupStatus?.(checked.port!, share) ?? { restart: false, message: '' }
          if (status !== checked) return
          checked.message = [versionMessage(checked.version!), setup.message, linkMessage].filter(Boolean).join(' ')
          if (importing || !setup.restart || !deps.rosterBusy || await deps.rosterBusy(checked.port!)) return
          if (status !== checked || pending) return
          const restartShare = share
          status = { ...checked, state: 'starting', message: 'Restarting OpenMausBot to apply your Claude setup…' }
          pending = Promise.resolve().then(async () => {
            await opening?.catch(() => {})
            const result = await deps.stopServer()
            if (!result.stopped) { status = checked; return }
            lastRoster = []
            const server = await deps.ensureServer(restartShare)
            startedByPlugin = server.startedByPlugin
            status = { state: 'running', message: versionMessage(server.version), port: server.port, version: server.version, testedVersion: TESTED_OPENMAUSBOT_VERSION }
            repair(true)
          }).catch(() => {
            status = { state: 'start_failed', message: 'Could not restart OpenMausBot. Press Retry to try again.', testedVersion: TESTED_OPENMAUSBOT_VERSION }
          }).finally(() => { pending = undefined })
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
      pending = Promise.resolve().then(() => deps.ensureServer(share)).then((server) => {
        startedByPlugin = server.startedByPlugin
        status = { state: 'running', message: versionMessage(server.version), port: server.port, version: server.version, testedVersion: TESTED_OPENMAUSBOT_VERSION }
        if (server.started) repair(true)
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
  const bringTools = (): Promise<ImportResult> => {
    if (importing) return importing
    importing = Promise.resolve().then(async () => {
      await checking
      await pending
      if (status?.state !== 'running') {
        const share = await orca.storage.get('setupAnswered') === true && await orca.settings.get('shareClaudeSetup') === true
        pending = deps.ensureServer(share).then(server => {
          startedByPlugin = server.startedByPlugin
          stopped = false
          status = { state: 'running', message: versionMessage(server.version), port: server.port, version: server.version, testedVersion: TESTED_OPENMAUSBOT_VERSION }
        }).catch(() => { throw new Error('Could not start OpenMausBot to import tools.') }).finally(() => { pending = undefined })
        await pending
      }
      const port = runningPort()
      if (!startedByPlugin || !deps.importTools) throw new Error('Tools can only be imported into a server Orca Bot started.')
      try { return await deps.importTools(port) }
      catch { throw new Error('Could not import or switch off tools. Check the Bot Dashboard.') }
    }).finally(() => { importing = undefined })
    return importing
  }
  orca.panels.handle('tools.find', async () => {
    try { return { tools: await deps.findTools?.() ?? [] } } catch { return { tools: [] } }
  })
  orca.panels.handle('tools.import', bringTools)
  orca.commands.register('orcabot.importTools', async () => ({ message: importMessage(await bringTools()) }))
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
  orca.commands.register('orcabot.open', () => chat())
  const stop = async (): Promise<StopResult> => {
    // Finish importing and switching tools off before stopping our server.
    await importing?.catch(() => {})
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
  orca.commands.register('orcabot.stopServer', stop)
}

export default function activate(orca: OrcaWorkerApi): void {
  register(orca)
}
