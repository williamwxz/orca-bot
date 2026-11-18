import { orcaBinary } from './orca-cli.ts'
import { connectRef, pairingScreen } from '../shared/appearance.ts'
import { join } from 'node:path'
import { CliFailure, cliOptions, defaultCliDeps, ombBinary } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'

export type PageStore = {
  get(origin: string): string | undefined
  set(origin: string, pageId: string | undefined): void
}
export type OpenInput = {
  pageStore?: PageStore
  port: number
  startedByPlugin: boolean
  botId?: string
  activeTaskId?: string
  clientBrowser?: boolean
}
export type OpenResult = { message: string }
// Disable anonymous usage analytics by default, while preserving the person's choice.
const ANALYTICS_OPT_OUT = 'omb-analytics-opt-out'
const clientPages = new Map<string, string>()

export function resetClientPages(): void {
  clientPages.clear()
}

export const validBotId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

class ClientBrowserUnavailable extends Error {}

function cliErrorCode(error: unknown): string | undefined {
  if (!(error instanceof CliFailure)) return undefined
  try {
    const code = JSON.parse(error.stdout)?.error?.code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

function resultOf(text: string): Record<string, unknown> {
  const response = JSON.parse(text)
  if (response?.ok !== true || !response.result || typeof response.result !== 'object')
    throw new Error('Invalid CLI response')
  return response.result
}

function browser(deps: CliDeps) {
  const bin = orcaBinary(deps)
  const run = async (args: string[]) => {
    try {
      return resultOf(await deps.execFile(bin, args, cliOptions(deps, 60000)))
    } catch (error) {
      if (cliErrorCode(error) === 'browser_host_unavailable') {
        throw new ClientBrowserUnavailable(
          'Keep Orca open on this computer with Remote server workspaces set to This device, then try again.'
        )
      }
      throw error
    }
  }
  const snapshot = async (page: string) =>
    deps.execFile(bin, ['snapshot', '--page', page], cliOptions(deps))
  const defaultAnalyticsOff = async (page: string): Promise<boolean> => {
    const stored = await run([
      'storage',
      'local',
      'get',
      '--key',
      ANALYTICS_OPT_OUT,
      '--page',
      page,
      '--json'
    ])
    if (stored.value === null) {
      await run([
        'storage',
        'local',
        'set',
        '--key',
        ANALYTICS_OPT_OUT,
        '--value',
        '1',
        '--page',
        page,
        '--json'
      ])
      return true
    }
    if (typeof stored.value !== 'string') throw new Error('Invalid storage response')
    return false
  }
  return { run, snapshot, defaultAnalyticsOff }
}

async function existingTab(origin: string, run: ReturnType<typeof browser>['run']) {
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
  return tab
}

async function existingClientTab(
  origin: string,
  run: ReturnType<typeof browser>['run'],
  store: PageStore
) {
  const saved = store.get(origin)
  if (!saved) return undefined
  const listed = await run(['tab', 'list', '--worktree', 'all', '--json'])
  if (!Array.isArray(listed.tabs)) throw new Error('Invalid tab list')
  const tab = listed.tabs.find(
    (item: { url?: unknown; browserPageId?: unknown }) =>
      item?.browserPageId === saved && typeof item.url === 'string'
  ) as { browserPageId: string; url: string } | undefined
  if (!tab) store.set(origin, undefined)
  return tab
}

export async function openChat(
  input: OpenInput,
  deps: CliDeps = defaultCliDeps()
): Promise<OpenResult> {
  if (input.botId !== undefined && !validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const { run, snapshot, defaultAnalyticsOff } = browser(deps)
  const store: PageStore = input.pageStore ?? {
    get: (origin) => clientPages.get(origin),
    set: (origin, page) => {
      if (page) clientPages.set(origin, page)
      else clientPages.delete(origin)
    }
  }
  const origin = `http://127.0.0.1:${input.port}`
  let page: string
  let wanted = `${origin}/`
  if (input.botId && input.activeTaskId)
    wanted += `?${new URLSearchParams({ thread: input.activeTaskId, bot: input.botId })}`
  try {
    const tab = input.clientBrowser
      ? await existingClientTab(origin, run, store)
      : await existingTab(origin, run)
    if (tab) {
      page = tab.browserPageId
      const tabUrl = new URL(tab.url)
      const sameOrigin = tabUrl.origin === origin
      if (!input.botId && sameOrigin && !tabUrl.pathname.startsWith('/pair')) wanted = tab.url
      const changed = input.startedByPlugin && (await defaultAnalyticsOff(page))
      if (input.botId || changed || !sameOrigin)
        await run(['goto', '--url', wanted, '--page', page, '--json'])
      // Page IDs route to their owning browser; a remote cwd is not a client tab filter.
      await run(['tab', 'switch', '--page', page, '--focus', '--json'])
    } else {
      const initialUrl = input.startedByPlugin ? `${origin}/api/health` : wanted
      // The relay inherits terminal-link's remote worktree cwd. Orca resolves `active`
      // there, and open-url routes that workspace to its paired desktop browser.
      const created = await run(
        input.clientBrowser
          ? ['open-url', '--worktree', 'active', '--url', initialUrl, '--json']
          : ['tab', 'create', '--url', initialUrl, '--json']
      )
      if (typeof created.browserPageId !== 'string') throw new Error('Missing page')
      page = created.browserPageId
      if (input.clientBrowser) store.set(origin, page)
      if (input.startedByPlugin) {
        await defaultAnalyticsOff(page)
        await run(['goto', '--url', wanted, '--page', page, '--json'])
      }
    }
    // Inspect every open so a lost browser session repairs itself without a marker.
    let needsPair = false
    for (let attempt = 0; attempt < 8; attempt++) {
      const tree = await snapshot(page)
      if (pairingScreen(tree)) {
        needsPair = true
        break
      }
      if (attempt < 7) await deps.sleep(250)
    }
    if (!needsPair) return { message: '' }
    if (!input.startedByPlugin) return { message: 'Sign in to OpenMausBot in the browser tab.' }
  } catch (error) {
    if (error instanceof ClientBrowserUnavailable) throw new Error(error.message)
    throw new Error('Could not open chat. Check Orca and OpenMausBot, then try again.')
  }
  return {
    message: (await pairTab(input.port, page, wanted, deps))
      ? ''
      : 'Press Connect in the browser tab to finish.'
  }
}

async function pairTab(
  port: number,
  page: string,
  wanted: string,
  deps: CliDeps
): Promise<boolean> {
  const origin = `http://127.0.0.1:${port}`
  try {
    const { run, snapshot } = browser(deps)
    const output = await deps.execFile(
      ombBinary(deps),
      [
        'pair',
        '--label',
        'Orca',
        '--port',
        String(port),
        '--data-dir',
        join(deps.home, '.orca-bot/data')
      ],
      cliOptions(deps)
    )
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
      if (!pairingScreen(await snapshot(page))) {
        await run(['goto', '--url', wanted, '--page', page, '--json'])
        if (pairingScreen(await snapshot(page))) throw new Error('Session did not persist')
        return true
      }
    }
  } catch {
    // Pairing commands carry credentials; no error, cause, URL or output crosses this boundary.
  }
  return false
}

// Only a boolean leaves this boundary: command output and pairing credentials stay private.
export async function repairChat(
  input: OpenInput,
  deps: CliDeps = defaultCliDeps()
): Promise<boolean> {
  if (!input.startedByPlugin) return true
  try {
    const origin = `http://127.0.0.1:${input.port}`
    const { run, snapshot, defaultAnalyticsOff } = browser(deps)
    const tab = await existingTab(origin, run)
    if (!tab || !pairingScreen(await snapshot(tab.browserPageId))) return true
    const page = tab.browserPageId
    const wanted = new URL(tab.url).pathname.startsWith('/pair') ? `${origin}/` : tab.url
    // As on an explicit existing-tab open, apply the default before any app navigation.
    if (await defaultAnalyticsOff(page))
      await run(['goto', '--url', wanted, '--page', page, '--json'])
    return await pairTab(input.port, page, wanted, deps)
  } catch {
    return false
  }
}
