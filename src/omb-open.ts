import { join } from 'node:path'
import { cliOptions, defaultCliDeps, ombBinary } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'

export type OpenInput = { port: number; startedByPlugin: boolean; botId?: string; activeTaskId?: string }
export type OpenResult = { message: string }
export const validBotId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

function orcaBinary(deps: CliDeps): string {
  const mac = '/Applications/Orca.app/Contents/Resources/bin/orca'
  if (deps.platform === 'darwin' && deps.exists(mac)) return mac
  const separator = deps.platform === 'win32' ? ';' : ':'
  for (const folder of (deps.env.PATH ?? '').split(separator).filter(Boolean)) {
    const path = join(folder, deps.platform === 'win32' ? 'orca.exe' : 'orca')
    if (deps.exists(path)) return path
  }
  throw new Error('Orca CLI was not found. Install Orca or add orca to PATH.')
}

function resultOf(text: string): Record<string, unknown> {
  const response = JSON.parse(text)
  if (response?.ok !== true || !response.result || typeof response.result !== 'object') throw new Error('Invalid CLI response')
  return response.result
}

async function open(input: OpenInput, deps: CliDeps, forcePair: boolean): Promise<OpenResult> {
  if (input.botId !== undefined && !validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const bin = orcaBinary(deps)
  const origin = `http://127.0.0.1:${input.port}`
  const marker = join(deps.home, '.bot-deck/browser-signed-in')
  try {
    const run = async (args: string[]) => resultOf(await deps.execFile(bin, args, cliOptions(deps, 60000)))
    const listed = await run(['tab', 'list', '--json'])
    if (!Array.isArray(listed.tabs)) throw new Error('Invalid tab list')
    const tab = listed.tabs.find((item: unknown) => {
      if (!item || typeof item !== 'object') return false
      const value = item as { url?: unknown; browserPageId?: unknown }
      if (typeof value.url !== 'string' || typeof value.browserPageId !== 'string') return false
      try {
        return new URL(value.url).origin === origin
      } catch {
        return false
      }
    }) as { browserPageId: string } | undefined
    const pair = input.startedByPlugin && (forcePair || !deps.fileExists(marker))
    let url = `${origin}/`
    // Observed on OpenMausBot 0.1.158: activeTaskId is the thread ID used by the web UI.
    // The worker resolves this from its roster, never from panel-supplied thread data.
    if (input.botId && input.activeTaskId) {
      const query = new URLSearchParams({ thread: input.activeTaskId, bot: input.botId })
      url += `?${query}`
    }
    if (pair) {
      const output = await deps.execFile(ombBinary(deps), ['pair', '--label', 'Orca', '--port', String(input.port), '--data-dir', join(deps.home, '.bot-deck/data')], cliOptions(deps))
      const links = output.match(/http:\/\/127\.0\.0\.1:\d+\/pair#[^\s\x1b]+/g) ?? []
      const link = links.find((value) => new URL(value).origin === origin)
      if (!link) throw new Error('Missing sign-in link')
      url = link
    }
    if (tab) {
      if (pair || input.botId) await run(['goto', '--url', url, '--page', tab.browserPageId, '--json'])
      await run(['tab', 'switch', '--page', tab.browserPageId, '--focus', '--json'])
    } else {
      await run(['tab', 'create', '--url', url, '--json'])
    }
    if (pair) deps.write(marker, 'Sign-in link opened.\n', 0o600)
    return { message: 'Opened in an Orca browser tab.' }
  } catch {
    // Never expose subprocess output, errors or causes: they may carry a one-time credential.
    throw new Error('Could not open chat. Check Orca and OpenMausBot, then try again.')
  }
}

export function openChat(input: OpenInput, deps: CliDeps = defaultCliDeps()): Promise<OpenResult> {
  return open(input, deps, false)
}

export function signInAgain(input: OpenInput, deps: CliDeps = defaultCliDeps()): Promise<OpenResult> {
  return open(input, deps, true)
}
