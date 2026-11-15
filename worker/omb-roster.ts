import { defaultHttpDeps } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { mainFirst } from '../shared/roster.ts'
import type { Bot } from '../shared/roster.ts'
import { validBotId } from './omb-open.ts'
import { addableMausBot, visibleBot } from '../shared/appearance.ts'

export async function listBots(input: { port: number }, deps: HttpDeps = defaultHttpDeps()): Promise<Bot[]> {
  try {
    // The CLI projection discards hidden/sidebarHidden/defaultBot and avatarUrl.
    // Use its underlying fleet route so visibility never depends on activity being present.
    const value = await deps.request(input.port, '/api/bots?messages=0') as { bots: Record<string, any>[] }
    if (!Array.isArray(value?.bots)) throw new Error('Invalid roster')
    const bots: Bot[] = []
    for (const bot of value.bots) {
      if (!bot || !validBotId(bot.id) || typeof bot.name !== 'string') throw new Error('Invalid bot')
      const addable = addableMausBot(bot)
      if (!visibleBot(bot) && !addable) continue
      const selection = bot.modelSelection
      if (typeof selection?.instanceId !== 'string' || typeof selection.model !== 'string') throw new Error('Invalid model')
      let avatar: string | undefined
      if (typeof bot.avatarUrl === 'string' && bot.avatarCrop !== 'mascot') {
        try {
          avatar = await deps.avatar(input.port, bot.avatarUrl)
        } catch {
          // A missing or oversized image must never hide a bot.
        }
      }
      bots.push({
        id: bot.id,
        name: bot.name,
        title: typeof bot.title === 'string' ? bot.title : '',
        main: bot.chiefOfStaff === true,
        state: bot.busy ? 'working' : bot.waitingForTeammates || bot.activity === 'waiting-on-you' ? 'waiting' : 'idle',
        unread: bot.unread === true,
        model: `${selection.instanceId}/${selection.model}`,
        modelLabel: [selection.label, bot.modelLabel].find((label) => typeof label === 'string' && label.trim())?.trim() ?? selection.model.replace(/^[^/]+\//, '').replace(/^gpt(?=-|$)/i, 'GPT'),
        ...(typeof bot.threadId === 'string' && bot.threadId ? { activeTaskId: bot.threadId } : {}),
        ...(avatar ? { avatar } : {}),
        ...(addable ? { addable: true } : {})
      })
    }
    return mainFirst(bots)
  } catch {
    throw new Error('Could not refresh bots. Check that OpenMausBot is running.')
  }
}

export async function addMausBot(input: { port: number; botId: string }, deps: HttpDeps = defaultHttpDeps()): Promise<void> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const bots = await listBots(input, deps)
  if (!bots.some((bot) => bot.id === input.botId && bot.addable)) throw new Error('MausBot is no longer hidden. Refresh the roster.')
  try {
    // The UI's Add MausBot welcome action saves these same visibility fields.
    await deps.request(input.port, `/api/bots/${input.botId}`, { welcomed: true, sidebarHidden: false, pinned: true })
  } catch {
    throw new Error('Could not add MausBot. Try again from OpenMausBot settings.')
  }
}

// Check all bots, including hidden/person-owned ones, before stopping a server.
export async function rosterBusy(port: number, deps: HttpDeps = defaultHttpDeps()): Promise<boolean> {
  try {
    const value = await deps.request(port, '/api/bots?messages=0') as { bots: Record<string, unknown>[] }
    if (!Array.isArray(value?.bots)) return true
    return value.bots.some((bot) => !bot || typeof bot !== 'object' || typeof bot.id !== 'string' || bot.busy || bot.waitingForTeammates || bot.activity === 'waiting-on-you')
  } catch { return true }
}
