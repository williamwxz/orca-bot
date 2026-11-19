import type { DesktopAction, DesktopReason, DesktopState, DesktopStatus } from '../shared/roster.ts'

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
  'failed',
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
        title: 'A private desktop already exists, but it cannot be used',
        line: `${REASONS[status.reason ?? 'unsafe']} ${replaceNote(status)}`,
        action: 'recreate',
        label: 'Replace with a fresh desktop'
      }
    case 'failed':
      return {
        title: "The desktop didn't start",
        line: `Its container is running, but the desktop inside it reported an error. Replacing it with a fresh one usually fixes this. ${replaceNote(status)}`,
        action: 'recreate',
        label: 'Replace with a fresh desktop'
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

/** Why an existing desktop cannot be used, in plain words. Most often it was made by an earlier
 * OpenMausBot version or install, not by you. */
const REASONS: Record<DesktopReason, string> = {
  'no-folder': 'OpenMausBot could not confirm the writable folder it keeps its files in. This often happens when an earlier OpenMausBot install or test made the desktop.',
  'old-image': 'It was made by an older OpenMausBot and uses an outdated desktop.',
  'not-managed': 'It was not made by OpenMausBot, so OpenMausBot will not use it.',
  unsafe: 'It is missing safety limits that OpenMausBot now requires.'
}

/** What replacing keeps. The shared folder is promised only when OpenMausBot confirmed it. */
function replaceNote(status: DesktopStatus): string {
  if (status.folderUnverified || status.reason === 'no-folder')
    return 'OpenMausBot could not confirm its shared folder, so replacing it makes a fresh desktop with a new folder. Anything stored in the old desktop may not be kept.'
  return 'Replacing it keeps its shared folder and browser sign-ins; apps and files stored anywhere else inside it are removed.'
}

const BUSY: Record<DesktopAction, string> = {
  prepare: 'Preparing… this can take several minutes',
  create: 'Creating…',
  start: 'Starting…',
  stop: 'Stopping…',
  recreate: 'Replacing…'
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
  // A desktop that must be replaced has not really finished its last step.
  const at = status.state === 'repair' || status.state === 'failed'
    ? ORDER.indexOf('not-created')
    : ORDER.indexOf(status.state)
  const steps = node('ol', '', 'desktop-steps')
  const names: [string, DesktopState][] = [
    ['Install the container app', 'no-runtime'],
    ['Start it', 'runtime-stopped'],
    ['Get the desktop ready', 'not-prepared'],
    [
      status.state === 'repair' || status.state === 'failed'
        ? 'Replace the desktop'
        : options.perBot ? "Create this bot's desktop" : 'Create the desktop',
      'not-created'
    ]
  ]
  for (const [name, state] of names) {
    const done = at > ORDER.indexOf(state)
    const current = ORDER[at] === state
    const step = node('li', '', done ? 'done' : current ? 'current' : '')
    const mark = node('span', done ? '✓' : String(names.findIndex(([, s]) => s === state) + 1), 'desktop-step-mark')
    mark.setAttribute('aria-hidden', 'true')
    step.append(mark, node('span', name))
    step.setAttribute('aria-label', `${name}: ${done ? 'done' : current ? 'next' : 'not yet'}`)
    steps.append(step)
  }
  if (status.mode === 'pool' && !['no-runtime', 'runtime-stopped', 'not-prepared'].includes(status.state)) {
    block.append(steps, node('p', 'Pool desktops start and stop by themselves when bots need them. Manage them in native OpenMausBot.', 'bot-menu-note'))
    return block
  }
  const running = status.step?.running ? status.step.action : undefined
  const busy = options.busy ?? running
  const next = desktopStep(status, options.perBot)
  const head = node('div', '', 'desktop-state')
  head.append(node('strong', next.title), node('p', next.line, 'bot-menu-note'))
  const act = node('button', busy ? (busy === 'check' ? 'Checking…' : BUSY[busy]) : next.label, 'bot-menu-btn primary desktop-action') as HTMLButtonElement
  act.type = 'button'
  act.disabled = !!busy
  act.dataset.key = `desktop:${next.action ?? 'check'}`
  if (next.action === 'stop' || next.action === 'recreate') act.className = 'bot-menu-btn desktop-action'
  act.addEventListener('click', (event) => {
    event.stopPropagation()
    if (!act.disabled) options.run(next.action)
  })
  block.append(steps, head, act)
  return block
}
