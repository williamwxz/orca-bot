import { defaultHttpDeps, HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { validBotId } from './omb-open.ts'
import type { DesktopAction, DesktopReason, DesktopSettings, DesktopState, DesktopStatus } from '../shared/roster.ts'

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const RUNTIMES: Record<string, DesktopStatus['runtime']> = {
  docker: 'Docker',
  podman: 'Podman',
  container: 'Apple container'
}

/**
 * The private desktop's setup state, mapped from OpenMausBot's own status checks in the order
 * of its setup steps. Only the state crosses: the reply also holds a viewer link with its
 * password, shell commands and local paths.
 */
export function desktopState(raw: unknown): DesktopState {
  const s = object(raw)
  if (!s.runtime) return 'no-runtime'
  if (s.daemonUp === false) return 'runtime-stopped'
  if (!s.image) return 'not-prepared'
  if (s.container === 'missing') return s.create_supported === false ? 'unsupported' : 'not-created'
  if (desktopReason(s)) return 'repair'
  if (s.container === 'stopped') return 'stopped'
  if (s.ready === true) return 'running'
  // A running container whose desktop reported an error will not become ready by waiting.
  if (typeof s.desktop_error === 'string' && s.desktop_error) return 'failed'
  return 'starting'
}

/** Which of OpenMausBot's checks an existing desktop fails, in its own order. */
export function desktopReason(raw: unknown): DesktopReason | undefined {
  const s = object(raw)
  if (s.imageMatches === false) return 'old-image'
  if (s.managed === false) return 'not-managed'
  if (s.network === 'unsafe' || s.security === 'unsafe') return 'unsafe'
  if (s.persistence === 'unsafe') return 'no-folder'
  return undefined
}

/** The panel's view of a desktop: state, reason and runtime only. */
export function desktopView(raw: unknown, settings: DesktopSettings): DesktopStatus {
  const runtime = RUNTIMES[String(object(raw).runtime)]
  const state = desktopState(raw)
  const reason = state === 'repair' ? desktopReason(raw) : undefined
  const folderUnverified = object(raw).persistence === 'unsafe'
  return {
    ...settings,
    state,
    ...(reason ? { reason } : {}),
    ...(folderUnverified ? { folderUnverified: true } : {}),
    ...(runtime ? { runtime } : {})
  }
}

export function desktopSettings(config: unknown): DesktopSettings {
  const vm = object(object(config).localVm)
  return {
    mode: vm.mode === 'per-bot' || vm.mode === 'pool' ? vm.mode : 'shared',
    maxInstances: Number.isInteger(vm.maxInstances) ? vm.maxInstances : 2,
    idleMinutes: Number.isInteger(vm.idleTimeoutMinutes) ? vm.idleTimeoutMinutes : 480
  }
}

/** The desktop a bot would use: its own in per-bot mode, otherwise the shared one. */
export async function desktopStatus(
  input: { port: number; botId?: string },
  deps: HttpDeps = defaultHttpDeps()
): Promise<DesktopStatus> {
  if (input.botId !== undefined && !validBotId(input.botId)) throw new Error('Invalid bot ID.')
  try {
    const settings = desktopSettings(await deps.request(input.port, '/api/config'))
    const raw = object(
      await deps.request(
        input.port,
        settings.mode === 'per-bot' && input.botId
          ? `/api/bots/${input.botId}/local-computer`
          : '/api/local-computer'
      )
    )
    return desktopView(raw, settings)
  } catch {
    throw new Error('Could not check the private desktop. Check that OpenMausBot is running.')
  }
}

const ROUTE: Record<DesktopAction, string[]> = {
  prepare: ['pull'],
  create: ['run'],
  start: ['start'],
  stop: ['stop'],
  // OpenMausBot's "Delete and recreate": keeps the durable folder and browser sign-ins.
  recreate: ['remove', 'run']
}
// Preparing downloads and builds the desktop image; creating starts a fresh desktop.
const DEADLINE: Record<string, number> = { pull: 30 * 60_000, run: 10 * 60_000, remove: 3 * 60_000, start: 3 * 60_000, stop: 3 * 60_000 }

/**
 * Runs one private desktop setup step, as OpenMausBot's own buttons do. In per-bot mode the
 * bot's desktop is used; preparing the image is always shared. Refusals keep fixed wording.
 */
export async function desktopAct(
  input: { port: number; action: DesktopAction; botId?: string },
  deps: HttpDeps = defaultHttpDeps()
): Promise<DesktopStatus> {
  if (!Object.hasOwn(ROUTE, input.action)) throw new Error('Unknown desktop step.')
  if (input.botId !== undefined && !validBotId(input.botId)) throw new Error('Invalid bot ID.')
  // Shared and per-bot desktops use different routes: never guess which one this host uses.
  let settings: DesktopSettings
  try {
    settings = desktopSettings(await deps.request(input.port, '/api/config'))
  } catch {
    throw new Error('Could not check how private desktops are shared on this host. Nothing was changed. Try again.')
  }
  const { mode, maxInstances } = settings
  if (mode === 'pool' && input.action !== 'prepare')
    throw new Error('OpenMausBot starts and stops pool desktops by itself. Manage them in native OpenMausBot.')
  const perBot = mode === 'per-bot' && input.action !== 'prepare'
  if (perBot && !input.botId) throw new Error('Choose a bot: each one has its own private desktop.')
  for (const step of ROUTE[input.action]) {
    const route = perBot
      ? `/api/bots/${input.botId}/local-computer/${step}`
      : `/api/local-computer/${step}`
    try {
      await deps.request(input.port, route, {}, 'POST', DEADLINE[step])
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 409) {
        if (/per-bot Local VM limit/i.test(error.detail ?? ''))
          throw new Error(`This host already has its maximum of ${maxInstances} per-bot desktops. Delete one in native OpenMausBot, or raise the maximum in Settings → Private desktops.`)
        if (/runtime|Install|Start (docker|podman|container)/i.test(error.detail ?? ''))
          throw new Error('The container app is not ready. Start Docker or Podman, then try again.')
        throw new Error('A bot is using the private desktop, or another setup step is running. Try again when it finishes.')
      }
      throw new Error(
        input.action === 'prepare'
          ? 'Could not prepare the private desktop. Check that the container app is running, then try again.'
          : 'Could not finish this step. Check the private desktop setup, then try again.'
      )
    }
  }
  return desktopStatus({ port: input.port, ...(input.botId ? { botId: input.botId } : {}) }, deps)
}

/** Changes how private desktops are shared and when idle ones stop, within OpenMausBot's limits. */
export async function updateDesktopSettings(
  input: { port: number } & Partial<DesktopSettings>,
  deps: HttpDeps = defaultHttpDeps()
): Promise<DesktopSettings> {
  const patch: Record<string, unknown> = {}
  if (input.mode !== undefined) {
    if (input.mode !== 'shared' && input.mode !== 'per-bot') throw new Error('Choose Shared or Per bot.')
    patch.mode = input.mode
  }
  if (input.maxInstances !== undefined) {
    if (!Number.isInteger(input.maxInstances) || input.maxInstances < 1 || input.maxInstances > 8)
      throw new Error('Choose between 1 and 8 desktops.')
    patch.maxInstances = input.maxInstances
  }
  if (input.idleMinutes !== undefined) {
    if (!Number.isInteger(input.idleMinutes) || input.idleMinutes < 5 || input.idleMinutes > 1440)
      throw new Error('Enter a whole number from 5 to 1,440.')
    patch.idleTimeoutMinutes = input.idleMinutes
  }
  if (!Object.keys(patch).length) throw new Error('Nothing to change.')
  try {
    await deps.request(input.port, '/api/config', { localVm: patch }, 'PATCH')
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 409) {
      if (/delete .*per-bot|before switching to shared/i.test(error.detail ?? ''))
        throw new Error('Delete the per-bot desktops first, in native OpenMausBot under Settings → Desktops & browser → Details. Then switch to Shared.')
      throw new Error('Wait until no bot is using a private desktop and no setup step is running, then try again.')
    }
    throw new Error('Could not save the private desktop setting. Try again.')
  }
  try {
    return desktopSettings(await deps.request(input.port, '/api/config'))
  } catch {
    throw new Error('Saved, but the new setting could not be read back. Reopen Settings to check it.')
  }
}

/** Installs OpenMausBot's built-in browser. It runs on the server and reports back by status. */
export async function installBrowser(
  input: { port: number },
  deps: HttpDeps = defaultHttpDeps()
): Promise<void> {
  try {
    await deps.request(input.port, '/api/browser-engine/install', {}, 'POST')
  } catch {
    throw new Error('Could not start installing the browser. Try again from native OpenMausBot.')
  }
}
