import { agentNames } from './setup.ts'
import type { FrameApi } from './chat-view.ts'
import type { Preferences, Status } from '../worker/protocol.ts'
import type { Updates } from '../worker/updates.ts'

type Elements = (id: string) => HTMLElement
const failure = (error: unknown, fallback: string) => (error instanceof Error && error.message) || fallback

/**
 * The settings screen: permissions, updates and OpenMausBot. Where the bots run is chosen
 * by app.ts, which also clears the bot list when it changes.
 */
export function createSettings(frame: FrameApi, element: Elements, changed: () => Promise<void>) {
  const input = (id: string) => element(id) as HTMLInputElement
  const button = (id: string) => element(id) as HTMLButtonElement
  const note = (text: string) => {
    element('settings-message').textContent = text
  }
  let remote: string | undefined
  let status: Status | undefined
  let updates: Updates | undefined

  function renderUpdates(): void {
    const banner = !!updates && updates.state === 'available'
    element('update-status').textContent = updates
      ? `Version ${updates.version}. ${updates.message}`
      : 'Checking for updates…'
    button('update-install').hidden = !banner
    button('update-install').disabled = updates?.state === 'updating'
    input('update-auto').checked = !!updates?.autoUpdate
    input('update-auto').disabled = !updates || updates.state === 'dev'
    // The main view asks once a new version is out, unless updates install by themselves.
    element('update-banner').hidden = !banner
    element('update-banner-text').textContent = banner ? updates!.message : ''
  }

  function renderServer(): void {
    const where = remote ? ` on ${remote}` : ''
    element('omb-status').textContent =
      status?.state === 'running'
        ? `Running${where}${status.version ? `, version ${status.version}` : ''}.`
        : status
          ? `Not running${where}.`
          : ''
    button('stop-server').hidden = !!remote
    button('stop-server').disabled = status?.state !== 'running'
  }

  function renderPreferences(prefs: Preferences | undefined, problem = ''): void {
    element('permissions-note').textContent = problem
    for (const id of ['pref-share-tools', 'pref-link-agents']) input(id).disabled = !prefs
    button('pref-import').disabled = !prefs
    if (!prefs) return
    input('pref-share-tools').checked = prefs.shareTools
    input('pref-link-agents').checked = prefs.linkAgents
    element('pref-link-agents-label').hidden = !agentNames(prefs.agents)
    element('pref-agent-names').textContent = agentNames(prefs.agents)
  }

  async function loadPreferences(): Promise<void> {
    try {
      renderPreferences(await frame.plugin.request('prefs.get', {}))
    } catch (error) {
      // On a paired server, these are set in Orca there.
      renderPreferences(undefined, failure(error, 'Could not read your permissions.'))
    }
  }

  async function loadUpdates(check = false): Promise<void> {
    try {
      updates = await frame.plugin.request('updates.get', check ? { check: true } : {})
    } catch {
      updates = undefined
      element('update-status').textContent = 'Could not check for updates.'
      element('update-banner').hidden = true
      return
    }
    renderUpdates()
  }

  async function setPreference(key: 'shareTools' | 'linkAgents', value: boolean): Promise<void> {
    input(key === 'shareTools' ? 'pref-share-tools' : 'pref-link-agents').disabled = true
    try {
      renderPreferences(await frame.plugin.request('prefs.set', { [key]: value }))
      note(key === 'shareTools' ? 'Saved. OpenMausBot restarts to apply it when no bot is working.' : 'Saved.')
    } catch (error) {
      note(failure(error, 'Could not save.'))
      await loadPreferences()
    }
    await changed()
  }

  async function install(): Promise<void> {
    button('update-install').disabled = true
    button('update-banner-install').disabled = true
    try {
      updates = await frame.plugin.request('updates.install', {})
      note(updates.message)
    } catch (error) {
      note(failure(error, 'Could not update.'))
    }
    button('update-banner-install').disabled = false
    renderUpdates()
    element('update-banner-text').textContent = updates?.message ?? ''
  }

  input('pref-share-tools').addEventListener('change', () => void setPreference('shareTools', input('pref-share-tools').checked))
  input('pref-link-agents').addEventListener('change', () => void setPreference('linkAgents', input('pref-link-agents').checked))
  button('pref-import').addEventListener('click', async () => {
    button('pref-import').disabled = true
    note('Bringing in tools…')
    try {
      const result = await frame.plugin.request('tools.import', {})
      const added = result.added.length
      const failed = result.skipped.some((tool) => tool.reason === 'failed')
      note(
        (added ? `Brought in ${added} ${added === 1 ? 'tool' : 'tools'}, switched off. Turn them on per bot in the Bot Dashboard.` : 'No new tools to bring in.') +
          (failed ? ' Some could not be brought in.' : '')
      )
    } catch (error) {
      note(failure(error, 'Could not bring in tools.'))
    }
    button('pref-import').disabled = false
  })
  button('update-check').addEventListener('click', async () => {
    button('update-check').disabled = true
    element('update-status').textContent = 'Checking for updates…'
    await loadUpdates(true)
    button('update-check').disabled = false
  })
  button('update-install').addEventListener('click', () => void install())
  button('update-banner-install').addEventListener('click', () => void install())
  input('update-auto').addEventListener('change', async () => {
    try {
      updates = await frame.plugin.request('updates.auto', { on: input('update-auto').checked })
      renderUpdates()
    } catch (error) {
      note(failure(error, 'Could not save.'))
    }
  })
  button('stop-server').addEventListener('click', async () => {
    button('stop-server').disabled = true
    try {
      note((await frame.plugin.request('server.stop', {})).message)
    } catch (error) {
      note(failure(error, 'Could not stop OpenMausBot.'))
    }
    await changed()
  })

  return {
    /** Fills the screen each time it opens: permissions and updates can change elsewhere. */
    async open(): Promise<void> {
      note('')
      renderServer()
      await Promise.all([loadPreferences(), loadUpdates()])
    },
    /** Checks for a new version for the banner; GitHub is asked at most every six hours. */
    checkUpdates: () => loadUpdates(),
    setStatus(next: Status | undefined, remoteName: string | undefined): void {
      status = next
      remote = remoteName
      renderServer()
    }
  }
}
