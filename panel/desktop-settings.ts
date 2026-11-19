import { desktopBlock } from './desktop-setup.ts'
import type { FrameApi } from './chat-view.ts'
import type { DesktopAction, DesktopStatus } from '../shared/roster.ts'

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
  const el = document.createElement(tag)
  el.textContent = text
  if (cls) el.className = cls
  return el
}

/**
 * Settings → Private desktops: OpenMausBot's "Desktops & browser" setup for the bot host, with
 * its Isolation and idle-stop choices. Per-bot desktops are created from each bot's Backend panel.
 */
export function createDesktopSettings(
  frame: FrameApi,
  element: (id: string) => HTMLElement,
  notify: (text: string) => void,
  generation: () => number = () => 0
) {
  const note = element('desktops-note')
  const setup = element('desktops-setup')
  const options = element('desktops-options')
  let status: DesktopStatus | undefined
  let busy: DesktopAction | 'check' | 'settings' | undefined
  let loadedFor: number | undefined
  let following: number | undefined
  let poll: ReturnType<typeof setTimeout> | undefined

  function render(): void {
    setup.replaceChildren()
    options.replaceChildren()
    if (!status) return
    const perBot = status.mode === 'per-bot'
    // Per bot: only the host-wide steps belong here; each desktop is created from its bot.
    const hostWide = ['no-runtime', 'runtime-stopped', 'not-prepared', 'unsupported'].includes(status.state)
    if (!perBot || hostWide)
      setup.append(
        desktopBlock(status, {
          perBot: false,
          busy: busy === 'settings' ? undefined : busy,
          run: (action) => void act(action)
        })
      )
    else
      setup.append(
        node('p', "The desktop image is ready. Create each bot's desktop from its Backend panel (the computer icon in its chat).", 'settings-note')
      )
    if (status.mode === 'pool') {
      options.append(node('p', 'Pool desktops are managed in native OpenMausBot.', 'settings-note'))
      return
    }
    const isolation = node('div', '', 'desktop-option')
    isolation.append(
      node('strong', 'Isolation'),
      node('small', 'Shared is one desktop all bots take turns on. Per bot gives each bot its own desktop, folder and idle timer.')
    )
    const segmented = node('div', '', 'desktop-segmented')
    segmented.setAttribute('role', 'radiogroup')
    segmented.setAttribute('aria-label', 'Isolation')
    for (const [mode, label] of [['shared', 'Shared'], ['per-bot', 'Per bot']] as const) {
      const choice = node('button', label) as HTMLButtonElement
      choice.type = 'button'
      choice.setAttribute('role', 'radio')
      choice.setAttribute('aria-checked', String(status.mode === mode))
      choice.disabled = !!busy
      choice.addEventListener('click', () => {
        if (status?.mode !== mode) void save({ mode })
      })
      segmented.append(choice)
    }
    isolation.append(segmented)
    options.append(isolation)
    if (perBot) {
      const max = node('label', '', 'desktop-option desktop-inline')
      const select = node('select') as HTMLSelectElement
      for (let n = 1; n <= 8; n++) {
        const option = node('option', String(n)) as HTMLOptionElement
        option.value = String(n)
        select.append(option)
      }
      select.value = String(status.maxInstances)
      select.disabled = !!busy
      select.addEventListener('change', () => void save({ maxInstances: Number(select.value) }))
      max.append(node('span', 'Maximum per-bot desktops'), select)
      options.append(max, node('small', 'Each running desktop may use up to 4 GB of memory and 2 CPUs.', 'desktop-option-note'))
    }
    const idle = node('label', '', 'desktop-option desktop-inline')
    const minutes = node('input') as HTMLInputElement
    minutes.type = 'number'
    minutes.min = '5'
    minutes.max = '1440'
    minutes.step = '1'
    minutes.value = String(status.idleMinutes)
    minutes.disabled = !!busy
    minutes.addEventListener('change', () => {
      const value = Number(minutes.value)
      if (!Number.isInteger(value) || value < 5 || value > 1440) {
        notify('Enter a whole number from 5 to 1,440.')
        minutes.value = String(status?.idleMinutes ?? 480)
        return
      }
      void save({ idleMinutes: value })
    })
    idle.append(node('span', 'Stop idle desktops after'), minutes, node('span', 'minutes'))
    options.append(idle, node('small', 'A desktop with a running turn is never stopped. Files and installed apps stay.', 'desktop-option-note'))
  }

  async function load(): Promise<void> {
    const at = generation()
    try {
      const next = await frame.plugin.request('desktop.status', {})
      if (at !== generation()) return
      status = next
      note.textContent = ''
    } catch (error) {
      if (at !== generation()) return
      // While following a step, a failed poll keeps the controls and tries again.
      if (following !== undefined) {
        loadedFor = at
        follow(following, at)
        return
      }
      status = undefined
      note.textContent = error instanceof Error ? error.message : 'Could not check the private desktop.'
    }
    loadedFor = at
    // A step started here or in a Backend panel is still running: follow it to the end.
    const step = status?.step
    if (step?.running) follow(step.id, at)
    else if (step && step.id === following) {
      following = undefined
      notify(step.error ?? 'Private desktop updated.')
    } else if (following !== undefined) follow(following, at)
    render()
  }

  function follow(id: number, at: number): void {
    following = id
    clearTimeout(poll)
    poll = setTimeout(() => {
      if (at === generation()) void load()
    }, 2500)
  }

  async function act(action?: DesktopAction): Promise<void> {
    if (busy || status?.step?.running) return
    busy = action ?? 'check'
    render()
    try {
      if (action) following = (await frame.plugin.request('desktop.act', { action })).step.id
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not start this step.')
    } finally {
      busy = undefined
    }
    await load()
  }

  async function save(change: { mode?: 'shared' | 'per-bot'; maxInstances?: number; idleMinutes?: number }) {
    if (busy) return
    busy = 'settings'
    render()
    try {
      await frame.plugin.request('desktop.settings', change)
      notify('Private desktop setting saved.')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save the setting.')
    } finally {
      busy = undefined
    }
    await load()
  }

  return {
    /** Reads the status when Settings opens, and again after a host change. */
    refresh: () => (busy && loadedFor === generation() ? Promise.resolve() : load()),
    clear() {
      clearTimeout(poll)
      following = undefined
      status = undefined
      note.textContent = ''
      render()
    }
  }
}
