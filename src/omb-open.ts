import { connectRef } from '../shared/appearance.ts'
import { join } from 'node:path'
import { cliOptions, defaultCliDeps, ombBinary } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'

export type OpenInput = { port: number; startedByPlugin: boolean; botId?: string; activeTaskId?: string }
export type OpenResult = { message: string }
// Disable anonymous usage analytics by default, while preserving the person's choice.
const ANALYTICS_OPT_OUT = 'omb-analytics-opt-out'
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

export async function openChat(input: OpenInput, deps: CliDeps = defaultCliDeps()): Promise<OpenResult> {
  if (input.botId !== undefined && !validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const bin = orcaBinary(deps)
  const origin = `http://127.0.0.1:${input.port}`
  const run = async (args: string[]) => resultOf(await deps.execFile(bin, args, cliOptions(deps, 60000)))
  const snapshot = async (page: string) => deps.execFile(bin, ['snapshot', '--page', page], cliOptions(deps))
  const defaultAnalyticsOff = async (page: string): Promise<boolean> => {
    const stored = await run(['storage', 'local', 'get', '--key', ANALYTICS_OPT_OUT, '--page', page, '--json'])
    if (stored.value === null) {
      await run(['storage', 'local', 'set', '--key', ANALYTICS_OPT_OUT, '--value', '1', '--page', page, '--json'])
      return true
    }
    if (typeof stored.value !== 'string') throw new Error('Invalid storage response')
    return false
  }
  let page: string
  let wanted = `${origin}/`
  if (input.botId && input.activeTaskId) wanted += `?${new URLSearchParams({ thread: input.activeTaskId, bot: input.botId })}`
  try {
    const listed = await run(['tab', 'list', '--json'])
    if (!Array.isArray(listed.tabs)) throw new Error('Invalid tab list')
    const tab = listed.tabs.find((item: { url?: unknown; browserPageId?: unknown }) => {
      if (typeof item?.url !== 'string' || typeof item.browserPageId !== 'string') return false
      try {
        return new URL(item.url).origin === origin
      } catch {
        return false
      }
    }) as { browserPageId: string; url: string } | undefined
    if (tab) {
      page = tab.browserPageId
      if (!input.botId && !new URL(tab.url).pathname.startsWith('/pair')) wanted = tab.url
      const changed = input.startedByPlugin && await defaultAnalyticsOff(page)
      if (input.botId || changed) await run(['goto', '--url', wanted, '--page', page, '--json'])
      await run(['tab', 'switch', '--page', page, '--focus', '--json'])
    } else {
      const created = await run(['tab', 'create', '--url', input.startedByPlugin ? `${origin}/api/health` : wanted, '--json'])
      if (typeof created.browserPageId !== 'string') throw new Error('Missing page')
      page = created.browserPageId
      if (input.startedByPlugin) {
        await defaultAnalyticsOff(page)
        await run(['goto', '--url', wanted, '--page', page, '--json'])
      }
    }
    // Inspect every open so a lost browser session repairs itself without a marker.
    let needsPair = false
    for (let attempt = 0; attempt < 8; attempt++) {
      const tree = await snapshot(page)
      if (connectRef(tree)) {
        needsPair = true
        break
      }
      if (attempt < 7) await deps.sleep(250)
    }
    if (!needsPair) return { message: '' }
    if (!input.startedByPlugin) return { message: 'Sign in to OpenMausBot in the browser tab.' }
  } catch {
    throw new Error('Could not open chat. Check Orca and OpenMausBot, then try again.')
  }
  try {
    const output = await deps.execFile(ombBinary(deps), ['pair', '--label', 'Orca', '--port', String(input.port), '--data-dir', join(deps.home, '.bot-deck/data')], cliOptions(deps))
    const links = output.match(/http:\/\/127\.0\.0\.1:\d+\/pair#[^\s\x1b]+/g) ?? []
    const link = links.find((value) => new URL(value).origin === origin)
    if (!link) throw new Error('Missing pairing link')
    await run(['goto', '--url', link, '--page', page, '--json'])
    let ref: string | undefined
    for (let attempt = 0; attempt < 8; attempt++) {
      ref = connectRef(await snapshot(page))
      if (ref) break
      await deps.sleep(250)
    }
    if (!ref) throw new Error('Connect unavailable')
    await run(['click', '--element', ref, '--page', page, '--json'])
    // Allow the session cookie to settle before leaving the pairing page.
    for (let attempt = 0; attempt < 8; attempt++) {
      await deps.sleep(250)
      if (!connectRef(await snapshot(page))) {
        await run(['goto', '--url', wanted, '--page', page, '--json'])
        if (connectRef(await snapshot(page))) throw new Error('Session did not persist')
        return { message: '' }
      }
    }
  } catch {
    // Pairing commands carry credentials; no error, cause, URL or output crosses this boundary.
  }
  return { message: 'Press Connect in the browser tab to finish.' }
}
