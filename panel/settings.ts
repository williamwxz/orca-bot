import { INSTALL_NOTICE } from '../shared/omb-version.ts'
import { agentNames } from './setup.ts'
import type { FrameApi } from './chat-view.ts'
import type { Preferences, Status } from '../worker/protocol.ts'
import type { Updates } from '../worker/updates.ts'

type Elements = (id: string) => HTMLElement
const failure = (error: unknown, fallback: string) =>
  (error instanceof Error && error.message) || fallback

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
  let preferencesGeneration = 0
  let updateGeneration = 0
  let installing = false
  let bannerFeedback = ''

  function renderUpdates(): void {
    const available = updates?.state === 'available'
    const show =
      !!bannerFeedback ||
      (!!updates &&
        ['available', 'updating', 'updated', 'approval_required'].includes(updates.state))
    element('update-status').textContent = updates
      ? `Version ${updates.version}. ${updates.message}`
      : 'Checking for updates\u2026'
    for (const id of ['update-install', 'update-banner-install']) {
      button(id).hidden = !available
      button(id).disabled = installing || !available
    }
    input('update-auto').checked = !!updates?.autoUpdate
    input('update-auto').disabled = !updates || updates.state === 'dev'
    element('update-banner').hidden = !show
    element('update-banner-text').textContent =
      bannerFeedback || (show ? (updates?.message ?? '') : '')
  }

  function renderImportCopy(): void {
    const target = remote ?? 'this computer'
    element('pref-share-tools-copy').textContent =
      `Claude bots use the Claude connectors, MCP servers, skills and instructions on ${target}. Codex bots always use the Codex setup on ${target}.`
    element('pref-agent-host').textContent = ` on ${target}`
    element('pref-import-copy').textContent =
      `Adds tools from apps such as Cursor and Claude Desktop on ${target} to OpenMausBot, switched off. Tokens saved in those apps on ${target} are copied to OpenMausBot there.`
  }

  function renderServer(): void {
    const where = remote ? ` on ${remote}` : ''
    renderImportCopy()
    element('omb-status').textContent =
      status?.state === 'running'
        ? `Running${where}${status.version ? `, version ${status.version}` : ''}.`
        : status
          ? `Not running${where}.`
          : ''
    const needsInstall = status?.state === 'needs_install' || !!status?.needsInstall
    const installCopy = remote
      ? INSTALL_NOTICE.replace('into ~/.orca-bot.', `into ~/.orca-bot on ${remote}.`)
      : INSTALL_NOTICE
    for (const id of ['install-card', 'settings-install-card']) {
      element(id).hidden = !needsInstall
      element(`${id}-notice`).textContent = installCopy
    }
    if (needsInstall)
      element('omb-status').textContent = `Installation${where} needs your approval.`
    else if (status && status.state !== 'running')
      element('omb-status').textContent = status.message || `Not running${where}.`
    button('stop-server').hidden = false
    button('stop-server').disabled = status?.state !== 'running'
  }

  function renderPreferences(prefs: Preferences | undefined, problem = ''): void {
    element('permissions-note').textContent = problem
    renderImportCopy()
    for (const id of ['pref-share-tools', 'pref-link-agents']) input(id).disabled = !prefs
    button('pref-import').disabled = !prefs
    if (!prefs) {
      input('pref-share-tools').checked = input('pref-link-agents').checked = false
      return
    }
    input('pref-share-tools').checked = prefs.shareTools
    input('pref-link-agents').checked = prefs.linkAgents
    element('pref-link-agents-label').hidden = !agentNames(prefs.agents)
    element('pref-agent-names').textContent = agentNames(prefs.agents)
  }

  async function loadPreferences(): Promise<void> {
    const generation = ++preferencesGeneration
    try {
      const prefs = await frame.plugin.request('prefs.get', {})
      if (generation === preferencesGeneration) renderPreferences(prefs)
    } catch (error) {
      if (generation === preferencesGeneration)
        renderPreferences(undefined, failure(error, 'Could not read your permissions.'))
    }
  }

  async function loadUpdates(check = false): Promise<void> {
    if (installing) return
    const generation = ++updateGeneration
    try {
      const next = await frame.plugin.request('updates.get', check ? { check: true } : {})
      if (generation !== updateGeneration) return
      if (check || next.latest !== updates?.latest) bannerFeedback = ''
      updates = next
    } catch {
      if (generation !== updateGeneration) return
      element('update-status').textContent = 'Could not check for updates.'
      return
    }
    renderUpdates()
  }

  async function setPreference(key: 'shareTools' | 'linkAgents', value: boolean): Promise<void> {
    const generation = preferencesGeneration
    input(key === 'shareTools' ? 'pref-share-tools' : 'pref-link-agents').disabled = true
    try {
      const prefs = await frame.plugin.request('prefs.set', { [key]: value })
      if (generation !== preferencesGeneration) return
      renderPreferences(prefs)
      note(
        key === 'shareTools'
          ? 'Saved. OpenMausBot restarts to apply it when no bot is working.'
          : 'Saved.'
      )
    } catch (error) {
      if (generation !== preferencesGeneration) return
      note(failure(error, 'Could not save.'))
      await loadPreferences()
    }
    await changed()
  }

  async function install(): Promise<void> {
    if (installing || updates?.state !== 'available') return
    installing = true
    ++updateGeneration
    bannerFeedback = 'Updating\u2026'
    renderUpdates()
    try {
      updates = await frame.plugin.request('updates.install', {})
      bannerFeedback = updates.message
      note(updates.message)
    } catch (error) {
      bannerFeedback = failure(error, 'Could not update. Please retry.')
      note(bannerFeedback)
    } finally {
      installing = false
      renderUpdates()
    }
  }

  for (const id of ['install-omb', 'settings-install-omb']) {
    button(id).addEventListener('click', async () => {
      button('install-omb').disabled = button('settings-install-omb').disabled = true
      try {
        await frame.plugin.request('server.install', {})
        await changed()
      } catch (error) {
        note(failure(error, 'Could not approve installation. Please retry.'))
      } finally {
        button('install-omb').disabled = button('settings-install-omb').disabled = false
      }
    })
  }

  input('pref-share-tools').addEventListener(
    'change',
    () => void setPreference('shareTools', input('pref-share-tools').checked)
  )
  input('pref-link-agents').addEventListener(
    'change',
    () => void setPreference('linkAgents', input('pref-link-agents').checked)
  )
  button('pref-import').addEventListener('click', async () => {
    button('pref-import').disabled = true
    note('Bringing in tools\u2026')
    try {
      const result = await frame.plugin.request('tools.import', {})
      const added = result.added.length
      const failed = result.skipped.some((tool) => tool.reason === 'failed')
      note(
        (added
          ? `Brought in ${added} ${added === 1 ? 'tool' : 'tools'}, switched off. Turn them on per bot in the Bot Dashboard.`
          : 'No new tools to bring in.') + (failed ? ' Some could not be brought in.' : '')
      )
    } catch (error) {
      note(failure(error, 'Could not bring in tools.'))
    }
    button('pref-import').disabled = false
  })
  button('update-check').addEventListener('click', async () => {
    button('update-check').disabled = true
    element('update-status').textContent = 'Checking for updates\u2026'
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
    beginHostChange(nextRemote?: string): void {
      remote = nextRemote
      ++preferencesGeneration
      renderPreferences(undefined, 'Changing where bots run\u2026')
      note('Connecting\u2026')
    },
    async hostChanged(problem = ''): Promise<void> {
      const generation = preferencesGeneration + 1
      await loadPreferences()
      if (generation === preferencesGeneration) note(problem)
    },
    /** Fills the screen each time it opens: permissions and updates can change elsewhere. */
    async open(): Promise<void> {
      note('')
      renderServer()
      await Promise.all([loadPreferences(), loadUpdates()])
    },
    /** Checks for a new version; successful results are cached for six hours. */
    checkUpdates: () => loadUpdates(),
    setStatus(next: Status | undefined, remoteName: string | undefined): void {
      status = next
      remote = remoteName
      renderServer()
    }
  }
}
