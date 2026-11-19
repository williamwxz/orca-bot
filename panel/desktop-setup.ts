import type { DesktopAction, DesktopState, DesktopStatus } from '../shared/roster.ts'

// Private desktop setup, as OpenMausBot's own "Set up private desktops on this computer" shows it:
// numbered steps that tick off, then the one action that moves the desktop forward.

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
  const el = document.createElement(tag)
  el.textContent = text
  if (cls) el.className = cls
  return el
}

const ORDER: DesktopState[] = [
  'no-runtime',
  'runtime-stopped',
  'not-prepared',
  'not-created',
  'repair',
  'stopped',
  'starting',
  'running'
]

/** What the block says and offers for each state. `action` undefined means "Check again". */
export function desktopStep(status: DesktopStatus, perBot: boolean): {
  title: string
  line: string
  action?: DesktopAction
  label: string
} {
  const app = status.runtime ?? 'the container app'
  switch (status.state) {
    case 'no-runtime':
      return {
        title: 'Install the app that runs private desktops',
        line: 'Docker Desktop or Podman. Podman is free; Docker Desktop may need a paid licence at larger companies. Install one, open it, then check again.',
        label: 'Check again'
      }
    case 'runtime-stopped':
      return { title: `Start ${app}`, line: `Open ${app} and let it finish starting, then check again.`, label: 'Check again' }
    case 'not-prepared':
      return {
        title: 'Get the desktop ready',
        line: 'A one-time download and build of the desktop. It can take several minutes.',
        action: 'prepare',
        label: 'Prepare desktop'
      }
    case 'unsupported':
      return {
        title: 'Per-bot desktops need Docker or Podman',
        line: 'Apple container can run one shared desktop only. Switch Isolation to Shared, or install Docker or Podman.',
        label: 'Check again'
      }
    case 'not-created':
      return {
        title: perBot ? "Create this bot's private desktop" : 'Create the private desktop',
        line: 'A separate Linux desktop on this computer. Bots on it cannot see your files.',
        action: 'create',
        label: 'Create private desktop'
      }
    case 'repair':
      return {
        title: 'Replace the older or unsafe desktop',
        line: 'Recreating keeps its folder and browser sign-ins. Apps installed inside it are removed.',
        action: 'recreate',
        label: 'Delete and recreate'
      }
    case 'stopped':
      return {
        title: 'Stopped',
        line: 'Its files and installed apps are still here. It starts by itself when a bot needs it.',
        action: 'start',
        label: 'Start it now'
      }
    case 'starting':
      return { title: 'Starting…', line: 'The desktop is starting. This takes a few seconds.', label: 'Check again' }
    case 'running':
      return {
        title: 'Running',
        line: `It stops after ${status.idleMinutes} minutes without use; its files and apps stay.`,
        action: 'stop',
        label: 'Stop'
      }
  }
}

const BUSY: Record<DesktopAction, string> = {
  prepare: 'Preparing… this can take several minutes',
  create: 'Creating…',
  start: 'Starting…',
  stop: 'Stopping…',
  recreate: 'Recreating…'
}

/**
 * The setup block. `run` performs a step (or a re-check when given undefined) and resolves when
 * the caller has the new status; the block shows progress meanwhile.
 */
export function desktopBlock(
  status: DesktopStatus,
  options: { perBot: boolean; busy?: DesktopAction | 'check'; run: (action?: DesktopAction) => void }
): HTMLElement {
  const block = node('div', '', 'desktop-setup')
  const at = ORDER.indexOf(status.state)
  const steps = node('ol', '', 'desktop-steps')
  const names: [string, DesktopState][] = [
    ['Install the container app', 'no-runtime'],
    ['Start it', 'runtime-stopped'],
    ['Get the desktop ready', 'not-prepared'],
    [options.perBot ? "Create this bot's desktop" : 'Create the desktop', 'not-created']
  ]
  for (const [name, state] of names) {
    const done = at > ORDER.indexOf(state)
    const current = status.state === state
    const step = node('li', '', done ? 'done' : current ? 'current' : '')
    const mark = node('span', done ? '✓' : String(names.findIndex(([, s]) => s === state) + 1), 'desktop-step-mark')
    mark.setAttribute('aria-hidden', 'true')
    step.append(mark, node('span', name))
    step.setAttribute('aria-label', `${name}: ${done ? 'done' : current ? 'next' : 'not yet'}`)
    steps.append(step)
  }
  const next = desktopStep(status, options.perBot)
  const head = node('div', '', 'desktop-state')
  head.append(node('strong', next.title), node('p', next.line, 'bot-menu-note'))
  const act = node('button', options.busy ? (options.busy === 'check' ? 'Checking…' : BUSY[options.busy]) : next.label, 'bot-menu-btn primary desktop-action') as HTMLButtonElement
  act.type = 'button'
  act.disabled = !!options.busy || !!status.busy
  act.dataset.key = `desktop:${next.action ?? 'check'}`
  if (next.action === 'stop' || next.action === 'recreate') act.className = 'bot-menu-btn desktop-action'
  act.addEventListener('click', (event) => {
    event.stopPropagation()
    if (!act.disabled) options.run(next.action)
  })
  block.append(steps, head, act)
  return block
}
