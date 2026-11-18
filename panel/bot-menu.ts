import { validateGroupName } from '../shared/roster.ts'
import type { Bot, BotAction, GroupRename } from '../shared/roster.ts'

type MenuEvent = {
  clientX?: number
  clientY?: number
  key?: string
  target?: unknown
  preventDefault?: () => void
  stopPropagation?: () => void
}

export function createBotMenu(
  menu: HTMLElement,
  act: (input: BotAction) => Promise<void>,
  renameGroup: (input: GroupRename) => Promise<HTMLElement | undefined>
) {
  let busy = false
  let disabled = false
  let trigger: HTMLElement | undefined
  let items: HTMLButtonElement[] = []

  function close(restoreFocus = true): void {
    if (restoreFocus) trigger?.focus()
    menu.hidden = true
    menu.replaceChildren()
  }

  function position(x: number, y: number): void {
    const style = (menu as HTMLElement & { style?: CSSStyleDeclaration }).style
    if (!style) return
    const width =
      typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 320
    const height =
      typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 600
    const rect = menu.getBoundingClientRect?.() ?? { width: 196, height: 180 }
    const left = Math.max(8, Math.min(x, width - (rect.width || 196) - 8))
    const top = Math.max(8, Math.min(y, height - (rect.height || 180) - 8))
    style.left = `${left}px`
    style.top = `${top}px`
  }

  async function run(input: BotAction): Promise<void> {
    if (busy || disabled) return
    busy = true
    close()
    try {
      await act(input)
    } finally {
      busy = false
    }
  }

  function menuItem(label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `bot-menu-item${extraClass ? ` ${extraClass}` : ''}`
    btn.setAttribute('role', 'menuitem')
    btn.disabled = disabled
    items.push(btn)
    btn.textContent = label
    btn.addEventListener('click', (event) => {
      ;(event as MenuEvent | undefined)?.stopPropagation?.()
      if (!disabled) onClick()
    })
    return btn
  }

  function renderRename(bot: Bot | string): void {
    const title = document.createElement('div')
    title.className = 'bot-menu-title'
    const group = typeof bot === 'string'
    title.textContent = group ? 'Rename group' : 'Rename bot'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'bot-menu-input'
    input.value = typeof bot === 'string' ? bot : bot.name
    input.setAttribute('maxlength', group ? '60' : '80')
    input.setAttribute('aria-label', group ? 'Group name' : 'Bot name')
    const actions = document.createElement('div')
    actions.className = 'bot-menu-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'bot-menu-btn'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => close(true))
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'bot-menu-btn primary'
    save.textContent = 'Save'
    const submit = async () => {
      const trimmed = input.value.trim()
      if (busy || disabled) return
      if (typeof bot === 'string') {
        try {
          validateGroupName(input.value)
        } catch (error) {
          note.textContent = (error as Error).message
          return
        }
        busy = true
        input.disabled = cancel.disabled = save.disabled = true
        note.textContent = ''
        try {
          const heading = await renameGroup({ section: bot, name: trimmed })
          if (menu.contains(input)) {
            close(false)
            ;(heading ?? trigger)?.focus()
          }
        } catch (error) {
          if (menu.contains(input)) {
            note.textContent = error instanceof Error ? error.message : 'Could not rename this group.'
            input.disabled = false
            input.focus()
          }
        } finally {
          busy = false
          input.disabled = cancel.disabled = save.disabled = false
        }
      } else {
        if (!trimmed || trimmed.length > 80) return
        void run({ botId: bot.id, action: 'rename', name: trimmed })
      }
    }
    save.addEventListener('click', submit)
    input.addEventListener('keydown', (event) => {
      const key = (event as MenuEvent | undefined)?.key
      if (key === 'Enter') {
        ;(event as MenuEvent | undefined)?.preventDefault?.()
        submit()
      } else if (key === 'Escape') {
        ;(event as MenuEvent | undefined)?.preventDefault?.()
        close(true)
      }
    })
    actions.append(cancel, save)
    const note = document.createElement('p')
    note.className = 'bot-menu-note'
    note.setAttribute('role', 'alert')
    menu.replaceChildren(title, input, actions, note)
    input.focus()
    ;(input as HTMLInputElement & { select?: () => void }).select?.()
  }

  function renderGroup(bot: Bot, sections: string[]): void {
    const title = document.createElement('div')
    title.className = 'bot-menu-title'
    title.textContent = 'Move to group'
    const items: HTMLElement[] = [title]
    for (const section of sections) {
      const active = bot.section === section
      items.push(
        menuItem(
          active ? `\u2713 ${section}` : section,
          () => void run({ botId: bot.id, action: 'group', section }),
          active ? 'active' : ''
        )
      )
    }
    if (bot.section) {
      items.push(
        menuItem(
          'Remove from group',
          () => void run({ botId: bot.id, action: 'group', section: null })
        )
      )
    }
    const form = document.createElement('div')
    form.className = 'bot-menu-inline'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'bot-menu-input'
    input.setAttribute('placeholder', 'New group\u2026')
    input.setAttribute('maxlength', '60')
    input.setAttribute('aria-label', 'New group name')
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'bot-menu-btn primary'
    add.textContent = 'Add'
    const submit = () => {
      const trimmed = input.value.trim()
      if (!trimmed || trimmed.length > 60) return
      void run({ botId: bot.id, action: 'group', section: trimmed })
    }
    add.addEventListener('click', submit)
    input.addEventListener('keydown', (event) => {
      const key = (event as MenuEvent | undefined)?.key
      if (key === 'Enter') {
        ;(event as MenuEvent | undefined)?.preventDefault?.()
        submit()
      } else if (key === 'Escape') {
        ;(event as MenuEvent | undefined)?.preventDefault?.()
        close(true)
      }
    })
    form.append(input, add)
    items.push(form)
    menu.replaceChildren(...items)
    input.focus()
  }

  function renderDelete(bot: Bot): void {
    const title = document.createElement('div')
    title.className = 'bot-menu-title'
    title.textContent = `Delete ${bot.name}?`
    const note = document.createElement('p')
    note.className = 'bot-menu-note'
    note.textContent = 'This removes the bot and its chat history.'
    const actions = document.createElement('div')
    actions.className = 'bot-menu-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'bot-menu-btn'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => close(true))
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'bot-menu-btn danger'
    confirm.textContent = 'Delete'
    confirm.addEventListener('click', () => void run({ botId: bot.id, action: 'delete' }))
    actions.append(cancel, confirm)
    menu.replaceChildren(title, note, actions)
    confirm.focus()
  }

  function open(
    bot: Bot,
    sections: string[],
    rawEvent?: unknown,
    from?: HTMLElement,
    isDisabled = false
  ): void {
    if (busy && !menu.hidden) {
      ;(rawEvent as MenuEvent | undefined)?.preventDefault?.()
      return
    }
    disabled = busy || isDisabled
    trigger = from
    items = []
    const event = rawEvent as MenuEvent | undefined
    event?.preventDefault?.()
    event?.stopPropagation?.()
    const rect = trigger?.getBoundingClientRect?.()
    const x = event?.clientX || rect?.left || 24
    const y = event?.clientY || rect?.bottom || 80
    const pinItem = menuItem(
      bot.pinned ? 'Unpin' : 'Pin',
      () => void run({ botId: bot.id, action: 'pin', pinned: !bot.pinned })
    )
    const renameItem = menuItem('Rename', () => {
      renderRename(bot)
      position(x, y)
    })
    const groupItem = menuItem('Group', () => {
      items = []
      renderGroup(bot, sections)
      position(x, y)
    })
    const sep = document.createElement('div')
    sep.className = 'bot-menu-sep'
    const deleteItem = bot.defaultBot
      ? menuItem('Hide from list', () => void run({ botId: bot.id, action: 'delete' }))
      : menuItem(
          'Delete',
          () => {
            renderDelete(bot)
            position(x, y)
          },
          'danger'
        )
    menu.replaceChildren(pinItem, renameItem, groupItem, sep, deleteItem)
    menu.hidden = false
    position(x, y)
    pinItem.focus()
  }

  document.addEventListener('click', (rawEvent) => {
    if (menu.hidden) return
    const target = (rawEvent as MenuEvent | undefined)?.target as
      | { closest?: (selector: string) => unknown }
      | undefined
    if (target?.closest?.('#bot-menu')) return
    close()
  })
  document.addEventListener('keydown', (rawEvent) => {
    if (menu.hidden) return
    const event = rawEvent as KeyboardEvent
    if (event.key === 'Escape') {
      event.preventDefault?.()
      close(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const available = items.filter((item) => !item.disabled && menu.contains(item))
    if (!available.length) return
    event.preventDefault?.()
    const index = available.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      index < 0
        ? event.key === 'ArrowDown'
          ? 0
          : available.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : available.length - 1)) % available.length
    available[next].focus()
  })
  window.addEventListener('blur', () => close())
  window.addEventListener('resize', () => close())

  function openGroup(section: string, rawEvent?: unknown, from?: HTMLElement): void {
    const event = rawEvent as MenuEvent | undefined
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (busy) return
    disabled = busy
    trigger = from
    items = []
    const rect = from?.getBoundingClientRect?.()
    const x = event?.clientX || rect?.left || 24
    const y = event?.clientY || rect?.bottom || 80
    const rename = menuItem('Rename', () => {
      renderRename(section)
      position(x, y)
    })
    menu.replaceChildren(rename)
    menu.hidden = false
    position(x, y)
    rename.focus()
  }

  return { open, openGroup, close }
}
