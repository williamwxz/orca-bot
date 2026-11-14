// The plugin's worker: every panel action becomes one gbot call against the real Grok Bot.
import type { OrcaWorkerApi } from 'orca/worker'
import { toBot, toEntry, type Bot } from '../shared/model'
import { findGbot, GbotError, runGbot } from './gbot'

// Grok Bot ids are UUIDs. Refusing anything else keeps a name (which could match a group, or
// start with "-") from ever reaching gbot as a target.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireId(id: unknown): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new GbotError('invalid_params', 'Unknown bot id')
  return id
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GbotError('invalid_params', `${label} is required`)
  }
  if (value.length > max) throw new GbotError('invalid_params', `${label} is too long`)
  return value
}

export default function activate(orca: OrcaWorkerApi): void {
  async function gbot(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const configured = await orca.settings.get('gbotPath')
    const bin = findGbot(typeof configured === 'string' ? configured : '')
    return runGbot(bin, args, { signal, timeoutMs })
  }

  async function listBots(signal?: AbortSignal): Promise<Bot[]> {
    const raw = await gbot(['bots', 'list', '--json'], signal)
    return (Array.isArray(raw) ? raw : []).map(toBot).filter((bot) => bot.id)
  }

  const handle = orca.panels.handle as (
    name: string,
    handler: (input: any, context: { signal: AbortSignal }) => Promise<unknown>
  ) => void

  handle('status', async (_input, { signal }) => {
    try {
      const raw = (await gbot(['doctor', '--json'], signal)) as {
        gatewayAuthPresent?: boolean
        grokBotAppSession?: { usable?: boolean }
      } | null
      const signedIn = raw?.grokBotAppSession?.usable === true || raw?.gatewayAuthPresent === true
      return signedIn
        ? { ok: true, message: '' }
        : { ok: false, message: 'Open the Grok Bot desktop app and sign in, then retry.' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('bots.list', (_input, { signal }) => listBots(signal))

  handle('bots.create', async ({ name, instructions }, { signal }) => {
    const args = ['bots', 'create', '--json', `--name=${requireText(name, 'Name', 80)}`]
    if (typeof instructions === 'string' && instructions.trim()) {
      args.push(`--description=${requireText(instructions, 'Instructions', 8000)}`)
    }
    await gbot(args, signal)
    return listBots(signal)
  })

  handle('bots.update', async ({ id, name, instructions, hidden }, { signal }) => {
    const args = ['bots', 'update', '--json']
    if (name !== undefined) args.push(`--name=${requireText(name, 'Name', 80)}`)
    if (typeof instructions === 'string') {
      if (instructions.length > 8000) throw new GbotError('invalid_params', 'Instructions are too long')
      args.push(`--description=${instructions}`)
    }
    if (typeof hidden === 'boolean') args.push(`--hidden=${hidden ? 'on' : 'off'}`)
    args.push(requireId(id))
    await gbot(args, signal)
    return listBots(signal)
  })

  handle('bots.delete', async ({ id }, { signal }) => {
    await gbot(['bots', 'delete', '--json', requireId(id)], signal)
    return listBots(signal)
  })

  handle('thread.read', async ({ id, limit }, { signal }) => {
    const count = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 60))
    const raw = (await gbot(
      ['thread', '--json', '--no-history', `--limit=${count}`, requireId(id)],
      signal
    )) as { transcript?: { entries?: unknown[] } } | null
    return (raw?.transcript?.entries ?? []).map(toEntry).filter((entry) => entry.id)
  })

  handle('message.send', async ({ id, text }, { signal }) => {
    // `--` ends gbot's options, so a message that starts with "-" is still just text.
    await gbot(
      ['send', '--json', '--no-history', requireId(id), '--', requireText(text, 'Message', 16000)],
      signal,
      60_000
    )
    return { sent: true }
  })

  orca.log('Bot Deck worker ready')
}
