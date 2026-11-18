import type { Bot, BotAction } from '../shared/roster.ts'

type MenuEvent = {
  clientX?: number
  clientY?: number
  key?: string
  target?: unknown
  preventDefault?: () => void
  stopPropagation?: () => void
}

export function createBotMenu(menu: HTMLElement, act: (input: BotAction) => Promise<void>) {
  let busy = false

  function close(): void {
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
    if (busy) return
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
    btn.textContent = label
    btn.addEventListener('click', (event) => {
      ;(event as MenuEvent | undefined)?.stopPropagation?.()
      onClick()
    })
    return btn
  }

  function renderRename(bot: Bot): void {
    const title = document.createElement('div')
    title.className = 'bot-menu-title'
    title.textContent = 'Rename bot'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'bot-menu-input'
    input.value = bot.name
    input.setAttribute('maxlength', '80')
    input.setAttribute('aria-label', 'Bot name')
    const actions = document.createElement('div')
    actions.className = 'bot-menu-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'bot-menu-btn'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => close())
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'bot-menu-btn primary'
    save.textContent = 'Save'
    const submit = () => {
      const trimmed = input.value.trim()
      if (!trimmed || trimmed.length > 80) return
      void run({ botId: bot.id, action: 'rename', name: trimmed })
    }
    save.addEventListener('click', submit)
    input.addEventListener('keydown', (event) => {
      const key = (event as MenuEvent | undefined)?.key
      if (key === 'Enter') {
        ;(event as MenuEvent | undefined)?.preventDefault?.()
        submit()
      } else if (key === 'Escape') {
        ;(event as MenuEvent | undefined)?.preventDefault?.()
        close()
      }
    })
    actions.append(cancel, save)
    menu.replaceChildren(title, input, actions)
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
        close()
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
    cancel.addEventListener('click', () => close())
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'bot-menu-btn danger'
    confirm.textContent = 'Delete'
    confirm.addEventListener('click', () => void run({ botId: bot.id, action: 'delete' }))
    actions.append(cancel, confirm)
    menu.replaceChildren(title, note, actions)
    confirm.focus()
  }

  function open(bot: Bot, sections: string[], rawEvent?: unknown): void {
    if (busy) return
    const event = rawEvent as MenuEvent | undefined
    event?.preventDefault?.()
    event?.stopPropagation?.()
    const x = typeof event?.clientX === 'number' ? event.clientX : 24
    const y = typeof event?.clientY === 'number' ? event.clientY : 80
    const pinItem = menuItem(
      bot.pinned ? 'Unpin' : 'Pin',
      () => void run({ botId: bot.id, action: 'pin', pinned: !bot.pinned })
    )
    const renameItem = menuItem('Rename\u2026', () => {
      renderRename(bot)
      position(x, y)
    })
    const groupItem = menuItem('Group\u2026', () => {
      renderGroup(bot, sections)
      position(x, y)
    })
    const sep = document.createElement('div')
    sep.className = 'bot-menu-sep'
    const deleteItem = bot.defaultBot
      ? menuItem('Hide from list', () => void run({ botId: bot.id, action: 'delete' }))
      : menuItem(
          'Delete\u2026',
          () => {
            renderDelete(bot)
            position(x, y)
          },
          'danger'
        )
    menu.replaceChildren(pinItem, renameItem, groupItem, sep, deleteItem)
    menu.hidden = false
    position(x, y)
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
    if (!menu.hidden && (rawEvent as MenuEvent | undefined)?.key === 'Escape') close()
  })
  window.addEventListener('blur', () => close())
  window.addEventListener('resize', () => close())

  return { open, close }
}
