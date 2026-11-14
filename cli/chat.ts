import type { Bot, Entry } from '../shared/model.ts'

export type ChatClient = {
  listBots: () => Promise<Bot[]>
  readThread: (id: string, limit: number) => Promise<Entry[]>
  sendMessage: (id: string, text: string) => Promise<{ delivery: 'accepted' | 'unknown' }>
}

export type ChatIO = {
  readLine: (prompt: string) => Promise<string | null>
  write: (text: string) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  stopped?: () => boolean
}

const HELP = '/b bots | /r refresh | /m N history (max 50) | /h help | /q quit'
const UNCLEAR = 'Send outcome unclear. Check /r before sending again.'

// Terminal control characters from a transcript must remain plain text.
function clean(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

export function wrap(text: string): string {
  return clean(text).split('\n').map(line => {
    const lines: string[] = []
    let rest = Array.from(line)
    while (rest.length > 60) {
      const space = rest.slice(0, 61).lastIndexOf(' ')
      const end = space > 0 ? space : 60
      lines.push(rest.slice(0, end).join(''))
      rest = rest.slice(end + (space > 0 ? 1 : 0))
    }
    lines.push(rest.join(''))
    return lines.join('\n')
  }).join('\n')
}

export function formatEntry(entry: Entry, name: string): string {
  if (entry.type !== 'text' && entry.type !== 'event') {
    const label = entry.type === 'email' ? 'draft' : entry.type
    return `[${label}: open the Grok Bot app]`
  }
  const text = Array.from(clean(entry.text))
  const clipped = text.slice(0, 1500).join('') + (text.length > 1500 ? ' [...]' : '')
  return wrap(entry.role === 'event'
    ? `-- ${clipped} --`
    : `${entry.role === 'user' ? 'you' : clean(name)}: ${clipped}`)
}

function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Error: ${clean(message).replace(/\s+/g, ' ')}`
}

function signature(entry: Entry): string {
  return JSON.stringify(entry)
}

export async function runChat(client: ChatClient, io: ChatIO): Promise<void> {
  let bots: Bot[] = []
  let selected: Bot | undefined
  let listNeeded = true
  let newest = -Infinity
  const seen = new Map<string, string>()
  const stopped = () => io.stopped?.() ?? false
  const say = (text: string) => {
    if (!stopped()) io.write(`${text}\n`)
  }

  async function history(limit: number, onlyNew: boolean): Promise<Entry[]> {
    const entries = (await client.readThread(selected!.id, limit))
      .sort((a, b) => a.ts - b.ts).slice(-limit)
    const fresh = entries.filter(entry => {
      if (seen.has(entry.id)) return seen.get(entry.id) !== signature(entry)
      return entry.ts >= newest
    })
    for (const entry of onlyNew ? fresh : entries) {
      say(formatEntry(entry, selected!.name))
    }
    for (const entry of entries) {
      seen.set(entry.id, signature(entry))
      newest = Math.max(newest, entry.ts)
    }
    return fresh
  }

  async function waitForReply(): Promise<void> {
    const deadline = io.now() + 120_000
    while (!stopped() && io.now() < deadline) {
      await io.sleep(Math.min(3000, deadline - io.now()))
      if (stopped()) return
      const entries = await history(200, true)
      if (entries.some(entry => entry.role === 'bot' && !entry.streaming)) return
    }
    if (!stopped()) say('Still working. /r refreshes the conversation.')
  }

  while (!stopped()) {
    if (listNeeded) {
      listNeeded = false
      try {
        bots = (await client.listBots()).sort((a, b) => Number(a.hidden) - Number(b.hidden))
        bots.forEach((bot, index) => say(wrap(`${index + 1}. ${bot.name}${bot.hidden ? ' [hidden]' : ''}`)))
        if (!bots.length) say('No bots found. /r retries.')
      } catch (error) {
        say(errorLine(error))
      }
    }
    if (stopped()) return
    const input = await io.readLine(selected ? '> ' : 'bot> ')
    if (input === null) return
    const line = input.trim()
    if (!line) continue
    if (line === '/q') return
    if (line === '/h') {
      say(wrap(HELP))
      continue
    }
    if (line === '/b') {
      selected = undefined
      listNeeded = true
      continue
    }
    try {
      if (!selected) {
        if (line === '/r') {
          listNeeded = true
          continue
        }
        if (line.startsWith('/')) {
          say(wrap(HELP))
          continue
        }
        const matches = /^\d+$/.test(line)
          ? bots.filter((_, index) => index === Number(line) - 1)
          : bots.filter(bot => bot.name.toLowerCase().startsWith(line.toLowerCase()))
        if (matches.length !== 1) {
          say(matches.length ? 'Ambiguous bot. Use a number.' : 'Unknown bot. Use a number or name prefix.')
          continue
        }
        selected = matches[0]
        seen.clear()
        newest = -Infinity
        await history(10, false)
      } else if (line === '/r') {
        await history(200, true)
      } else if (/^\/m\s+\d+$/.test(line) && Number(line.slice(3)) > 0) {
        await history(Math.min(50, Number(line.slice(3))), false)
      } else if (line.startsWith('/')) {
        say(wrap(HELP))
      } else {
        if (line.length > 16000) {
          say('Error: Message is too long (max 16000 characters).')
          continue
        }
        const result = await client.sendMessage(selected.id, line)
        if (result.delivery !== 'accepted') {
          say(UNCLEAR)
          continue
        }
        await waitForReply()
      }
    } catch (error) {
      if ((error as { code?: string })?.code === 'outcome_unknown') {
        say(`${errorLine(error)} ${UNCLEAR}`)
      } else {
        say(errorLine(error))
      }
    }
  }
}
