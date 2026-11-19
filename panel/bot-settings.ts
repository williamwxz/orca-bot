import type { Bot } from '../shared/roster.ts'
import { computerLabel, modelText } from '../shared/roster.ts'
import { SKILL_FROM_LABEL } from '../shared/learning.ts'
import type { Learning } from '../shared/learning.ts'
import { whenText } from '../shared/schedules.ts'
import type { Schedule, ScheduleAction, ScheduleWhen } from '../shared/schedules.ts'
import type { FrameApi } from './chat-view.ts'

export type BotSettingsHooks = {
  notify?(message: string): void
  hostGeneration?(): number
  /** Model, Connectors and Computer open the chat's own pickers; the panel closes first. */
  openModel?(bot: Bot): void
  openConnectors?(bot: Bot): void
  openBackend?(bot: Bot): void
}

type Form = { name: string; prompt: string; kind: 'daily' | 'weekdays' | 'interval' | 'once'; time: string; minutes: string; at: string }
const NEW_FORM = (): Form => ({ name: '', prompt: '', kind: 'daily', time: '09:00', minutes: '60', at: '' })
const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/**
 * One bot's settings, as a panel from the right: model, connectors and computer (each opening the
 * chat's picker), its skills with a switch each, its memory with an editor, and its schedules
 * (OpenMausBot routines) to pause, run, delete or add.
 */
export function createBotSettings(root: HTMLElement, frame: FrameApi, hooks: BotSettingsHooks = {}, dismissed: () => void = () => {}) {
  root.className = 'bot-menu capability-menu sheet bot-settings'
  root.hidden = true
  let revision = 0
  let active = false
  let trigger: HTMLElement | undefined
  let redraw: (() => void) | undefined
  let shown: Bot | undefined
  const summary = (bot: Bot) => [bot.model, bot.modelLabel, bot.connectorCount, bot.state, bot.computer ? JSON.stringify(bot.computer) : ''].join('|')
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
    const el = document.createElement(tag)
    el.textContent = text
    if (cls) el.className = cls
    return el
  }
  const button = (text: string, key: string, click: () => void, cls = '') => {
    const el = node('button', text, cls)
    el.type = 'button'
    el.dataset.key = key
    el.addEventListener('click', (event) => {
      event.stopPropagation()
      click()
    })
    return el
  }
  function close(restore = false) {
    ++revision
    if (!active) return
    active = false
    redraw = undefined
    shown = undefined
    root.hidden = true
    root.replaceChildren()
    dismissed()
    if (restore) trigger?.focus()
  }
  async function open(bot: Bot, from: HTMLElement) {
    close()
    active = true
    trigger = from
    shown = bot
    const token = revision
    const host = hooks.hostGeneration?.()
    const current = () => active && token === revision && host === hooks.hostGeneration?.()
    let learning: Learning | undefined
    let schedules: Schedule[] | undefined
    let problem = ''
    let scheduleProblem = ''
    let busy: string | undefined
    let editing: string | undefined
    // The version of MEMORY.md the edit started from: a refresh while editing must not move it.
    let editHash: string | undefined
    let form: Form | undefined
    let confirmDelete: string | undefined
    root.hidden = false
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', `Settings for ${bot.name}`)
    const leaveFor = (open?: (bot: Bot) => void) => () => {
      const target = shown ?? bot
      close()
      open?.(target)
    }

    const section = (children: HTMLElement[], title: string) => children.push(node('div', title, 'learning-heading'))
    const row = (children: HTMLElement[], title: string, detail: string, action: HTMLElement) => {
      const line = node('div', '', 'bot-settings-row')
      const copy = node('span', '', 'setup-copy')
      copy.append(node('strong', title), node('small', detail))
      line.append(copy, action)
      children.push(line)
    }

    function drawSkills(children: HTMLElement[]) {
      section(children, 'Skills')
      if (!learning) return
      if (!learning.skills.length)
        children.push(node('p', 'No skills yet. Type /learn in the chat to save what the bot just did, or turn on Learn skills on their own in Settings.', 'bot-menu-note'))
      for (const skill of learning.skills) {
        const line = node('label', '', 'learning-skill')
        const copy = node('span', '', 'setup-copy')
        const name = node('strong', skill.name)
        name.append(node('span', SKILL_FROM_LABEL[skill.from] ?? 'Added', `learning-tag from-${skill.from}`))
        copy.append(name, node('small', skill.description))
        const toggle = node('input', '', 'switch')
        toggle.type = 'checkbox'
        toggle.setAttribute('role', 'switch')
        toggle.setAttribute('aria-label', `Use ${skill.name}`)
        toggle.checked = skill.enabled
        toggle.disabled = busy !== undefined || !skill.switchable
        if (!skill.switchable)
          toggle.title = skill.from === 'library' ? 'Assigned in OpenMausBot\u2019s skills library; change it there.' : 'On while the bot works in this project; change it there.'
        toggle.dataset.key = `skill:${skill.name}`
        toggle.addEventListener('change', () => void flipSkill(skill.name, toggle.checked))
        line.append(copy, toggle)
        children.push(line)
      }
      if (learning.waiting)
        children.push(node('p', `${learning.waiting} skill change${learning.waiting === 1 ? ' is' : 's are'} waiting for your answer in the full chat.`, 'bot-menu-note'))
    }

    function drawMemory(children: HTMLElement[]) {
      section(children, 'Memory')
      if (!learning) return
      const memory = learning.memory
      if (editing !== undefined) {
        const area = node('textarea', '', 'bot-settings-input learning-memory-edit')
        area.value = editing
        area.rows = 12
        area.dataset.key = 'memory:text'
        area.setAttribute('aria-label', 'What this bot remembers')
        area.addEventListener('input', () => (editing = area.value))
        children.push(area, node('p', 'Only the first 200 lines load into each turn. One note per line works best.', 'bot-menu-note'))
        const actions = node('div', '', 'bot-settings-actions')
        const save = button('Save', 'memory:save', () => void saveMemory(), 'primary')
        const cancel = button('Cancel', 'memory:cancel', () => {
          editing = undefined
          editHash = undefined
          draw()
        })
        save.disabled = cancel.disabled = busy !== undefined
        actions.append(save, cancel)
        children.push(actions)
        return
      }
      if (!memory || !memory.text.trim()) children.push(node('p', 'Nothing remembered yet.', 'bot-menu-note'))
      else {
        const gauge = [
          `${Math.min(memory.lines, memory.maxLines)} of ${memory.maxLines} lines load each turn.`,
          memory.overflow ? 'Some lines no longer load.' : '',
          memory.topics ? `${memory.topics} topic note${memory.topics === 1 ? '' : 's'} read when needed.` : ''
        ]
        children.push(node('p', gauge.filter(Boolean).join(' '), 'bot-menu-note'))
        const text = node('pre', memory.text, 'learning-memory')
        text.tabIndex = 0
        text.setAttribute('aria-label', 'What this bot remembers')
        children.push(text)
      }
      if (memory && !memory.upkeep) children.push(node('p', 'Nightly memory tidy-up is off for this bot.', 'bot-menu-note'))
      if (memory?.hash) {
        const edit = button(memory.text.trim() ? 'Edit memory' : 'Write a note', 'memory:edit', () => {
          editing = memory.text
          editHash = memory.hash
          draw()
          ;(root.querySelector?.('[data-key="memory:text"]') as HTMLElement | null)?.focus()
        })
        edit.disabled = busy !== undefined
        children.push(edit)
      } else if (memory) children.push(node('p', 'This memory is too long to edit here. Edit it in the full chat.', 'bot-menu-note'))
    }

    function drawSchedule(children: HTMLElement[], s: Schedule) {
      const item = node('div', '', 'schedule-item')
      const head = node('label', '', 'schedule-head')
      const copy = node('span', '', 'setup-copy')
      const next = s.nextRunAt
        ? ` · next ${new Date(s.nextRunAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
        : s.enabled ? '' : ' · paused'
      copy.append(node('strong', s.name), node('small', `${whenText(s.when)}${next}`))
      const toggle = node('input', '', 'switch')
      toggle.type = 'checkbox'
      toggle.setAttribute('role', 'switch')
      toggle.setAttribute('aria-label', `${s.enabled ? 'Pause' : 'Turn on'} ${s.name}`)
      toggle.checked = s.enabled
      toggle.disabled = busy !== undefined
      toggle.dataset.key = `schedule:${s.id}:toggle`
      toggle.addEventListener('change', () => void act({ action: 'toggle', id: s.id, enabled: toggle.checked }, toggle.checked ? `${s.name} is on.` : `${s.name} is paused.`))
      head.append(copy, toggle)
      item.append(head)
      if (s.prompt) item.append(node('p', s.prompt.length > 160 ? `${s.prompt.slice(0, 160)}…` : s.prompt, 'schedule-prompt'))
      const actions = node('div', '', 'bot-settings-actions')
      if (confirmDelete === s.id) {
        actions.append(
          node('span', 'Delete this schedule?', 'bot-menu-note'),
          button('Delete', `schedule:${s.id}:delete`, () => void act({ action: 'delete', id: s.id }, `${s.name} deleted.`), 'danger'),
          button('Keep', `schedule:${s.id}:keep`, () => {
            confirmDelete = undefined
            draw()
          })
        )
      } else
        actions.append(
          button('Run now', `schedule:${s.id}:run`, () => void act({ action: 'run', id: s.id }, `${s.name} started.`)),
          button('Delete', `schedule:${s.id}:ask`, () => {
            confirmDelete = s.id
            draw()
          })
        )
      for (const el of Array.from(actions.children) as HTMLButtonElement[]) if (el.tagName !== 'SPAN') el.disabled = busy !== undefined
      item.append(actions)
      children.push(item)
    }

    function drawForm(children: HTMLElement[], f: Form) {
      const box = node('div', '', 'schedule-form')
      const name = node('input', '', 'bot-settings-input')
      name.placeholder = 'Name, such as Morning digest'
      name.maxLength = 80
      name.value = f.name
      name.dataset.key = 'form:name'
      name.setAttribute('aria-label', 'Schedule name')
      name.addEventListener('input', () => (f.name = name.value))
      const prompt = node('textarea', '', 'bot-settings-input')
      prompt.placeholder = 'What should the bot do each time?'
      prompt.rows = 4
      prompt.maxLength = 20000
      prompt.value = f.prompt
      prompt.dataset.key = 'form:prompt'
      prompt.setAttribute('aria-label', 'What the bot does')
      prompt.addEventListener('input', () => (f.prompt = prompt.value))
      const when = node('div', '', 'schedule-when')
      const kind = node('select', '', 'bot-settings-input')
      kind.dataset.key = 'form:kind'
      kind.setAttribute('aria-label', 'When it runs')
      for (const [value, label] of [['daily', 'Every day at'], ['weekdays', 'Weekdays at'], ['interval', 'Every'], ['once', 'Once, on']] as const) {
        const option = node('option', label)
        option.value = value
        kind.append(option)
      }
      kind.value = f.kind
      kind.addEventListener('change', () => {
        f.kind = kind.value as Form['kind']
        draw()
      })
      when.append(kind)
      if (f.kind === 'daily' || f.kind === 'weekdays') {
        const time = node('input', '', 'bot-settings-input')
        time.type = 'time'
        time.value = f.time
        time.dataset.key = 'form:time'
        time.setAttribute('aria-label', 'Time')
        time.addEventListener('input', () => (f.time = time.value))
        when.append(time)
      } else if (f.kind === 'interval') {
        const minutes = node('input', '', 'bot-settings-input')
        minutes.type = 'number'
        minutes.min = '5'
        minutes.max = '1440'
        minutes.value = f.minutes
        minutes.dataset.key = 'form:minutes'
        minutes.setAttribute('aria-label', 'Minutes')
        minutes.addEventListener('input', () => (f.minutes = minutes.value))
        when.append(minutes, node('span', 'minutes', 'bot-menu-note'))
      } else {
        const at = node('input', '', 'bot-settings-input')
        at.type = 'datetime-local'
        at.value = f.at
        at.dataset.key = 'form:at'
        at.setAttribute('aria-label', 'Date and time')
        at.addEventListener('input', () => (f.at = at.value))
        when.append(at)
      }
      const actions = node('div', '', 'bot-settings-actions')
      const save = button('Save schedule', 'form:save', () => void create(f), 'primary')
      const cancel = button('Cancel', 'form:cancel', () => {
        form = undefined
        draw()
      })
      save.disabled = cancel.disabled = busy !== undefined
      actions.append(save, cancel)
      box.append(name, prompt, when, node('p', 'Runs with this bot on the bot host while OpenMausBot is running there.', 'bot-menu-note'), actions)
      children.push(box)
    }

    function drawSchedules(children: HTMLElement[]) {
      section(children, 'Schedules')
      if (scheduleProblem) children.push(node('p', scheduleProblem, 'bot-menu-note'))
      if (!schedules) {
        if (!scheduleProblem) children.push(node('p', 'Loading…', 'bot-menu-note'))
        return
      }
      if (!schedules.length && !form) children.push(node('p', 'No schedules. Add one to have this bot do something on its own at set times.', 'bot-menu-note'))
      for (const s of schedules) drawSchedule(children, s)
      if (form) drawForm(children, form)
      else {
        const add = button('New schedule', 'schedule:new', () => {
          form = NEW_FORM()
          draw()
          ;(root.querySelector?.('[data-key="form:name"]') as HTMLElement | null)?.focus()
        })
        add.disabled = busy !== undefined
        children.push(add)
      }
    }

    const draw = () => {
      if (!current()) return
      const target = shown ?? bot
      const head = node('div', '', 'sheet-head')
      head.append(node('div', `${target.name} settings`, 'bot-menu-title'), button('×', 'close', () => close(true), 'sheet-close'))
      head.lastElementChild?.setAttribute('aria-label', 'Close')
      const children: HTMLElement[] = [head]
      const working = target.state === 'working'
      const change = (label: string, key: string, open?: (bot: Bot) => void) => {
        const el = button(label, key, leaveFor(open), 'settings-open')
        el.disabled = !open
        return el
      }
      const model = change('Change', 'open:model', hooks.openModel)
      if (working) {
        model.disabled = true
        model.title = 'Wait until the reply finishes to change models.'
      }
      row(children, 'Model', modelText(target) || 'Not chosen', model)
      const count = target.connectorCount ?? 0
      row(children, 'Connectors', count ? `${count} allowed` : 'None allowed', change('Choose', 'open:connectors', hooks.openConnectors))
      row(children, 'Computer', computerLabel(target.computer), change('Change', 'open:backend', hooks.openBackend))
      if (problem) children.push(node('p', problem, 'bot-menu-note'))
      else if (!learning) children.push(node('p', 'Loading…', 'bot-menu-note'))
      drawSkills(children)
      drawMemory(children)
      drawSchedules(children)
      const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement | null)?.dataset?.key : undefined
      root.replaceChildren(...children)
      if (focused) (root.querySelector?.(`[data-key="${focused}"]`) as HTMLElement | null)?.focus()
    }
    redraw = draw

    const run = async <T>(key: string, request: () => Promise<T>, done: (value: T) => void, fallback: string) => {
      if (busy !== undefined || !current()) return
      busy = key
      draw()
      try {
        const value = await request()
        if (!current()) return
        done(value)
      } catch (error) {
        if (!current()) return
        hooks.notify?.(error instanceof Error ? error.message : fallback)
      }
      busy = undefined
      draw()
    }
    const flipSkill = (name: string, enabled: boolean) =>
      run('skill', () => frame.plugin.request('learning.skill', { botId: bot.id, name, enabled }), (next) => {
        learning = next
        hooks.notify?.(enabled ? `${name} is on.` : `${name} is off.`)
      }, 'Could not change this skill.')
    const saveMemory = () =>
      run('memory', () => frame.plugin.request('memory.save', { botId: bot.id, text: editing ?? '', hash: editHash ?? '' }), (next) => {
        learning = next
        editing = undefined
        editHash = undefined
        hooks.notify?.('Memory saved.')
      }, 'Could not save memory.')
    // A change that was made but whose list could not be read again: the old list would invite a
    // repeat, so it is replaced by a note and no controls until the panel is reopened.
    const settle = (next: { schedules?: Schedule[] }) => {
      if (next.schedules) {
        schedules = next.schedules
        scheduleProblem = ''
      } else {
        schedules = undefined
        scheduleProblem = 'Done. The list could not be refreshed: close and reopen to see it.'
      }
    }
    const act = (action: ScheduleAction, message: string) =>
      run('schedule', () => frame.plugin.request('schedules.act', { botId: bot.id, ...action }), (next) => {
        settle(next)
        confirmDelete = undefined
        hooks.notify?.(message)
      }, 'Could not change this schedule.')
    const create = (f: Form) => {
      let when: ScheduleWhen
      if (f.kind === 'interval') when = { kind: 'interval', everyMinutes: Number(f.minutes) }
      else if (f.kind === 'once') {
        const at = new Date(f.at).getTime()
        if (!f.at || !Number.isFinite(at)) return hooks.notify?.('Choose a date and time.')
        when = { kind: 'once', at }
      } else when = { kind: 'daily', time: f.time, weekdays: f.kind === 'weekdays' ? WEEKDAYS : EVERY_DAY }
      return run('schedule', () => frame.plugin.request('schedules.act', { botId: bot.id, action: 'create', name: f.name, prompt: f.prompt, when }), (next) => {
        settle(next)
        form = undefined
        hooks.notify?.(`${f.name.trim()} is scheduled.`)
      }, 'Could not save this schedule.')
    }

    draw()
    await Promise.all([
      frame.plugin.request('learning.read', { botId: bot.id }).then(
        (next) => current() && (learning = next),
        (error) => current() && (problem = error instanceof Error ? error.message : 'Could not load skills and memory.')
      ),
      frame.plugin.request('schedules.list', { botId: bot.id }).then(
        (next) => current() && (schedules = next),
        (error) => current() && (scheduleProblem = error instanceof Error ? error.message : 'Could not load schedules.')
      )
    ])
    draw()
  }
  document.addEventListener('click', (event) => {
    if (active && !root.contains(event.target as Node) && !trigger?.contains(event.target as Node)) close(false)
  })
  document.addEventListener('keydown', (event) => {
    if (active && event.key === 'Escape') {
      event.preventDefault()
      close(true)
    }
  })
  return {
    open,
    close,
    isOpen: () => active,
    /** A fresh roster: redraws only when what the panel shows of the bot changed, so typing is never interrupted. */
    update(bot: Bot) {
      if (!active || bot.id !== shown?.id) return
      const changed = summary(bot) !== summary(shown)
      shown = bot
      if (changed) redraw?.()
    }
  }
}
