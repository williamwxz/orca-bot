import { listModels } from './omb-models.ts'
import type { Models } from '../shared/models.ts'
import { createConnectors } from './mcp-connectors.ts'
import type { ConnectorAction, Connectors } from './mcp-connectors.ts'
import { registerPairedHost } from './paired-host.ts'
import { registerUpdates } from './updates.ts'
import { defaultHostPrefs } from './host-prefs.ts'
import type { HostPrefs, StoredPrefs } from './host-prefs.ts'
import { linkError } from '../shared/agents.ts'
import type { FoundAgents } from '../shared/agents.ts'
import { defaultImportDeps } from './import-tools.ts'
import { defaultLinkDeps, findAgents, syncAgentLinks } from './agent-link.ts'
import type { Preferences, SetupAnswer } from './protocol.ts'
import { readThread, sendMessage, newSendId } from './omb-chat.ts'
import { uploadAttachment } from './omb-attachments.ts'
import { computerStatus } from './omb-computer.ts'
import { desktopAct, desktopStatus, installBrowser, updateDesktopSettings } from './omb-desktops.ts'
import type { DesktopAction } from '../shared/roster.ts'
const DESKTOP_ACTIONS: DesktopAction[] = ['prepare', 'create', 'start', 'stop', 'recreate']
import { MAX_ATTACHMENTS, composeMessage } from '../shared/attachments.ts'
import type { Attachment } from '../shared/attachments.ts'
import type { OrcaWorkerApi } from 'orca/worker'
import { openChat, repairChat, validBotId } from './omb-open.ts'
import type { OpenInput, OpenResult } from './omb-open.ts'
import { createBot, listBots, addMausBot, actOnBot, validateBotAction, rosterBusy, renameGroup } from './omb-roster.ts'
import { validateBotCreate, validateGroupName } from '../shared/roster.ts'
import { defaultHttpDeps } from './omb-http.ts'
import { defaultCliDeps } from './omb-cli.ts'
import type { Bot, BotAction, GroupRename } from '../shared/roster.ts'
import type { Status } from './protocol.ts'
import {
  withServerLock,
  ensureServer,
  ensureInstalled,
  INSTALL_NOTICE,
  stopServer,
  ServerError,
  defaultServerDeps,
  isPluginServer,
  serverHealthy,
  claudeSetupStatus
} from './omb-server.ts'
import type { ServerResult, StopResult } from './omb-server.ts'
import { TESTED_OPENMAUSBOT_VERSION, compareVersions } from '../shared/omb-version.ts'

export type WorkerDeps = {
  createBot?: typeof createBot
  listModels?: (port: number) => Promise<Models>
  connectors?: {
    list(port: number): Promise<Connectors>
    act(port: number, input: ConnectorAction): Promise<Connectors>
    reconcile(
      port: number,
      write?: (operation: () => Promise<void>) => Promise<void>
    ): Promise<void>
    reset?(): void
  }
  findAgents?: () => FoundAgents
  syncAgentLinks?: (input: { enabled: boolean; owned: boolean; port: number }) => Promise<void>
  hostPrefs?: HostPrefs
  withLifecycle?: <T>(operation: () => Promise<T>) => Promise<T>
  checkHealth: (port: number) => Promise<boolean>
  now: () => number
  ensureServer: (share: boolean, allowInstall?: boolean) => Promise<ServerResult>
  claudeSetupStatus?: (
    port: number,
    share: boolean
  ) => Promise<{ restart: boolean; message: string; updating?: boolean }>
  rosterBusy?: (port: number) => Promise<boolean>
  prepareServer?: (allowInstall: boolean) => Promise<unknown>
  stopServer: () => Promise<StopResult>
  openChat: (input: OpenInput) => Promise<OpenResult>
  repairChat?: (input: OpenInput) => Promise<boolean>
  addMausBot: (input: { port: number; botId: string }) => Promise<void>
  renameGroup?: (input: { port: number } & GroupRename) => Promise<void>
  actOnBot?: (input: { port: number } & BotAction) => Promise<void>
  readThread: typeof readThread
  sendMessage: typeof sendMessage
  computerStatus?: typeof computerStatus
  desktopStatus?: (input: { port: number; botId?: string }) => ReturnType<typeof desktopStatus>
  desktopAct?: (input: Parameters<typeof desktopAct>[0]) => ReturnType<typeof desktopAct>
  updateDesktopSettings?: (input: Parameters<typeof updateDesktopSettings>[0]) => ReturnType<typeof updateDesktopSettings>
  installBrowser?: (input: { port: number }) => Promise<void>
  uploadAttachment?: (input: { port: number; name: string; mime: string; data: string }) => ReturnType<typeof uploadAttachment>
  listBots: (input: { port: number }) => Promise<Bot[]>
}

export function defaultWorkerDeps(): WorkerDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject worker dependencies')
  const deps = defaultServerDeps()
  const cli = defaultCliDeps()
  const http = defaultHttpDeps()
  const links = defaultLinkDeps()
  const imports = defaultImportDeps()
  return {
    connectors: createConnectors(imports, defaultHostPrefs()),
    findAgents: () => findAgents(links),
    syncAgentLinks: async (input) =>
      syncAgentLinks(
        { ...input, owned: input.owned && (await isPluginServer(input.port, deps)) },
        links
      ),
    hostPrefs: defaultHostPrefs(),
    withLifecycle: (operation) => withServerLock(deps, operation),
    checkHealth: (port) => serverHealthy(port, deps),
    now: Date.now,
    ensureServer: (share, allowInstall) => ensureServer(deps, share, allowInstall),
    claudeSetupStatus: (port, share) => claudeSetupStatus(port, share, deps),
    rosterBusy: (port) => rosterBusy(port, http),
    prepareServer: (allowInstall) =>
      ensureInstalled(TESTED_OPENMAUSBOT_VERSION, deps, allowInstall),
    stopServer: () => stopServer(deps),
    openChat: async (input) =>
      openChat(
        {
          ...input,
          startedByPlugin: input.startedByPlugin && (await isPluginServer(input.port, deps))
        },
        cli
      ),
    repairChat: async (input) =>
      repairChat(
        {
          ...input,
          startedByPlugin: input.startedByPlugin && (await isPluginServer(input.port, deps))
        },
        cli
      ),
    createBot: input => createBot(input, http),
    addMausBot: (input) => addMausBot(input, http),
    renameGroup: (input) => renameGroup(input, http),
    listModels: (port) => listModels(port, http),
    actOnBot: (input) => actOnBot(input, http),
    readThread: (input) => readThread(input, cli),
    sendMessage: (input) => sendMessage(input, cli),
    uploadAttachment: (input) => uploadAttachment(input),
    computerStatus: (input) => computerStatus(input, http),
    desktopStatus: (input) => desktopStatus(input, http),
    desktopAct: (input) => desktopAct(input, http),
    updateDesktopSettings: (input) => updateDesktopSettings(input, http),
    installBrowser: (input) => installBrowser(input, http),
    listBots: (input) => listBots(input, http)
  }
}

export function versionMessage(version: string): string {
  const tested = TESTED_OPENMAUSBOT_VERSION
  const comparison = compareVersions(version, tested)
  if (comparison === undefined)
    return `OpenMausBot is running, but its version (${version}) is unknown. Bot Team for Orca cannot compare it with the tested version (${tested}).`
  if (comparison > 0)
    return `OpenMausBot ${version} is newer than the version Bot Team for Orca was tested with (${tested}). It should work; tell us if something looks wrong.`
  if (comparison < 0)
    return `OpenMausBot ${version} is older than Bot Team for Orca expects (${tested}). Update OpenMausBot.`
  return ''
}

export function register(orca: OrcaWorkerApi, deps: WorkerDeps = defaultWorkerDeps()): void {
  const lifecycle = deps.withLifecycle ?? (async <T>(operation: () => Promise<T>) => operation())
  let status: Status | undefined
  let pending: Promise<void> | undefined
  let stopped = false
  let startedByPlugin = false
  let lastRoster: Bot[] = []
  let rosterRevision = 0
  let sends = 0
  let opening: Promise<OpenResult> | undefined
  let repairAt = -Infinity
  let repairFailedUntil = -Infinity
  let seenPrefs: Record<keyof typeof prefKeys, boolean> | undefined
  let pendingPrefs: StoredPrefs = {}

  let prefsQueue: Promise<unknown> = Promise.resolve()
  const withPrefs = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = prefsQueue.then(operation)
    prefsQueue = next.catch(() => {})
    return next
  }

  const prefKeys = {
    shareTools: ['settings', 'shareClaudeSetup'],
    linkAgents: ['settings', 'linkAgents'],
    setupAnswered: ['storage', 'setupAnswered'],
    installConsent: ['storage', 'openmausbotInstallConsent'],
    stopped: ['storage', 'botServerStopped']
  } as const
  const syncPrefs = (): Promise<Record<keyof typeof prefKeys, boolean>> =>
    withPrefs(async () => {
      const current = {} as Record<keyof typeof prefKeys, boolean>
      const prior = seenPrefs ?? ((await orca.storage.get('syncedHostPrefs')) as StoredPrefs | null)
      for (const key of Object.keys(prefKeys) as (keyof typeof prefKeys)[]) {
        const [bag, name] = prefKeys[key]
        current[key] = (await orca[bag].get(name)) === true
      }
      const shared = deps.hostPrefs?.read()
      const patch: StoredPrefs = {}
      for (const key of Object.keys(prefKeys) as (keyof typeof prefKeys)[]) {
        const [bag, name] = prefKeys[key]
        if (typeof prior?.[key] === 'boolean' && current[key] !== prior[key]) {
          patch[key] = current[key]
        } else if (typeof shared?.[key] === 'boolean') {
          if (shared[key] !== current[key]) {
            current[key] = shared[key]!
            await orca[bag].set(name, current[key])
          }
        } else if (current[key]) {
          patch[key] = true
        }
      }
      // Background reconciliation cannot wedge status if the disk is temporarily unwritable.
      // Keep the previous snapshot on failure so the native change is retried next time.
      try {
        if (Object.keys(patch).length) deps.hostPrefs?.write(patch)
        if (
          (Object.keys(prefKeys) as (keyof typeof prefKeys)[]).some(
            (key) => current[key] !== prior?.[key]
          )
        )
          await orca.storage.set('syncedHostPrefs', current)
        seenPrefs = current
        pendingPrefs = {}
      } catch {
        pendingPrefs = patch
      }
      return current
    })

  const writePrefs = (patch: Partial<StoredPrefs>): Promise<void> =>
    withPrefs(async () => {
      patch = { ...pendingPrefs, ...patch }
      deps.hostPrefs?.write(patch)
      pendingPrefs = {}
      const current = { ...seenPrefs } as Record<keyof typeof prefKeys, boolean>
      for (const key of Object.keys(prefKeys) as (keyof typeof prefKeys)[]) {
        const [bag, name] = prefKeys[key]
        if (patch[key] !== undefined) await orca[bag].set(name, patch[key])
        current[key] = (await orca[bag].get(name)) === true
      }
      await orca.storage.set('syncedHostPrefs', current)
      seenPrefs = current
    })

  const repair = (immediate = false): void => {
    if (!deps.repairChat || !startedByPlugin || status?.state !== 'running' || opening) return
    if (deps.now() < repairFailedUntil || (!immediate && deps.now() < repairAt)) return
    const port = status.port!
    repairAt = deps.now() + 30000
    opening = Promise.resolve()
      .then(() => deps.repairChat!({ port, startedByPlugin: true }))
      .catch(() => false)
      .then((ok) => {
        if (!ok) repairFailedUntil = deps.now() + 60000
        return { message: '' }
      })
      .finally(() => {
        opening = undefined
      })
  }
  let lastHealthCheck = -Infinity
  let checking: Promise<void> | undefined
  let updatingConnectors: Promise<unknown> | undefined
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
      linkMessage =
        error instanceof Error && linkError(error.message)
          ? error.message
          : 'Could not update Bot Team for Orca setup.'
      linkRetryAt = deps.now() + 60000
      throw new Error(linkMessage)
    }
  }
  orca.panels.handle('setup.get', async () => {
    const prefs = await syncPrefs()
    return {
      shareTools: prefs.shareTools,
      linkAgents: prefs.linkAgents,
      answered: prefs.setupAnswered,
      agents: deps.findAgents?.() ?? { claude: false, codex: false }
    }
  })
  orca.panels.handle('setup.answer', (input: SetupAnswer) => {
    if (!input || typeof input.shareTools !== 'boolean' || typeof input.linkAgents !== 'boolean')
      throw new Error('Choose your setup options.')
    answering ??= (async (): Promise<{ answered: true }> => {
      if ((await syncPrefs()).setupAnswered) return { answered: true }
      try {
        linkRetryAt = -Infinity
        lastHealthCheck = -Infinity
        await writePrefs({ shareTools: input.shareTools, linkAgents: input.linkAgents })
        linkSetting = input.linkAgents
        if (status?.state === 'running' && startedByPlugin) {
          await checking
          if (
            status?.state === 'running' &&
            startedByPlugin &&
            (!input.linkAgents ||
              (compareVersions(status.version!, TESTED_OPENMAUSBOT_VERSION) ?? 0) >= 0)
          )
            await updateLinks(input.linkAgents, status.port!)
        }
        await writePrefs({ setupAnswered: true })
        lastHealthCheck = -Infinity
        return { answered: true }
      } catch {
        throw new Error('Could not finish setup. Please try again.')
      }
    })().finally(() => {
      answering = undefined
    })
    return answering
  })
  const preferences = async (): Promise<Preferences> => {
    const prefs = await syncPrefs()
    return {
      shareTools: prefs.shareTools,
      linkAgents: prefs.linkAgents,
      agents: deps.findAgents?.() ?? { claude: false, codex: false }
    }
  }
  orca.panels.handle('prefs.get', preferences)
  // The next status check applies a change, as it does for a change in Orca's Settings.
  orca.panels.handle('prefs.set', async (input: Partial<SetupAnswer>) => {
    if (!input || typeof input !== 'object') throw new Error('Choose a setting.')
    for (const key of ['shareTools', 'linkAgents'] as const)
      if (input[key] !== undefined && typeof input[key] !== 'boolean')
        throw new Error('Choose a setting.')
    await syncPrefs()
    await writePrefs({
      ...(input.shareTools !== undefined ? { shareTools: input.shareTools } : {}),
      ...(input.linkAgents !== undefined ? { linkAgents: input.linkAgents } : {}),
      // A choice made here answers the setup card too.
      setupAnswered: true
    })
    lastHealthCheck = -Infinity
    return preferences()
  })
  orca.panels.handle('server.install', async () => {
    await syncPrefs()
    await writePrefs({ installConsent: true, stopped: false })
    await pending
    if (status?.state !== 'running') status = undefined
    stopped = false
    lastHealthCheck = -Infinity
    return { accepted: true }
  })
  orca.panels.handle('status', async (input: { retry?: boolean } = {}): Promise<Status> => {
    const prefs = await syncPrefs()
    if (input.retry) {
      await writePrefs({ stopped: false })
      prefs.stopped = false
    }
    stopped = prefs.stopped
    if (stopped) {
      status = {
        state: 'start_failed',
        message: 'OpenMausBot was stopped. Press Retry to start it again.',
        testedVersion: TESTED_OPENMAUSBOT_VERSION
      }
      return status
    }
    const allowInstall = prefs.installConsent
    const answered = prefs.setupAnswered
    const share = answered && prefs.shareTools
    const nextLinkSetting = prefs.linkAgents
    if (linkSetting !== nextLinkSetting) {
      linkSetting = nextLinkSetting
      linkRetryAt = -Infinity
      lastHealthCheck = -Infinity
    }
    if (status?.state === 'running') {
      if (!checking && deps.now() - lastHealthCheck >= 2000) {
        const checked = status
        lastHealthCheck = deps.now()
        checking = Promise.resolve()
          .then(() => deps.checkHealth(checked.port!))
          .catch(() => false)
          .then(async (healthy) => {
            if (status !== checked) return
            if (!healthy) {
              deps.connectors?.reset?.()
              status = undefined
              startedByPlugin = false
              lastRoster = []
              return
            }
            if (!startedByPlugin || answering) return
            const wantLinks = answered && nextLinkSetting
            const outdated =
              (compareVersions(checked.version!, TESTED_OPENMAUSBOT_VERSION) ?? 0) < 0
            if ((!wantLinks || !outdated) && deps.now() >= linkRetryAt) {
              try {
                await updateLinks(wantLinks, checked.port!)
              } catch {
                /* Keep the failure visible while waiting to retry. */
              }
            }
            repair()
            const setup = (await deps.claudeSetupStatus?.(checked.port!, share)) ?? {
              restart: false,
              message: ''
            }
            if (status !== checked) return
            if (setup.updating && !allowInstall) checked.needsInstall = true
            else delete checked.needsInstall
            if (checked.needsInstall) {
              checked.message = INSTALL_NOTICE
              return
            }
            checked.message = [
              setup.updating ? '' : versionMessage(checked.version!),
              setup.message,
              linkMessage
            ]
              .filter(Boolean)
              .join(' ')
            if (
              updatingConnectors ||
              sends ||
              !setup.restart ||
              !deps.rosterBusy ||
              (await deps.rosterBusy(checked.port!))
            )
              return
            if (status !== checked || pending) return
            status = {
              ...checked,
              state: 'starting',
              message: setup.updating
                ? `Updating OpenMausBot to ${TESTED_OPENMAUSBOT_VERSION}\u2026`
                : 'Restarting OpenMausBot to apply your Claude setup\u2026'
            }
            pending = Promise.resolve()
              .then(() =>
                lifecycle(async () => {
                  await opening?.catch(() => {})
                  const fresh = await syncPrefs()
                  const restartShare = fresh.setupAnswered && fresh.shareTools
                  const stillNeedsRestart = await deps.claudeSetupStatus?.(
                    checked.port!,
                    restartShare
                  )
                  if (fresh.stopped) {
                    stopped = true
                    status = {
                      state: 'start_failed',
                      message: 'OpenMausBot was stopped. Press Retry to start it again.',
                      testedVersion: TESTED_OPENMAUSBOT_VERSION
                    }
                    return
                  }
                  if (stillNeedsRestart && !stillNeedsRestart.restart) {
                    // Another worker already applied the change while we waited for the lock.
                    const server = await deps.ensureServer(restartShare, fresh.installConsent)
                    deps.connectors?.reset?.()
                    startedByPlugin = server.startedByPlugin
                    status = {
                      state: 'running',
                      message: versionMessage(server.version),
                      port: server.port,
                      version: server.version,
                      testedVersion: TESTED_OPENMAUSBOT_VERSION
                    }
                    lastHealthCheck = -Infinity
                    return
                  }
                  // Keep the old server available if download or integrity verification fails.
                  try {
                    if (stillNeedsRestart?.updating ?? setup.updating)
                      await deps.prepareServer?.(fresh.installConsent)
                  } catch (error) {
                    status = checked
                    checked.message =
                      error instanceof ServerError
                        ? error.message
                        : 'Could not prepare the OpenMausBot update. Press Retry.'
                    return
                  }
                  // A turn may have started while opening the dashboard or preparing the update.
                  if (sends || (await deps.rosterBusy!(checked.port!))) {
                    status = checked
                    return
                  }
                  const result = await deps.stopServer()
                  if (!result.stopped) {
                    status = checked
                    return
                  }
                  lastRoster = []
                  const server = await deps.ensureServer(restartShare, fresh.installConsent)
                  deps.connectors?.reset?.()
                  startedByPlugin = server.startedByPlugin
                  lastHealthCheck = -Infinity
                  status = {
                    state: 'running',
                    message: versionMessage(server.version),
                    port: server.port,
                    version: server.version,
                    testedVersion: TESTED_OPENMAUSBOT_VERSION
                  }
                  repair(true)
                })
              )
              .catch((error) => {
                if (error instanceof ServerError && error.busy) {
                  status = checked
                  lastHealthCheck = -Infinity
                  return
                }
                status = {
                  state: 'start_failed',
                  message: 'Could not restart OpenMausBot. Press Retry to try again.',
                  testedVersion: TESTED_OPENMAUSBOT_VERSION
                }
              })
              .finally(() => {
                pending = undefined
              })
          })
          .finally(() => {
            checking = undefined
          })
      }
      await checking
    }
    if (input.retry && !pending) {
      deps.connectors?.reset?.()
      lastRoster = []
      status = undefined
      stopped = false
    }
    if (!status && !pending && !stopped) {
      status = {
        state: 'starting',
        message: 'Checking OpenMausBot\u2026',
        testedVersion: TESTED_OPENMAUSBOT_VERSION
      }
      pending = Promise.resolve()
        .then(() => deps.ensureServer(share, allowInstall))
        .then((server) => {
          deps.connectors?.reset?.()
          startedByPlugin = server.startedByPlugin
          status = {
            state: 'running',
            message: versionMessage(server.version),
            port: server.port,
            version: server.version,
            testedVersion: TESTED_OPENMAUSBOT_VERSION
          }
          if (server.started) repair(true)
        })
        .catch((error: unknown) => {
          status = {
            state: error instanceof ServerError ? error.state : 'start_failed',
            message:
              error instanceof ServerError
                ? error.message
                : 'Could not start OpenMausBot. Press Retry to try again.',
            testedVersion: TESTED_OPENMAUSBOT_VERSION
          }
        })
        .finally(() => {
          pending = undefined
        })
    }
    return status!
  })
  const runningPort = (): number => {
    if (status?.state !== 'running' || status.port === undefined)
      throw new Error('OpenMausBot is not running yet.')
    return status.port
  }
  orca.panels.handle('mcp.list', async () => {
    if (!deps.connectors) throw new Error('MCP connectors are unavailable.')
    return lifecycle(() => deps.connectors!.list(runningPort()))
  })
  orca.panels.handle('mcp.act', async (input) => {
    if (!deps.connectors || !startedByPlugin)
      throw new Error('MCP connectors require a server started by this plugin.')
    if (updatingConnectors) throw new Error('An MCP update is already in progress. Please retry.')
    const port = runningPort()
    const work = lifecycle(() => deps.connectors!.act(port, input))
    updatingConnectors = work
    try {
      return await work
    } finally {
      updatingConnectors = undefined
    }
  })
  const chat = (input: { botId?: string } = {}): Promise<OpenResult> => {
    const port = runningPort()
    if (
      !input ||
      typeof input !== 'object' ||
      (input.botId !== undefined && !validBotId(input.botId))
    )
      throw new Error('Invalid bot ID.')
    // Coalesce rapid clicks so a first-open pairing link is not replaced by another click.
    if (opening) return opening
    const activeTaskId = lastRoster.find((bot) => bot.id === input.botId)?.activeTaskId
    opening = Promise.resolve()
      .then(() =>
        deps.openChat({
          port,
          startedByPlugin,
          botId: input.botId,
          ...(activeTaskId ? { activeTaskId } : {})
        })
      )
      .finally(() => {
        opening = undefined
      })
    return opening
  }
  const knownBot = (input: { botId: string }): number => {
    const port = runningPort()
    if (!input || !validBotId(input.botId)) throw new Error('Invalid bot ID.')
    if (!lastRoster.some((bot) => bot.id === input.botId && !bot.addable))
      throw new Error('This bot is not in the roster. Refresh the roster.')
    return port
  }
  orca.panels.handle('thread.read', (input: { botId: string; limit?: number }) =>
    deps.readThread({ port: knownBot(input), botId: input.botId, limit: input.limit })
  )
  // Uploaded files by opaque ID. Their server paths stay here; the panel only ever holds the ID.
  const uploads = new Map<string, Attachment>()
  orca.panels.handle(
    'message.send',
    async (input: { botId: string; text: string; attachments?: string[] }) => {
      const port = knownBot(input)
      const ids = input.attachments ?? []
      if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || ids.some((id) => typeof id !== 'string'))
        throw new Error(`Send at most ${MAX_ATTACHMENTS} files in one message.`)
      const files = ids.map((id) => uploads.get(id))
      if (files.some((file) => !file)) throw new Error('Attach the files again, then send.')
      const text = files.length ? composeMessage(String(input.text ?? ''), files as Attachment[]) : input.text
      if (files.length && text.length > 16000)
        throw new Error('This message is too long with its attachments. Shorten it and send again.')
      sends++
      try {
        const sent = await deps.sendMessage({ port, botId: input.botId, text, sendId: newSendId() })
        for (const id of ids) uploads.delete(id)
        return sent
      } finally {
        sends--
      }
    }
  )

  const desktopBot = (input: { botId?: string } | undefined) =>
    input?.botId === undefined ? {} : { botId: (knownBot({ botId: input.botId }), input.botId) }
  // Setup steps can take many minutes (the first one downloads and builds the desktop), longer
  // than a panel request or the paired-server relay waits. So a step runs here in the
  // background, one at a time, and the panel follows it through the desktop status.
  let desktopJob: { id: number; action: DesktopAction; running: boolean; error?: string } | undefined
  let desktopJobs = 0
  const withStep = <T extends object>(status: T): T =>
    desktopJob ? { ...status, step: { ...desktopJob } } : status
  orca.panels.handle('desktop.status', async (input: { botId?: string }) => {
    const port = runningPort()
    if (!deps.desktopStatus) throw new Error('Private desktops are unavailable.')
    return withStep(await deps.desktopStatus({ port, ...desktopBot(input) }))
  })
  orca.panels.handle('computer.status', async (input: { botId: string }) => {
    const port = knownBot(input)
    if (!deps.computerStatus) return {}
    const threadId = lastRoster.find((bot) => bot.id === input.botId)?.activeTaskId
    const status = await deps.computerStatus({ port, botId: input.botId, threadId })
    return status.desktop ? { ...status, desktop: withStep(status.desktop) } : status
  })
  orca.panels.handle('desktop.act', (input: { action: DesktopAction; botId?: string }) => {
    const port = runningPort()
    if (!deps.desktopAct) throw new Error('Private desktops are unavailable.')
    if (!DESKTOP_ACTIONS.includes(input?.action)) throw new Error('Unknown desktop step.')
    if (desktopJob?.running) throw new Error('Another private desktop step is still running.')
    const job = { id: ++desktopJobs, action: input.action, running: true } as NonNullable<typeof desktopJob>
    desktopJob = job
    deps.desktopAct({ port, action: input.action, ...desktopBot(input) }).then(
      () => { job.running = false },
      (error) => {
        job.running = false
        // desktopAct only throws fixed wording; anything else gets a fixed line too.
        job.error = error instanceof Error && error.message.length < 300 ? error.message : 'Could not finish this step.'
      }
    )
    return { step: { ...job } }
  })
  orca.panels.handle('desktop.settings', (input: Record<string, unknown>) => {
    const port = runningPort()
    if (!deps.updateDesktopSettings) throw new Error('Private desktops are unavailable.')
    const { mode, maxInstances, idleMinutes } = (input ?? {}) as any
    return deps.updateDesktopSettings({ port, mode, maxInstances, idleMinutes })
  })
  orca.panels.handle('browser.install', async () => {
    const port = runningPort()
    if (!deps.installBrowser) throw new Error('The browser is unavailable.')
    await deps.installBrowser({ port })
    return { installing: true as const }
  })
  // Not relayed: on a paired server the bytes would crawl through the terminal link.
  orca.panels.handle('attachment.upload', async (input: { name: string; mime: string; data: string }) => {
    const port = runningPort()
    if (!deps.uploadAttachment) throw new Error('Attachments are unavailable.')
    const stored = await deps.uploadAttachment({ port, name: input?.name, mime: input?.mime, data: input?.data })
    const id = newSendId()
    uploads.set(id, stored)
    // Unsent uploads are forgotten oldest first; the files stay in OpenMausBot's store.
    while (uploads.size > 200) uploads.delete(uploads.keys().next().value!)
    return { id, kind: stored.kind, name: stored.name }
  })
  orca.panels.handle('chat.open', (input: { botId?: string }) => chat(input))
  orca.panels.handle('models.list', async () => {
    const port = runningPort()
    if (!deps.listModels) throw new Error('Models are unavailable.')
    return deps.listModels(port)
  })
  let reconciling: Promise<void> | undefined
  orca.panels.handle('bots.create', (input: unknown) => lifecycle(async () => {
    const port = runningPort()
    const details = validateBotCreate(input)
    if (!deps.createBot) throw new Error('Bot creation is unavailable.')
    const created = await deps.createBot({
      ...details,
      port,
      ...(startedByPlugin && { excludeMcp: Object.keys(deps.hostPrefs?.read()?.connectors ?? {}) })
    })
    const bot: Bot = {
      id: created.botId, name: created.name, title: '', main: false,
      state: 'idle', unread: false, modelLabel: '', section: created.section ?? details.section
    }
    // An older poll must not evict the new bot while the panel opens its thread.
    ++rosterRevision
    const refreshed = await deps.listBots({ port }).catch(() => lastRoster)
    lastRoster = refreshed.some(item => item.id === bot.id) ? refreshed : [...refreshed, bot]
    return created
  }))
  orca.panels.handle('bots.list', async () => {
    const port = runningPort()
    const revision = rosterRevision
    const bots = await deps.listBots({ port })
    // A successful roster read confirms this server is reachable. Background maintenance
    // is coalesced and detached so network failures and busy locks never block recovery.
    if (
      status?.state === 'running' &&
      status.port === port &&
      startedByPlugin &&
      deps.connectors &&
      !reconciling
    ) {
      reconciling = Promise.resolve()
        .then(() => deps.connectors!.reconcile(port, lifecycle))
        .catch(() => {})
        .finally(() => {
          reconciling = undefined
        })
    }
    if (status?.state === 'running' && status.port === port && revision === rosterRevision) lastRoster = bots
    return bots
  })
  orca.panels.handle('bots.addMausBot', async (input: { botId: string }) => {
    const port = runningPort()
    if (!input || !validBotId(input.botId)) throw new Error('Invalid bot ID.')
    await deps.addMausBot({ port, botId: input.botId })
    return { message: 'MausBot added.' }
  })
  orca.panels.handle('groups.rename', async (input: GroupRename) => {
    const port = runningPort()
    const section = validateGroupName(input?.section)
    const name = validateGroupName(input?.name)
    if (section === name) return { ok: true }
    if (!deps.renameGroup) throw new Error('Group rename is unavailable.')
    await deps.renameGroup({ port, section, name })
    return { ok: true }
  })
  orca.panels.handle('bots.act', async (input: BotAction) => {
    const port = knownBot(input)
    validateBotAction(input)
    if (!deps.actOnBot) throw new Error('Bot actions are unavailable.')
    await deps.actOnBot({ ...input, port })
    if (input.action === 'delete') {
      lastRoster = lastRoster.filter((bot) => bot.id !== input.botId)
    }
    return { ok: true }
  })
  orca.commands.register('orcabot.open', () => chat())
  const stop = async (): Promise<StopResult> => {
    // Finish connector updates before stopping our server.
    await updatingConnectors?.catch(() => {})
    // Wait for our own startup so a stop command cannot leave it running afterwards.
    await pending
    const result = await lifecycle(async () => {
      const result = await deps.stopServer()
      if (result.stopped) {
        await syncPrefs()
        await writePrefs({ stopped: true })
      }
      return result
    })
    if (result.stopped) {
      lastRoster = []
      stopped = true
      status = {
        state: 'start_failed',
        message: 'OpenMausBot was stopped. Press Retry to start it again.',
        testedVersion: TESTED_OPENMAUSBOT_VERSION
      }
    }
    return result
  }
  orca.panels.handle('server.stop', stop)
  orca.commands.register('orcabot.stopServer', stop)
}

export default function activate(orca: OrcaWorkerApi): void {
  registerPairedHost(orca, (api) => register(api))
  registerUpdates(orca)
}
