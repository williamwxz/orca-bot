import { randomUUID } from 'node:crypto'
import { CliFailure, cliOptions, defaultCliDeps, ombBinary } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'
import { validBotId } from './omb-open.ts'
import { parseThread } from '../shared/chat.ts'
import type { Thread } from '../shared/chat.ts'

function failure(value: unknown, sending: boolean): string {
  const raw = value as { error?: { code?: string } | string; code?: string }
  const code = typeof raw?.error === 'object' ? raw.error?.code : raw?.code ?? raw?.error
  if (code === 'BOT_NOT_FOUND' || code === 'bot_not_found') return 'This bot is no longer available. Refresh the roster.'
  if (code === 'UNAUTHORIZED' || code === 'unauthorized') return 'Open the full chat to sign in.'
  return sending ? 'Could not confirm sending. Check the full chat before trying again.' : 'Could not read messages. Open the full chat or try again.'
}
async function run(args: string[], sending: boolean, deps: CliDeps): Promise<unknown> {
  let output: string
  let exitThree = false
  try {
    output = await deps.execFile(ombBinary(deps), args, cliOptions(deps, 15000))
  } catch (error) {
    if (error instanceof CliFailure && sending && error.code === 3) { output = error.stdout; exitThree = true }
    else {
      let value: unknown
      try { value = JSON.parse(error instanceof CliFailure ? error.stdout : '') } catch { /* Never forward stderr. */ }
      throw new Error(failure(value, sending))
    }
  }
  let value: any
  try { value = JSON.parse(output) } catch {
    if (exitThree) return {}
    throw new Error(failure(undefined, sending))
  }
  if (!exitThree && (value?.ok === false || value?.error)) throw new Error(failure(value, sending))
  return value
}
export async function readThread(input: { port: number; botId: string; limit?: number }, deps: CliDeps = defaultCliDeps()): Promise<Thread> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const limit = input.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Message limit must be between 1 and 20.')
  const value = await run(['messages', '--bot', input.botId, '--limit', String(limit), '--port', String(input.port), '--json'], false, deps)
  try { return parseThread(value) } catch { throw new Error(failure(undefined, false)) }
}
export async function sendMessage(input: { port: number; botId: string; text: string; sendId: string }, deps: CliDeps = defaultCliDeps()): Promise<{ sendId: string }> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) throw new Error('Enter a message of 1–16,000 characters.')
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(input.sendId)) throw new Error('Invalid send ID.')
  await run(['send', '--bot', input.botId, '--text', input.text, '--send-id', input.sendId, '--port', String(input.port), '--json'], true, deps)
  return { sendId: input.sendId }
}
export const newSendId = (): string => randomUUID()
