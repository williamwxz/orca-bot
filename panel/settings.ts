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
export function createSettings(frame: FrameApi, element: Elements, changed: () => Promise<void>, note: (text: string) => void) {
  const input = (id: string) => element(id) as HTMLInputElement
  const button = (id: string) => element(id) as HTMLButtonElement
  let remote: string | undefined
  let status: Status | undefined
  let updates: Updates | undefined
  let preferencesGeneration = 0
  let learningGeneration = 0
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
      if (check) note(next.message)
    } catch {
      if (generation !== updateGeneration) return
      if (check) note('Could not check for updates.')
      renderUpdates()
      return
    }
    renderUpdates()
  }

  function renderLearning(autoLearn: boolean | undefined, problem = ''): void {
    element('learning-note').textContent = problem
    input('learning-auto').disabled = autoLearn === undefined
    input('learning-auto').checked = !!autoLearn
  }

  async function loadLearning(): Promise<void> {
    const generation = ++learningGeneration
    try {
      const { autoLearn } = await frame.plugin.request('learning.settings', {})
      if (generation === learningGeneration) renderLearning(autoLearn)
    } catch (error) {
      if (generation === learningGeneration)
        renderLearning(undefined, failure(error, 'Could not read the learning setting.'))
    }
  }

  async function setLearning(autoLearn: boolean): Promise<void> {
    const generation = ++learningGeneration
    input('learning-auto').disabled = true
    try {
      const saved = await frame.plugin.request('learning.settings', { autoLearn })
      if (generation !== learningGeneration) return
      renderLearning(saved.autoLearn)
      note(saved.autoLearn ? 'Saved. Bots now learn skills on their own.' : 'Saved.')
    } catch (error) {
      if (generation !== learningGeneration) return
      note(failure(error, 'Could not save.'))
      await loadLearning()
    }
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
  input('learning-auto').addEventListener('change', () => void setLearning(input('learning-auto').checked))
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
      note('Saved.')
    } catch (error) {
      note(failure(error, 'Could not save.'))
    }
  })
  let exportGeneration = 0
  let exportPoll: ReturnType<typeof setTimeout> | undefined
  const wait = (ms: number) => new Promise<void>((resolve) => (exportPoll = setTimeout(resolve, ms)))
  /** Follows the export on the bot host until it ends; a failed check is retried, never read as done. */
  async function followExport(id: number, generation: number) {
    for (let misses = 0; misses < 40; ) {
      await wait(1500)
      if (generation !== exportGeneration) return undefined
      const job = await frame.plugin.request('team.export.status', {}).then((r) => r.job, () => undefined)
      if (generation !== exportGeneration) return undefined
      if (!job || job.id !== id) {
        misses++
        continue
      }
      if (!job.running) return job
      misses = 0
    }
    throw new Error('Could not confirm how the export ended. Look in Downloads on the bot host.')
  }
  button('export-team').addEventListener('click', async () => {
    const generation = ++exportGeneration
    button('export-team').disabled = true
    element('export-note').textContent = 'Exporting\u2026'
    try {
      const started = await frame.plugin.request('team.export', {})
      const job = started.running ? await followExport(started.id, generation) : started
      if (!job || generation !== exportGeneration) return
      if (job.error || !job.result) throw new Error(job.error ?? 'Could not finish the export. Try again.')
      const done = job.result
      const where = remote ? ` on ${remote}` : ''
      const counts = `${done.bots} bot${done.bots === 1 ? '' : 's'}, ${done.skills} skill${done.skills === 1 ? '' : 's'}, ${done.memoryFiles} memory file${done.memoryFiles === 1 ? '' : 's'}`
      const missed = done.skipped.length ? ` Not exported: ${done.skipped.slice(0, 5).join('; ')}${done.skipped.length > 5 ? '\u2026' : ''}.` : ''
      element('export-note').textContent = `Saved ${counts} to ${done.folder}${where}. Its README says how to use them elsewhere.${missed}`
    } catch (error) {
      if (generation === exportGeneration) element('export-note').textContent = failure(error, 'Could not finish the export. Try again.')
    } finally {
      if (generation === exportGeneration) button('export-team').disabled = false
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
      ++learningGeneration
      renderLearning(undefined)
      ++exportGeneration
      clearTimeout(exportPoll)
      element('export-note').textContent = ''
      button('export-team').disabled = false
    },
    async hostChanged(problem = ''): Promise<void> {
      const generation = preferencesGeneration + 1
      await Promise.all([loadPreferences(), loadLearning()])
      if (generation === preferencesGeneration) note(problem)
    },
    /** Fills the screen each time it opens: permissions and updates can change elsewhere. */
    async open(): Promise<void> {
      note('')
      renderServer()
      await Promise.all([loadPreferences(), loadLearning(), loadUpdates()])
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
