import { defaultHttpDeps, HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { mainFirst } from '../shared/roster.ts'
import type { Bot, BotAction } from '../shared/roster.ts'
import { validBotId } from './omb-open.ts'
import { addableMausBot, visibleBot } from '../shared/appearance.ts'

export async function listBots(
  input: { port: number },
  deps: HttpDeps = defaultHttpDeps()
): Promise<Bot[]> {
  try {
    // The CLI projection discards hidden/sidebarHidden/defaultBot and avatarUrl.
    // Use its underlying fleet route so visibility never depends on activity being present.
    const value = (await deps.request(input.port, '/api/bots?messages=0')) as {
      bots: Record<string, any>[]
      sections?: unknown[]
    }
    if (!Array.isArray(value?.bots)) throw new Error('Invalid roster')
    const knownSections = Array.isArray(value.sections)
      ? value.sections
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : []
    const bots: Bot[] = []
    for (const bot of value.bots) {
      if (!bot || !validBotId(bot.id) || typeof bot.name !== 'string')
        throw new Error('Invalid bot')
      const addable = addableMausBot(bot)
      if (!visibleBot(bot) && !addable) continue
      const selection = bot.modelSelection
      if (typeof selection?.instanceId !== 'string' || typeof selection.model !== 'string')
        throw new Error('Invalid model')
      let avatar: string | undefined
      if (typeof bot.avatarUrl === 'string' && bot.avatarCrop !== 'mascot') {
        try {
          avatar = await deps.avatar(input.port, bot.avatarUrl)
        } catch {
          // A missing or oversized image must never hide a bot.
        }
      }
      const section =
        typeof bot.section === 'string' && bot.section.trim() ? bot.section.trim() : undefined
      bots.push({
        id: bot.id,
        name: bot.name,
        title: typeof bot.title === 'string' ? bot.title : '',
        main: bot.chiefOfStaff === true,
        state: bot.busy
          ? 'working'
          : bot.waitingForTeammates || bot.activity === 'waiting-on-you'
            ? 'waiting'
            : 'idle',
        unread: bot.unread === true,
        model: `${selection.instanceId}/${selection.model}`,
        modelLabel:
          [selection.label, bot.modelLabel]
            .find((label) => typeof label === 'string' && label.trim())
            ?.trim() ?? selection.model.replace(/^[^/]+\//, '').replace(/^gpt(?=-|$)/i, 'GPT'),
        ...(typeof bot.threadId === 'string' && bot.threadId ? { activeTaskId: bot.threadId } : {}),
        ...(avatar ? { avatar } : {}),
        ...(addable ? { addable: true } : {}),
        ...(bot.pinned === true ? { pinned: true } : {}),
        ...(section ? { section } : {}),
        ...(bot.defaultBot && typeof bot.defaultBot === 'object' ? { defaultBot: true } : {})
      })
    }
    const ordered = mainFirst(bots)
    if (ordered.length && knownSections.length) {
      ordered[0] = { ...ordered[0], knownSections }
    }
    return ordered
  } catch {
    throw new Error('Could not refresh bots. Check that OpenMausBot is running.')
  }
}

export async function addMausBot(
  input: { port: number; botId: string },
  deps: HttpDeps = defaultHttpDeps()
): Promise<void> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const bots = await listBots(input, deps)
  if (!bots.some((bot) => bot.id === input.botId && bot.addable))
    throw new Error('MausBot is no longer hidden. Refresh the roster.')
  try {
    // The UI's Add MausBot welcome action saves these same visibility fields.
    await deps.request(input.port, `/api/bots/${input.botId}`, {
      welcomed: true,
      sidebarHidden: false,
      pinned: true
    })
  } catch {
    throw new Error('Could not add MausBot. Try again from OpenMausBot settings.')
  }
}

export function validateBotAction(input: BotAction): void {
  if (!input || !validBotId(input.botId)) throw new Error('Invalid bot ID.')
  if (input.action === 'pin') {
    if (typeof input.pinned !== 'boolean') throw new Error('Invalid pin state.')
  } else if (input.action === 'rename') {
    const trimmed = typeof input.name === 'string' ? input.name.trim() : ''
    if (!trimmed || trimmed.length > 80)
      throw new Error('Enter a bot name between 1 and 80 characters.')
  } else if (input.action === 'group') {
    if (input.section !== null) {
      const trimmed = typeof input.section === 'string' ? input.section.trim() : ''
      if (!trimmed || trimmed.length > 60)
        throw new Error('Enter a group name between 1 and 60 characters.')
    }
  } else if (input.action !== 'delete') {
    throw new Error('Unsupported bot action.')
  }
}

export async function actOnBot(
  input: { port: number } & BotAction,
  deps: HttpDeps = defaultHttpDeps()
): Promise<void> {
  validateBotAction(input)

  const bots = await listBots({ port: input.port }, deps)
  const target = bots.find((bot) => bot.id === input.botId && !bot.addable)
  if (!target) throw new Error('This bot is no longer in the roster. Refresh the roster.')

  try {
    if (input.action === 'pin') {
      await deps.request(input.port, `/api/bots/${input.botId}`, { pinned: input.pinned })
      return
    }
    if (input.action === 'rename') {
      await deps.request(input.port, `/api/bots/${input.botId}`, { name: input.name.trim() })
      return
    }
    if (input.action === 'group') {
      const trimmed = input.section?.trim() ?? ''
      if (!trimmed) {
        await deps.request(input.port, `/api/bots/${input.botId}`, { section: null })
      } else {
        await deps.request(
          input.port,
          '/api/sidebar-sections',
          { name: trimmed, botIds: [input.botId] },
          'POST'
        )
      }
      return
    }
    // OpenMausBot keeps the default MausBot record and hides it from the sidebar instead.
    if (target.defaultBot) {
      await deps.request(input.port, `/api/bots/${input.botId}`, { sidebarHidden: true })
      return
    }
    await deps.request(input.port, `/api/bots/${input.botId}`, undefined, 'DELETE')
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 409 && input.action === 'group') {
      throw new Error('That group already has a Chief of Staff.')
    }
    const verb =
      input.action === 'pin'
        ? 'update pin state'
        : input.action === 'rename'
          ? 'rename this bot'
          : input.action === 'group'
            ? 'update this bot\u2019s group'
            : target.defaultBot
              ? 'hide MausBot'
              : 'delete this bot'
    throw new Error(`Could not ${verb}. Try again from the Bot Dashboard.`)
  }
}

// Check all bots, including hidden/person-owned ones, before stopping a server.
export async function rosterBusy(
  port: number,
  deps: HttpDeps = defaultHttpDeps()
): Promise<boolean> {
  try {
    const value = (await deps.request(port, '/api/bots?messages=0')) as {
      bots: Record<string, unknown>[]
    }
    if (!Array.isArray(value?.bots)) return true
    return value.bots.some(
      (bot) =>
        !bot ||
        typeof bot !== 'object' ||
        typeof bot.id !== 'string' ||
        bot.busy ||
        bot.waitingForTeammates ||
        bot.activity === 'waiting-on-you'
    )
  } catch {
    return true
  }
}
