import { cliOptions, defaultCliDeps, ombBinary } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'
import { parseModels, requireModel } from '../shared/models.ts'
import type { ModelGroup } from '../shared/models.ts'
import { validBotId } from './omb-open.ts'

export async function listModels(input: { port: number }, deps: CliDeps = defaultCliDeps()): Promise<ModelGroup[]> {
  try {
    return parseModels(JSON.parse(await deps.execFile(ombBinary(deps), ['models', '--port', String(input.port), '--json'], cliOptions(deps))))
  } catch {
    throw new Error('Could not load models. Check OpenMausBot and try again.')
  }
}

export async function createBot(input: { port: number; name: string; model: string }, deps: CliDeps = defaultCliDeps()): Promise<{ id: string; activeTaskId?: string }> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name) || name.startsWith('-')) throw new Error('Enter a name of 1–100 characters that does not start with a dash.')
  const model = requireModel(await listModels(input, deps), input.model)
  try {
    // Never retry: a timeout can mean the bot was created but its reply was lost.
    const result = JSON.parse(await deps.execFile(ombBinary(deps), ['new-bot', name, '--model', model, '--port', String(input.port), '--json'], cliOptions(deps, 60000)))
    if (!validBotId(result.bot?.id)) throw new Error('Invalid created bot')
    const activeTaskId = result.bot.activeTaskId ?? result.bot.threadId
    return { id: result.bot.id, ...(typeof activeTaskId === 'string' ? { activeTaskId } : {}) }
  } catch {
    throw new Error('Could not confirm creation. Check the roster before trying again; the bot may already exist.')
  }
}

export async function setModel(input: { port: number; botId: string; model: string }, deps: CliDeps = defaultCliDeps()): Promise<void> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const model = requireModel(await listModels(input, deps), input.model)
  let bots: { id: string; busy: boolean; waitingForTeammates: boolean }[]
  try {
    bots = JSON.parse(await deps.execFile(ombBinary(deps), ['bots', '--port', String(input.port), '--json'], cliOptions(deps))).bots
  } catch {
    throw new Error('Could not check whether the bot is idle.')
  }
  const bot = Array.isArray(bots) ? bots.find((bot) => bot.id === input.botId) : undefined
  if (!bot) throw new Error('This bot is no longer available.')
  if (bot.busy || bot.waitingForTeammates) throw new Error('This bot is busy. Wait until it is idle to change its model.')
  try {
    await deps.execFile(ombBinary(deps), ['set-model', input.botId, '--model', model, '--port', String(input.port), '--json'], cliOptions(deps))
  } catch {
    throw new Error('Could not change the model. The bot may have started working; refresh and try again when idle.')
  }
}
