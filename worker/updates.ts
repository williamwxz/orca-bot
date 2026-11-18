import { readFile } from 'node:fs/promises'
import type { OrcaWorkerApi } from 'orca/worker'
import { compareVersions } from '../shared/omb-version.ts'
import { defaultCliDeps } from './omb-cli.ts'
import { OrcaCliError, callOrca } from './orca-cli.ts'

const PLUGIN_ID = 'bot-for-orca'
const RELEASES = 'https://api.github.com/repos/williamwxz/orca-bot/releases/latest'
/** Successful release checks are cached for six hours. */
export const CHECK_EVERY = 6 * 60 * 60 * 1000
export const RETRY_AFTER = 60 * 1000

export type Updates = {
  version: string
  latest?: string
  /** `dev`: a development folder, which updates with git rather than through Orca. */
  state: 'current' | 'available' | 'updating' | 'updated' | 'approval_required' | 'dev' | 'unknown'
  message: string
  autoUpdate: boolean
}

export type UpdateDeps = {
  /** This copy's version, from its own orca-plugin.json. */
  version(): Promise<string>
  /** The newest release's version, or undefined when GitHub cannot say. */
  latest(): Promise<string | undefined>
  call(args: string[], timeout?: number): Promise<any>
  now(): number
}

export function defaultUpdateDeps(): UpdateDeps {
  const cli = defaultCliDeps()
  return {
    version: async () => {
      const manifest = JSON.parse(
        await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8')
      )
      return String(manifest.version)
    },
    latest: async () => {
      // Sends nothing about you: a plain request for the newest public release.
      const response = await fetch(RELEASES, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'bot-team-for-orca' },
        redirect: 'error',
        signal: AbortSignal.timeout(10000)
      })
      if (!response.ok) return undefined
      const tag = (await response.json())?.tag_name
      return typeof tag === 'string' && /^v\d+\.\d+\.\d+$/.test(tag) ? tag.slice(1) : undefined
    },
    call: (args, timeout) => callOrca(args, cli, timeout),
    now: Date.now
  }
}

export function registerUpdates(orca: OrcaWorkerApi, deps: UpdateDeps = defaultUpdateDeps()): void {
  let nextCheckAt = -Infinity
  let latest: string | undefined
  let checking: Promise<void> | undefined
  let updating: Promise<Updates> | undefined
  let outcome: Pick<Updates, 'state' | 'message'> | undefined

  async function installed(): Promise<{ key?: string; dev: boolean }> {
    const listed = await deps.call(['plugin', 'list', '--json'])
    const mine = (Array.isArray(listed?.plugins) ? listed.plugins : []).filter(
      (plugin: any) =>
        typeof plugin?.pluginKey === 'string' && plugin.pluginKey.endsWith(`.${PLUGIN_ID}`)
    )
    // A development folder overrides an installed copy, so it is the one running.
    if (mine.some((plugin: any) => plugin.isDev)) return { dev: true }
    return { key: mine[0]?.pluginKey, dev: false }
  }

  function check(force: boolean): Promise<void> {
    if (checking) return checking
    if (!force && deps.now() < nextCheckAt) return Promise.resolve()
    const previous = latest
    checking = deps
      .latest()
      .catch(() => undefined)
      .then((version) => {
        if (version !== undefined) latest = version
        nextCheckAt = deps.now() + (version === undefined ? RETRY_AFTER : CHECK_EVERY)
        // Approval for the same release still belongs in Orca, not a repeated Update click.
        if (force || latest !== previous || outcome?.state !== 'approval_required') outcome = undefined
      })
      .finally(() => {
        checking = undefined
      })
    return checking
  }

  async function read(force = false): Promise<Updates> {
    const version = await deps.version()
    const autoUpdate = (await orca.settings.get('autoUpdate')) === true
    const base = { version, latest, autoUpdate }
    if (updating) return { ...base, state: 'updating', message: 'Updating…' }
    if (force) outcome = undefined
    await check(force)
    if (outcome) return { version, latest, autoUpdate, ...outcome }
    const kind = await installed().catch(() => ({ dev: false, key: undefined }))
    const now = { version, latest, autoUpdate }
    if (kind.dev)
      return { ...now, state: 'dev', message: 'This is a development copy. Update it with git.' }
    if (!latest)
      return { ...now, state: 'unknown', message: 'Could not check for updates. Try again later.' }
    if ((compareVersions(latest, version) ?? 0) <= 0)
      return { ...now, state: 'current', message: 'Up to date.' }
    const available: Updates = { ...now, state: 'available', message: `Version ${latest} is available.` }
    // Install each new version by itself at most once, so a failing update is not retried forever.
    if (autoUpdate && kind.key && (await orca.storage.get('autoUpdateTried')) !== latest) {
      await orca.storage.set('autoUpdateTried', latest)
      void install()
      return { ...now, state: 'updating', message: 'Updating…' }
    }
    return available
  }

  function install(): Promise<Updates> {
    updating ??= (async (): Promise<Updates> => {
      const kind = await installed().catch(() => ({ dev: false, key: undefined }))
      if (kind.dev)
        outcome = { state: 'dev', message: 'This is a development copy. Update it with git.' }
      else if (!kind.key)
        outcome = {
          state: 'unknown',
          message: 'Could not find Bot Team for Orca in Orca’s plugin list.'
        }
      else {
        try {
          await deps.call(['plugin', 'update', kind.key, '--json'], 300000)
          outcome = {
            state: 'updated',
            message: 'Updated. Orca restarts Bot Team for Orca with the new version.'
          }
        } catch (error) {
          const code = error instanceof OrcaCliError ? error.code : undefined
          outcome =
            code === 'approval_required' || code === 'approval_stale'
              ? {
                  state: 'approval_required',
                  message: 'This update asks for new access. Approve it in Orca: Settings, then Plugins.'
                }
              : { state: 'available', message: 'Could not update. Try again later.' }
        }
      }
      return {
        version: await deps.version(),
        latest,
        autoUpdate: (await orca.settings.get('autoUpdate')) === true,
        ...outcome
      }
    })().finally(() => {
      updating = undefined
    })
    return updating
  }

  orca.panels.handle('updates.get', (input: { check?: boolean } | undefined) =>
    read(input?.check === true)
  )
  orca.panels.handle('updates.install', () => install())
  orca.panels.handle('updates.auto', async (input: { on?: unknown } | undefined) => {
    if (typeof input?.on !== 'boolean')
      throw new Error('Choose whether to install updates automatically.')
    await orca.settings.set('autoUpdate', input.on)
    return read()
  })
}
