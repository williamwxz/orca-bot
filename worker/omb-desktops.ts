import { defaultHttpDeps, HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { validBotId } from './omb-open.ts'
import type { DesktopAction, DesktopSettings, DesktopState, DesktopStatus } from '../shared/roster.ts'

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
  if (
    s.imageMatches === false ||
    s.managed === false ||
    s.network === 'unsafe' ||
    s.security === 'unsafe' ||
    s.persistence === 'unsafe'
  )
    return 'repair'
  if (s.container === 'stopped') return 'stopped'
  if (s.ready === true) return 'running'
  return 'starting'
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
    const runtime = RUNTIMES[String(raw.runtime)]
    return { ...settings, state: desktopState(raw), ...(runtime ? { runtime } : {}) }
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
  const { mode } = desktopSettings(await deps.request(input.port, '/api/config').catch(() => ({})))
  if (mode === 'pool' && input.action === 'create')
    throw new Error('Pool desktops start by themselves when a bot needs one.')
  const perBot = mode === 'per-bot' && input.action !== 'prepare'
  if (perBot && !input.botId) throw new Error('Choose a bot: each one has its own private desktop.')
  for (const step of ROUTE[input.action]) {
    const route = perBot
      ? `/api/bots/${input.botId}/local-computer/${step}`
      : `/api/local-computer/${step}`
    try {
      await deps.request(input.port, route, {}, 'POST')
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 409)
        throw new Error('A bot is using the private desktop, or another setup step is running. Try again when it finishes.')
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
    if (error instanceof HttpStatusError && error.status === 409)
      throw new Error('Stop the bots using a private desktop, then change how desktops are shared.')
    throw new Error('Could not save the private desktop setting. Try again.')
  }
  return desktopSettings(await deps.request(input.port, '/api/config'))
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
