import { cliOptions, defaultCliDeps, ombBinary } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'
import { mainFirst } from '../shared/roster.ts'
import type { Bot } from '../shared/roster.ts'
import { validBotId } from './omb-open.ts'

function mapBot(value: unknown): Bot {
  if (!value || typeof value !== 'object') throw new Error('Invalid bot')
  const bot = value as Record<string, unknown>
  if (!validBotId(bot.id) || typeof bot.name !== 'string' || typeof bot.title !== 'string') throw new Error('Invalid bot')
  for (const field of ['chiefOfStaff', 'busy', 'waitingForTeammates', 'unread']) {
    if (typeof bot[field] !== 'boolean') throw new Error('Invalid bot')
  }
  const selection = bot.modelSelection as { instanceId?: unknown; model?: unknown } | null
  if (!selection || typeof selection.instanceId !== 'string' || typeof selection.model !== 'string') throw new Error('Invalid model')
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    main: bot.chiefOfStaff as boolean,
    state: bot.busy ? 'working' : bot.waitingForTeammates ? 'waiting' : 'idle',
    unread: bot.unread as boolean,
    modelLabel: [selection.instanceId, selection.model].filter(Boolean).join(' / ') || 'Default model'
  }
}

export async function listBots(input: { port: number }, deps: CliDeps = defaultCliDeps()): Promise<Bot[]> {
  let output: string
  try {
    output = await deps.execFile(ombBinary(deps), ['bots', '--port', String(input.port), '--json'], cliOptions(deps))
  } catch {
    throw new Error('Could not refresh bots. Check that OpenMausBot is running.')
  }
  try {
    const value = JSON.parse(output)
    if (!Array.isArray(value?.bots)) throw new Error('Invalid roster')
    return mainFirst(value.bots.map(mapBot))
  } catch {
    throw new Error('OpenMausBot returned an unexpected bot list.')
  }
}
