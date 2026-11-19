import type { Bot } from '../shared/roster.ts'
import { SKILL_FROM_LABEL } from '../shared/learning.ts'
import type { Learning } from '../shared/learning.ts'
import type { FrameApi } from './chat-view.ts'

export type LearningHooks = {
  notify?(message: string): void
  /** A skill count to show on the chat's Skills button. */
  counted?(botId: string, count: number): void
  hostGeneration?(): number
}

/**
 * A bot's skills and memory, as a panel from the right like Backend. Skills can be switched on
 * or off here; writing and editing them, and editing memory, stay in the full chat.
 */
export function createLearningSheet(root: HTMLElement, frame: FrameApi, hooks: LearningHooks = {}, dismissed: () => void = () => {}) {
  root.className = 'bot-menu capability-menu sheet learning-sheet'
  root.hidden = true
  let revision = 0
  let active = false
  let trigger: HTMLElement | undefined
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
    const el = document.createElement(tag)
    el.textContent = text
    if (cls) el.className = cls
    return el
  }
  function close(restore = false) {
    ++revision
    if (!active) return
    active = false
    root.hidden = true
    root.replaceChildren()
    dismissed()
    if (restore) trigger?.focus()
  }
  async function open(bot: Bot, from: HTMLElement) {
    close()
    active = true
    trigger = from
    const token = revision
    const host = hooks.hostGeneration?.()
    const current = () => active && token === revision && host === hooks.hostGeneration?.()
    let learning: Learning | undefined
    let problem = ''
    let saving: string | undefined
    root.hidden = false
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', `Skills and memory for ${bot.name}`)

    const draw = () => {
      if (!current()) return
      const head = node('div', '', 'sheet-head')
      const dismiss = node('button', '×', 'sheet-close')
      dismiss.type = 'button'
      dismiss.setAttribute('aria-label', 'Close')
      dismiss.addEventListener('click', (event) => {
        event.stopPropagation()
        close(true)
      })
      head.append(node('div', `Skills and memory for ${bot.name}`, 'bot-menu-title'), dismiss)
      const children: HTMLElement[] = [head]
      if (problem) children.push(node('p', problem, 'bot-menu-note'))
      if (!learning) {
        if (!problem) children.push(node('p', 'Loading…', 'bot-menu-note'))
        root.replaceChildren(...children)
        return
      }
      children.push(node('div', 'Skills', 'learning-heading'))
      if (!learning.skills.length)
        children.push(
          node(
            'p',
            'No skills yet. Type /learn in the chat to save what the bot just did, or turn on Learn skills on their own in Settings.',
            'bot-menu-note'
          )
        )
      for (const skill of learning.skills) {
        const row = node('label', '', 'learning-skill')
        const copy = node('span', '', 'setup-copy')
        const name = node('strong', skill.name)
        name.append(node('span', SKILL_FROM_LABEL[skill.from] ?? 'Added', `learning-tag from-${skill.from}`))
        copy.append(name, node('small', skill.description))
        const toggle = node('input', '', 'switch')
        toggle.type = 'checkbox'
        toggle.setAttribute('role', 'switch')
        toggle.setAttribute('aria-label', `Use ${skill.name}`)
        toggle.checked = skill.enabled
        toggle.disabled = saving !== undefined || !skill.switchable
        if (!skill.switchable) toggle.title = 'On while the bot works in this project; change it there.'
        toggle.dataset.key = skill.name
        toggle.addEventListener('change', () => void flip(skill.name, toggle.checked))
        row.append(copy, toggle)
        children.push(row)
      }
      if (learning.waiting)
        children.push(
          node('p', `${learning.waiting} skill change${learning.waiting === 1 ? ' is' : 's are'} waiting for your answer in the full chat.`, 'bot-menu-note')
        )
      children.push(node('div', 'Memory', 'learning-heading'))
      const memory = learning.memory
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
      children.push(node('p', 'Edit memory and skills in the full chat.', 'bot-menu-note'))
      const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement | null)?.dataset?.key : undefined
      root.replaceChildren(...children)
      if (focused) (root.querySelector?.(`[data-key="${focused}"]`) as HTMLElement | null)?.focus()
    }
    const flip = async (name: string, enabled: boolean) => {
      if (saving !== undefined || !current()) return
      saving = name
      draw()
      try {
        const next = await frame.plugin.request('learning.skill', { botId: bot.id, name, enabled })
        if (!current()) return
        learning = next
        hooks.notify?.(enabled ? `${name} is on.` : `${name} is off.`)
      } catch (error) {
        if (!current()) return
        hooks.notify?.(error instanceof Error ? error.message : 'Could not change this skill.')
      }
      saving = undefined
      if (learning) hooks.counted?.(bot.id, learning.skills.filter((s) => s.enabled).length)
      draw()
    }
    draw()
    try {
      const next = await frame.plugin.request('learning.read', { botId: bot.id })
      if (!current()) return
      learning = next
      hooks.counted?.(bot.id, next.skills.filter((s) => s.enabled).length)
    } catch (error) {
      if (!current()) return
      problem = error instanceof Error ? error.message : 'Could not load skills and memory.'
    }
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
  return { open, close, isOpen: () => active }
}
