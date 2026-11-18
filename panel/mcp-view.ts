import type { FrameApi } from './chat-view.ts'
import type { Connector, Connectors, ConnectorAction } from '../worker/mcp-connectors.ts'

export function createMcpView(frame: FrameApi, element: (id: string) => HTMLElement) {
  let data: Connectors | undefined
  let generation = 0
  let pendingGeneration: number | undefined
  const busy = () => pendingGeneration === generation
  let hostId: string | undefined
  let focusedKey: string | undefined
  let removing: string | undefined
  let remote: string | undefined
  const button = (id: string) => element(id) as HTMLButtonElement
  const message = (text: string) => {
    element('mcp-message').textContent = text
  }
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const el = document.createElement(tag)
    if (text) el.textContent = text
    return el
  }
  const key = <T extends HTMLElement>(el: T, value: string): T => {
    el.dataset.focus = value
    return el
  }
  let tab: 'provider' | 'bot' = 'provider'
  let selectedBot: string | undefined
  let returnTo: (() => void) | undefined
  const actionButton = (text: string, focus: string, click: () => void, className = 'mcp-pill') => {
    const el = key(node('button', text), focus)
    el.type = 'button'
    el.className = className
    el.disabled = busy()
    el.addEventListener('click', click)
    return el
  }
  function assign(row: Connector, botId: string) {
    void act({
      action: 'assign',
      name: row.name,
      fingerprint: row.fingerprint,
      bots: row.bots.includes(botId) ? row.bots.filter((id) => id !== botId) : [...row.bots, botId]
    })
  }
  function switchControl(row: Connector, botId?: string) {
    const toggle = key(node('input'), botId ? `${row.name}-allow-${botId}` : `${row.name}-toggle`)
    toggle.className = 'switch'
    toggle.type = 'checkbox'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute(
      'aria-label',
      botId
        ? `Allow ${data?.bots.find((b) => b.id === botId)?.name} to use ${row.name}`
        : `Enable ${row.name}`
    )
    toggle.checked = botId ? row.bots.includes(botId) : row.enabled
    toggle.disabled = busy() || (!!botId && !!row.bot)
    toggle.addEventListener('change', () =>
      botId
        ? assign(row, botId)
        : void act({
            action: 'toggle',
            name: row.name,
            fingerprint: row.fingerprint,
            enabled: toggle.checked
          })
    )
    return toggle
  }
  function setTab(next: typeof tab, focus = false) {
    tab = next
    render(focus ? `tab-${next}` : undefined)
  }
  function titleFor(row: Connector, subtitle = false) {
    const title = node('div')
    title.className = 'mcp-row-title'
    title.append(node('strong', row.rawName))
    if (subtitle || row.name !== row.rawName) {
      const slug = node(
        'span',
        subtitle ? `${row.provider}${row.name !== row.rawName ? ` · ${row.name}` : ''}` : row.name
      )
      slug.className = subtitle ? 'mcp-subtitle' : 'mcp-slug'
      title.append(slug)
    }
    return title
  }
  function renderProvider(root: HTMLElement, target: string) {
    for (const provider of new Set(data!.connectors.map((c) => c.provider))) {
      const rows = data!.connectors.filter((c) => c.provider === provider)
      const group = node('section')
      group.className = 'settings-group mcp-provider'
      const head = node('div')
      head.className = 'mcp-provider-head'
      const title = node('h3', provider)
      const count = node('span', `${rows.filter((c) => c.enabled).length}/${rows.length} on`)
      count.className = 'mcp-count'
      title.append(count)
      const controls = node('div')
      controls.className = 'mcp-actions'
      for (const enabled of [true, false]) {
        const selectable = rows.filter((c) => !c.bot)
        const control = actionButton(
          enabled ? 'All on' : 'All off',
          `${provider}-${enabled}`,
          () =>
            void act({
              action: 'group',
              provider,
              enabled,
              targets: selectable.map(({ name, fingerprint }) => ({ name, fingerprint }))
            })
        )
        control.disabled =
          busy() || !selectable.length || selectable.every((c) => c.enabled === enabled)
        controls.append(control)
      }
      head.append(title, controls)
      group.append(head)
      if (provider === 'Codex') {
        const note = node(
          'p',
          `Codex bots always load the Codex setup on ${target} directly. Enabling here makes connectors assignable in OpenMausBot.`
        )
        note.className = 'mcp-note'
        group.append(note)
      }
      for (const row of rows) {
        const section = node('div')
        section.className = 'mcp-row'
        const line = node('div')
        line.className = 'mcp-row-head'
        const actions = node('div')
        actions.className = 'mcp-actions'
        if (row.present) {
          const remove = actionButton(
            'Remove',
            `${row.name}-remove`,
            () => {
              removing = row.name
              render(`${row.name}-cancel`)
            },
            'mcp-remove-btn'
          )
          remove.setAttribute('aria-label', `Remove ${row.name} from OpenMausBot`)
          actions.append(remove)
        }
        actions.append(switchControl(row))
        line.append(titleFor(row), actions)
        section.append(line)
        if (row.enabled) {
          const access = node('div')
          access.className = 'mcp-row-bots'
          if (row.bot) access.append(node('span', 'Pinned to owning bot'))
          else {
            const audit = actionButton(
              `${row.bots.length} ${row.bots.length === 1 ? 'bot' : 'bots'}`,
              `${row.name}-access`,
              () => {
                selectedBot =
                  row.bots.find((id) => data!.bots.some((b) => b.id === id)) ?? data!.bots[0]?.id
                setTab('bot', true)
              }
            )
            audit.setAttribute('aria-label', `Review bot access for ${row.name}`)
            access.append(audit)
            if (!row.bots.length) access.append(node('span', 'No bots assigned'))
          }
          section.append(access)
        }
        if (removing === row.name) {
          const confirmation = node('div')
          confirmation.className = 'mcp-confirm'
          confirmation.append(
            node('strong', `Remove ${row.name}?`),
            node(
              'p',
              row.provider === 'OpenMausBot'
                ? 'Its saved credentials in OpenMausBot will be permanently deleted. No local source is available to restore them.'
                : 'This deletes its saved credentials and bot assignments in OpenMausBot.'
            )
          )
          const actions = node('div')
          actions.className = 'bot-menu-actions'
          actions.append(
            actionButton(
              'Cancel',
              `${row.name}-cancel`,
              () => {
                removing = undefined
                render(`${row.name}-remove`)
              },
              'bot-menu-btn'
            ),
            actionButton(
              'Remove',
              `${row.name}-confirm`,
              () => void act({ action: 'remove', name: row.name, fingerprint: row.fingerprint }),
              'bot-menu-btn danger'
            )
          )
          confirmation.append(actions)
          section.append(confirmation)
        }
        group.append(section)
      }
      root.append(group)
    }
  }
  function renderBots(root: HTMLElement) {
    if (!data!.bots.some((b) => b.id === selectedBot)) selectedBot = data!.bots[0]?.id
    const tabs = node('div')
    tabs.className = 'mcp-bot-tabs'
    tabs.setAttribute('aria-label', 'Choose bot')
    for (const bot of data!.bots) {
      const count = data!.connectors.filter((c) => c.enabled && c.bots.includes(bot.id)).length
      const choice = actionButton(`${bot.name} (${count})`, `select-${bot.id}`, () => {
        selectedBot = bot.id
        render()
      })
      choice.setAttribute('aria-pressed', String(selectedBot === bot.id))
      tabs.append(choice)
    }
    root.append(tabs)
    const bot = data!.bots.find((b) => b.id === selectedBot)
    const enabled = data!.connectors.filter((c) => c.enabled && (!c.bot || c.bot === selectedBot))
    const group = node('section')
    group.className = 'settings-group'
    group.append(node('h3', bot?.name ?? 'Bot access'))
    if (!bot) group.append(node('p', 'No visible bots on this host.'))
    else if (!enabled.length) group.append(node('p', 'No MCP connectors are enabled yet.'))
    else
      for (const row of enabled) {
        const line = node('div')
        line.className = 'mcp-row mcp-row-head'
        line.append(
          titleFor(row, true),
          row.bot ? node('span', 'Pinned to this bot') : switchControl(row, bot.id)
        )
        group.append(line)
      }
    if (!enabled.length || data!.connectors.some((c) => !c.enabled))
      group.append(
        actionButton(
          enabled.length ? 'Turn on more connectors →' : 'Turn on connectors by provider',
          'more-connectors',
          () => setTab('provider', true),
          'mcp-link'
        )
      )
    root.append(group)
  }
  function render(destination?: string) {
    const root = element('mcp-groups')
    const active = document.activeElement as HTMLElement | null
    const inside = !!active && root.contains(active)
    if (destination) focusedKey = destination
    else if (inside && active !== root) focusedKey = active?.dataset.focus
    else if (active && active !== document.body && active !== root) focusedKey = undefined
    const restoreFocus = !!destination || inside || !active || active === document.body
    const target = remote ?? 'this computer'
    element('mcp-security').textContent =
      `Credentials on ${target} are copied only for connectors you turn on. Only selected bots can use them in OpenMausBot. Provider CLI settings can give bots additional access.`
    button('mcp-refresh').disabled = busy()
    element('mcp-summary').textContent = data
      ? `${data.connectors.filter((c) => c.enabled).length} enabled · ${data.connectors.length} available on ${target}`
      : `MCP connectors unavailable on ${target}. Start OpenMausBot with this plugin, then refresh.`
    root.replaceChildren()
    if (!data) return
    const tabs = node('div')
    tabs.className = 'mcp-tabs'
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', 'Manage connector access')
    for (const next of ['provider', 'bot'] as const) {
      const control = actionButton(
        next === 'provider' ? 'Providers' : 'By Bot',
        `tab-${next}`,
        () => setTab(next, true)
      )
      control.id = `mcp-tab-${next}`
      control.setAttribute('role', 'tab')
      control.setAttribute('aria-selected', String(tab === next))
      control.setAttribute('aria-controls', 'mcp-tab-content')
      control.tabIndex = tab === next ? 0 : -1
      control.addEventListener('keydown', (event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          setTab(
            event.key === 'Home'
              ? 'provider'
              : event.key === 'End'
                ? 'bot'
                : tab === 'bot'
                  ? 'provider'
                  : 'bot',
            true
          )
        }
      })
      tabs.append(control)
    }
    root.append(tabs)
    const content = node('div')
    content.id = 'mcp-tab-content'
    content.setAttribute('role', 'tabpanel')
    content.setAttribute('aria-labelledby', `mcp-tab-${tab}`)
    if (!data.connectors.length && tab === 'provider')
      content.append(node('p', `No MCP connectors found on ${target}.`))
    if (tab === 'provider') renderProvider(content, target)
    else renderBots(content)
    root.append(content)
    if (restoreFocus && focusedKey) {
      const focus = Array.from(root.querySelectorAll<HTMLElement>('[data-focus]')).find(
        (el) => el.dataset.focus === focusedKey
      )
      if (focus && !(focus as HTMLButtonElement).disabled) focus.focus()
      else if (busy()) {
        root.tabIndex = -1
        root.focus()
      } else button('mcp-refresh').focus()
    }
  }
  async function refresh() {
    if (busy()) return
    const current = ++generation
    pendingGeneration = current
    render()
    try {
      const next = await frame.plugin.request('mcp.list', {})
      if (current !== generation) return
      data = next
      removing = undefined
      message('')
    } catch (error) {
      if (current !== generation) return
      data = undefined
      message(error instanceof Error ? error.message : 'Could not load MCP connectors.')
    } finally {
      if (current === generation) {
        pendingGeneration = undefined
        render()
      }
    }
  }
  async function act(input: ConnectorAction) {
    if (busy()) return
    focusedKey = (document.activeElement as HTMLElement | null)?.dataset?.focus ?? focusedKey
    const current = generation
    pendingGeneration = current
    message('Saving…')
    render()
    try {
      const next = await frame.plugin.request('mcp.act', input)
      if (current !== generation) return
      data = next
      if (input.action === 'remove') {
        removing = undefined
        focusedKey = `${input.name}-toggle`
      }
      message('Saved.')
    } catch (error) {
      if (current !== generation) return
      const problem = error instanceof Error ? error.message : 'Could not save. Refresh and retry.'
      // Reconcile partial success before offering another mutation.
      try {
        const next = await frame.plugin.request('mcp.list', {})
        if (current === generation) data = next
      } catch {
        if (current === generation) data = undefined
      }
      if (current !== generation) return
      message(problem)
    } finally {
      if (current === generation) {
        pendingGeneration = undefined
        render()
      }
    }
  }
  function open(options?: { tab?: 'provider' | 'bot'; botId?: string; back?: () => void }) {
    returnTo = options?.back
    button('mcp-back').setAttribute('aria-label', returnTo ? 'Back to chat' : 'Back to Settings')
    tab = options?.tab ?? 'provider'
    selectedBot = options?.botId
    element('main-view').hidden = true
    element('settings-view').hidden = true
    element('mcp-view').hidden = false
    button('mcp-back').focus()
    render()
    void refresh()
  }
  button('mcp-manage').addEventListener('click', () => open())
  button('mcp-back').addEventListener('click', () => {
    element('mcp-view').hidden = true
    if (returnTo) {
      const back = returnTo
      returnTo = undefined
      back()
      return
    }
    element('settings-view').hidden = false
    button('mcp-manage').focus()
  })
  button('mcp-refresh').addEventListener('click', () => void refresh())
  return {
    refresh,
    open,
    hostChanged(id: string, name?: string) {
      if (id === hostId) return
      returnTo = undefined
      hostId = id
      ++generation
      remote = name
      data = undefined
      selectedBot = undefined
      tab = 'provider'
      message('')
      removing = undefined
      focusedKey = undefined
      if (!element('mcp-view').hidden) element('settings-view').hidden = false
      element('mcp-view').hidden = true
      render()
    }
  }
}
