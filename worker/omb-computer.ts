import { defaultHttpDeps } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { validBotId } from './omb-open.ts'
import type { ComputerStatus } from '../shared/roster.ts'
import { desktopSettings, desktopView } from './omb-desktops.ts'

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const PLACES = ['cloud', 'vm', 'local', 'browser'] as const

/**
 * What the Backend panel shows about a bot's computer. Only states cross this boundary: the
 * server's replies also carry a desktop viewer link with its password, shell commands and
 * local paths, and none of those are passed on.
 */
export async function computerStatus(
  input: { port: number; botId: string; threadId?: string },
  deps: HttpDeps = defaultHttpDeps()
): Promise<ComputerStatus> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const status: ComputerStatus = {}
  // Each part is optional: a failed read leaves that tile with its plain description.
  if (input.threadId && /^[\w-]{1,80}$/.test(input.threadId))
    try {
      const reply = object(
        await deps.request(
          input.port,
          `/api/bots/${input.botId}/computer?threadId=${encodeURIComponent(input.threadId)}`
        )
      )
      const place = PLACES.find((p) => p === reply.surface)
      if (place) status.now = place
    } catch {}
  let config: Record<string, any> | undefined
  try {
    config = object(await deps.request(input.port, '/api/config'))
    status.cloud = object(config.box).configured === true || object(config.vps).configured === true
      ? 'ready'
      : 'setup'
    const engine = object(config.browserEngine)
    if (typeof engine.kind === 'string') status.browser = engine.kind === 'unavailable' ? 'setup' : 'ready'
    if (engine.installing === true) status.browserInstalling = true
  } catch {}
  try {
    // The bot's own desktop answers in per-bot mode and the shared one otherwise.
    const raw = await deps.request(input.port, `/api/bots/${input.botId}/local-computer`)
    status.desktop = desktopView(raw, desktopSettings(config))
    const state = status.desktop.state
    status.vm =
      state === 'running'
        ? 'ready'
        : state === 'stopped' || state === 'starting'
          ? 'stopped'
          : state === 'repair' || state === 'failed'
            ? 'repair'
            : 'setup'
  } catch {}
  return status
}
