import { connectorIcon } from './connector-icon.ts'
import type { Bot } from '../shared/roster.ts'
import { COMPUTER_CHOICES, computerHint, computerLabel, computerNote } from '../shared/roster.ts'
import type { ComputerStatus, DesktopAction } from '../shared/roster.ts'
import { desktopBlock } from './desktop-setup.ts'
import type { Models } from '../shared/models.ts'
import type { Connectors } from '../worker/mcp-connectors.ts'
import type { FrameApi } from './chat-view.ts'

export type CapabilityHooks = {
  connectorCountChanged?(botId: string, count: number): void
  notify?(message: string): void
  busyChanged?(): void
  changed(): Promise<void>
  manage(botId: string, enabled: boolean): void
  hostGeneration?(): number
  /** True in a narrow panel: the picker slides in from the right instead of dropping down. */
  sheet?(): boolean
  /** Opens the bot in OpenMausBot's own page, where computers are set up and repaired. */
  openNative?(botId: string): void
  nativeAvailable?(): boolean
}
/** Missed status checks in a row (about a minute) before a step's outcome is called unconfirmed. */
export const FOLLOW_MISSES = 24
const stroke = (paths: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const COMPUTER_ICONS: Record<string, string> = {
  auto: stroke('<path d="M8 1.75 9.4 6.1l4.35 1.4-4.35 1.4L8 13.25 6.6 8.9 2.25 7.5 6.6 6.1Z"/>'),
  cloud: stroke('<path d="M4.5 12.5a3 3 0 0 1-.4-5.97 4 4 0 0 1 7.75.97A2.5 2.5 0 0 1 11.5 12.5Z"/>'),
  vm: stroke('<path d="M8 1.75 13.5 4.75v6.5L8 14.25 2.5 11.25v-6.5Z"/><path d="M2.5 4.75 8 7.75l5.5-3M8 7.75v6.5"/>'),
  local: stroke('<rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 13.75h5M8 11v2.75"/>'),
  browser: stroke('<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c2 2 2 10.5 0 12.5M8 1.75c-2 2-2 10.5 0 12.5"/>'),
  off: stroke('<path d="M8 2v5.5"/><path d="M4.4 4.4a5.25 5.25 0 1 0 7.2 0"/>')
}
export function createCapabilityPicker(
  root: HTMLElement,
  frame: FrameApi,
  hooks: CapabilityHooks,
  dismissed: () => void = () => {}
) {
  if (!root.className.includes('capability-menu')) root.className += ' capability-menu'
  let revision = 0
  let active = false
  let trigger: HTMLElement | undefined
  let currentBot: Bot | undefined
  let controls: HTMLButtonElement[] = []
  let busy = false
  let redraw: (() => void) | undefined
  let sheet = false
  const setSheet = (on: boolean) => {
    sheet = on
    root.className = root.className.replace(/ sheet\b/g, '') + (on ? ' sheet' : '')
  }
  const node = (tag: string, text = '', cls = '') => {
    const el = document.createElement(tag)
    el.textContent = text
    el.className = cls
    return el
  }
  function close(restore = false) {
    ++revision
    if (!active) return
    active = false
    busy = false
    redraw = undefined
    root.hidden = true
    root.replaceChildren()
    setSheet(false)
    dismissed()
    if (restore) trigger?.focus()
  }
  function position() {
    if (sheet && root.style) {
      root.style.left = root.style.top = ''
      return
    }
    const rect = trigger?.getBoundingClientRect?.()
    if (!rect || !root.style) return
    const bounds = root.getBoundingClientRect()
    root.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`
    root.style.top = `${Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - bounds.height - 8))}px`
  }
  function item(text: string, click: () => void, checked?: boolean) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'bot-menu-item'
    el.textContent = text
    el.disabled = busy
    el.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox')
    if (checked !== undefined) el.setAttribute('aria-checked', String(checked))
    el.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!busy) click()
    })
    controls.push(el)
    return el
  }
  /** For models, start on the backend list or straight on the current backend's models. */
  async function open(
    kind: 'model' | 'connectors' | 'computer',
    bot: Bot,
    from: HTMLElement,
    start: 'backends' | 'models' = 'backends'
  ) {
    close()
    active = true
    currentBot = bot
    trigger = from
    const token = revision
    const host = hooks.hostGeneration?.()
    const current = () => active && token === revision && host === hooks.hostGeneration?.()
    // Backend is always a panel from the right, as OpenMausBot's Computer panel is.
    setSheet(kind === 'computer' || (kind === 'model' && !!hooks.sheet?.()))
    root.hidden = false
    root.setAttribute('role', 'menu')
    const heading = kind === 'model' ? 'Model' : kind === 'computer' ? 'Backend' : 'Connectors'
    root.setAttribute('aria-label', `${heading} for ${bot.name}`)
    let models: Models | undefined
    let connectors: Connectors | undefined
    let problem = ''
    let focusKey: string | undefined
    let status: ComputerStatus | undefined
    let setupBusy: DesktopAction | 'check' | undefined
    let browserBusy = false
    let unconfirmed = false
    let browserPoll: ReturnType<typeof setTimeout> | undefined
    let stepPoll: ReturnType<typeof setTimeout> | undefined
    /** True when a fresh status arrived; false keeps the last one (a poll can time out). */
    const refreshStatus = async () => {
      const next = await frame.plugin.request('computer.status', { botId: bot.id }).catch(() => undefined)
      if (current() && next) status = next
      return !!next
    }
    // A step runs in the worker; the panel follows it through the status until it ends.
    // A failed or stale poll (no report of this step yet) is retried, never read as "done".
    const followStep = (id: number, misses = 0) => {
      clearTimeout(stepPoll)
      stepPoll = setTimeout(async () => {
        const fresh = await refreshStatus()
        if (!current()) return
        const step = status?.desktop?.step
        // Only a fresh report of this step counts; an old snapshot or a failed poll is a miss.
        if (fresh && step?.id === id && step.running) return followStep(id)
        if (fresh && step?.id === id) {
          setupBusy = undefined
          hooks.notify?.(step.error ?? 'Private desktop updated.')
          return draw()
        }
        if (misses + 1 < FOLLOW_MISSES) return followStep(id, misses + 1)
        // Give up honestly: drop the stale "running" and offer only a re-check.
        setupBusy = undefined
        unconfirmed = true
        if (status?.desktop?.step?.id === id) status = { ...status, desktop: { ...status.desktop, step: undefined } }
        hooks.notify?.('Could not confirm how the step ended. Check the private desktop again.')
        draw()
      }, 2500)
    }
    // A setup step or a re-check, as OpenMausBot's own setup buttons do; the panel stays open.
    const runDesktop = async (action?: DesktopAction) => {
      if (setupBusy || !current()) return
      setupBusy = action ?? 'check'
      focusKey = `desktop:${action ?? 'check'}`
      draw()
      if (!action) {
        const fresh = await refreshStatus()
        if (!current()) return
        if (fresh) unconfirmed = false
        setupBusy = undefined
        // The re-check found the step still running: follow it to the end again.
        const step = status?.desktop?.step
        if (fresh && step?.running) {
          setupBusy = step.action
          followStep(step.id)
        }
        return draw()
      }
      try {
        const { step } = await frame.plugin.request('desktop.act', { action, botId: bot.id })
        if (current()) followStep(step.id)
      } catch (error) {
        if (!current()) return
        hooks.notify?.(error instanceof Error ? error.message : 'Could not start this step.')
        setupBusy = undefined
        draw()
      }
    }
    // The browser installs on the server; its status says when it is done.
    const pollBrowser = (tries: number) => {
      clearTimeout(browserPoll)
      browserPoll = setTimeout(async () => {
        await refreshStatus()
        if (!current()) return
        if (status?.browserInstalling && tries > 0) pollBrowser(tries - 1)
        else {
          browserBusy = false
          if (status?.browser === 'ready') hooks.notify?.('The browser is ready.')
        }
        draw()
      }, 3000)
    }
    const installBrowser = async () => {
      if (browserBusy || !current()) return
      browserBusy = true
      focusKey = 'browser:install'
      draw()
      try {
        await frame.plugin.request('browser.install', {})
        if (current()) pollBrowser(60)
      } catch (error) {
        if (!current()) return
        hooks.notify?.(error instanceof Error ? error.message : 'Could not install the browser.')
        browserBusy = false
        draw()
      }
    }
    let browsing: string | undefined = start === 'models' ? bot.model?.split('/')[0] : undefined
    const draw = () => {
      if (!current()) return
      const wasInside = root.contains(document.activeElement)
      // A redraw replaces every control: remember which one had the keyboard.
      const activeKey = wasInside ? (document.activeElement as HTMLElement | null)?.dataset?.key : undefined
      if (connectors)
        hooks.connectorCountChanged?.(
          bot.id,
          connectors.connectors.filter(
            (c) => c.enabled && (!c.bot || c.bot === bot.id) && c.bots.includes(bot.id)
          ).length
        )
      hooks.busyChanged?.()
      controls = []
      const title = node(
        'div',
        `${heading} for ${bot.name}`,
        'bot-menu-title'
      )
      const children: HTMLElement[] = [title]
      if (sheet) {
        const head = node('div', '', 'sheet-head')
        const dismiss = node('button', '×', 'sheet-close') as HTMLButtonElement
        dismiss.type = 'button'
        dismiss.setAttribute('aria-label', 'Close')
        dismiss.addEventListener('click', (event) => {
          event.stopPropagation()
          close(true)
        })
        head.append(title, dismiss)
        children[0] = head
      }
      const wait = currentBot?.state === 'working'
      if (problem) children.push(node('p', problem, 'bot-menu-note'))
      if (kind === 'model') {
        const selected = currentBot?.model
        const currentBackend = selected?.split('/')[0]
        const groups = models?.groups.filter((g) => g.models.length) ?? []
        const single = groups.length === 1
        // Several providers: pick one first, then its model. One provider: its models at once.
        const shown = single ? groups[0] : groups.find((g) => g.instanceId === browsing)
        const available = groups.some((g) =>
          g.models.some((m) => `${g.instanceId}/${m.id}` === selected)
        )
        if (!available)
          children.push(
            node('p', `Current: ${currentBot?.modelLabel || 'Not selected'}`, 'bot-menu-note')
          )
        if (wait)
          children.push(
            node(
              'p',
              'Wait until this bot finishes its reply before changing models.',
              'bot-menu-note'
            )
          )
        if (!models && !problem) children.push(node('p', 'Loading models…', 'bot-menu-note'))
        else if (models && !groups.length)
          children.push(
            node(
              'p',
              'No ready models. Sign in to a provider in the Bot Dashboard.',
              'bot-menu-note'
            )
          )
        if (!shown) {
          for (const group of groups) {
            const current = group.instanceId === currentBackend
            const choice = item(
              `${current ? '✓ ' : ''}${group.label}${current && currentBot?.modelLabel ? ` · ${currentBot.modelLabel}` : ''}`,
              () => {
                browsing = group.instanceId
                focusKey = `${group.instanceId}/${group.models[0].id}`
                draw()
              },
              current
            )
            choice.setAttribute('aria-haspopup', 'menu')
            const chevron = node('span', '›', 'backend-chevron')
            chevron.setAttribute('aria-hidden', 'true')
            choice.append(chevron)
            choice.className += ' backend-choice'
            choice.dataset.key = `backend:${group.instanceId}`
            children.push(choice)
          }
        } else {
          if (!single) {
            const back = item('‹ All providers', () => {
              browsing = undefined
              focusKey = `backend:${shown.instanceId}`
              draw()
            })
            back.dataset.key = 'backends'
            children.push(back)
          }
          const group = shown
          children.push(node('div', group.label, 'bot-menu-title capability-group'))
          for (const model of group.models) {
            const id = `${group.instanceId}/${model.id}`
            const choice = item(
              `${id === selected ? '✓ ' : ''}${model.label}`,
              () =>
                void mutate(id, async () => {
                  if (currentBot?.state === 'working')
                    throw new Error(
                      'Wait until this bot finishes its reply before changing models.'
                    )
                  await frame.plugin.request('bots.act', {
                    botId: bot.id,
                    action: 'model',
                    instanceId: group.instanceId,
                    model: model.id
                  })
                  if (current())
                    currentBot = {
                      ...currentBot!,
                      model: id,
                      modelLabel: model.label,
                      backendLabel: group.label
                    }
                }),
              id === selected
            )
            choice.dataset.key = id
            choice.disabled ||= !!wait
            children.push(choice)
          }
        }
      } else if (kind === 'computer') {
        // The same parts as OpenMausBot's Computer panel: the bot's screen, then "Works on".
        const selected = currentBot?.computer ?? 'auto'
        const screen = node('div', '', 'computer-screen')
        const place = selected === 'off' ? 'off' : (status?.now ?? selected)
        const glyph = node('span', '', 'computer-screen-icon')
        glyph.innerHTML = COMPUTER_ICONS[place === 'auto' ? 'local' : place]
        screen.append(
          glyph,
          node(
            'span',
            selected === 'off'
              ? "This bot's computer is off"
              : status?.now
                ? `Right now: ${computerLabel(status.now)}`
                : selected === 'auto'
                  ? 'Not using a computer right now'
                  : `Set to ${computerLabel(selected)}`
          )
        )
        const trouble = selected === 'off' ? undefined : computerNote(status?.now ?? selected, status)
        if (trouble) screen.append(node('small', trouble))
        const label = node('div', `${bot.name}'s screen`, 'computer-section')
        const works = node('div', '', 'computer-card')
        works.append(
          node('div', 'Works on', 'computer-card-title'),
          node('p', 'Choose where this bot can use a computer.', 'bot-menu-note')
        )
        const grid = node('div', '', 'works-on')
        for (const choice of COMPUTER_CHOICES) {
          const chosen = choice.value === selected
          const flagged = computerNote(choice.value, status)
          const button = item(
            '',
            () =>
              void mutate(choice.value, async () => {
                await frame.plugin.request('bots.act', {
                  botId: bot.id,
                  action: 'computer',
                  computer: choice.value
                })
                if (current())
                  currentBot = {
                    ...currentBot!,
                    computer: choice.value === 'auto' ? undefined : choice.value
                  }
              }),
            chosen
          )
          const icon = node('span', '', 'works-icon')
          icon.innerHTML = chosen ? stroke('<path d="m3.5 8.5 3 3 6-7"/>') : COMPUTER_ICONS[choice.value]
          const text = node('span', '', 'works-text')
          text.append(node('strong', choice.label), node('small', flagged ?? choice.description))
          button.replaceChildren(icon, text)
          button.className = `bot-menu-item works-tile${flagged ? ' flagged' : ''}`
          button.setAttribute('aria-label', `${choice.label}: ${flagged ?? choice.description}`)
          button.dataset.key = choice.value
          grid.append(button)
        }
        works.append(grid, node('p', computerHint(selected, status), 'computer-hint'))
        children.push(label, screen, works)
        // The chosen place's setup, as OpenMausBot shows it under "Works on".
        const native = hooks.openNative && hooks.nativeAvailable?.() !== false
        if (selected === 'vm' && status?.desktop) {
          const card = node('div', '', 'computer-card')
          card.append(node('div', 'Private desktop', 'computer-card-title'))
          const block = desktopBlock(status.desktop, {
            perBot: status.desktop.mode === 'per-bot',
            busy: setupBusy,
            unconfirmed,
            run: (action) => void runDesktop(action)
          })
          for (const control of block.querySelectorAll?.('button') ?? []) controls.push(control as HTMLButtonElement)
          card.append(block)
          children.push(card)
        } else if (selected === 'browser' && (status?.browser === 'setup' || status?.browserInstalling)) {
          const card = node('div', '', 'computer-card')
          const installing = browserBusy || !!status?.browserInstalling
          card.append(
            node('div', 'Built-in browser', 'computer-card-title'),
            node(
              'p',
              installing
                ? 'Installing the browser on the bot host. This can take a minute.'
                : 'The browser this bot uses for websites is not installed yet.',
              'bot-menu-note'
            )
          )
          const install = node('button', installing ? 'Installing…' : 'Turn on the browser', 'bot-menu-btn primary desktop-action') as HTMLButtonElement
          install.type = 'button'
          install.disabled = installing
          install.dataset.key = 'browser:install'
          install.addEventListener('click', (event) => {
            event.stopPropagation()
            void installBrowser()
          })
          controls.push(install)
          card.append(install)
          children.push(card)
        }
        if (native && (selected === 'cloud' || selected === 'local')) {
          const link = item(
            selected === 'cloud' ? 'Connect a cloud desktop in native OpenMausBot' : 'Allow this computer in native OpenMausBot',
            () => {
              close(false)
              hooks.openNative!(bot.id)
            }
          )
          link.className += ' computer-native'
          const chevron = node('span', '›', 'backend-chevron')
          chevron.setAttribute('aria-hidden', 'true')
          link.append(chevron)
          link.dataset.key = 'native'
          children.push(link)
        }
      } else {
        const rows =
          connectors?.connectors.filter((c) => c.enabled && (!c.bot || c.bot === bot.id)) ?? []
        if (!connectors && !problem)
          children.push(node('p', 'Loading connectors…', 'bot-menu-note'))
        else if (connectors && !rows.length)
          children.push(node('p', 'No MCP connectors are turned on yet.', 'bot-menu-note'))
        for (const row of rows) {
          const allowed = row.bots.includes(bot.id)
          const choice = item(
            `${row.rawName} · ${row.provider}${row.bot ? ' · Pinned to this bot' : ''}`,
            () =>
              void mutate(row.name, async () => {
                const next = await frame.plugin.request('mcp.act', {
                  action: 'assign',
                  name: row.name,
                  fingerprint: row.fingerprint,
                  bots: allowed ? row.bots.filter((id) => id !== bot.id) : [...row.bots, bot.id]
                })
                if (current()) connectors = next
              }),
            allowed
          )
          const label = node('span', choice.textContent ?? '', 'mcp-choice-label')
          choice.replaceChildren(connectorIcon(row, true), label)
          if (allowed) {
            const check = node('span', '✓', 'mcp-choice-check')
            check.setAttribute('aria-hidden', 'true')
            choice.append(check)
          }
          choice.className += ' mcp-choice'
          choice.dataset.key = row.name
          choice.disabled ||= !!row.bot
          children.push(choice)
        }
        children.push(
          node('div', '', 'bot-menu-sep'),
          item('Manage connectors…', () => {
            const enabled = !!connectors?.connectors.some((c) => c.enabled)
            close(false)
            hooks.manage(bot.id, enabled)
          })
        )
      }
      root.replaceChildren(...children)
      position()
      if (wasInside) {
        const enabled = (key: string | undefined) =>
          key === undefined ? undefined : controls.find((c) => c.dataset.key === key && !c.disabled)
        const focus = enabled(focusKey) ?? enabled(activeKey)
        if (focus) focus.focus()
        else {
          root.tabIndex = -1
          root.focus()
        }
      }
      // A requested focus applies to this draw only; later redraws follow the keyboard.
      focusKey = undefined
    }
    async function mutate(key: string, operation: () => Promise<void>) {
      if (!current() || busy) return
      busy = true
      focusKey = key
      problem = ''
      draw()
      try {
        await operation()
        if (!current()) return
        hooks.notify?.(
          kind === 'model' ? 'Model updated.' : kind === 'computer' ? 'Backend updated.' : 'Connector access updated.'
        )
        await hooks.changed()
      } catch (error) {
        if (!current()) return
        problem = error instanceof Error ? error.message : 'Could not save. Refresh and try again.'
        if (hooks.notify) { hooks.notify(problem); problem = '' }
        if (kind === 'connectors') {
          try {
            const next = await frame.plugin.request('mcp.list', {})
            if (current()) connectors = next
          } catch {
            connectors = undefined
          }
        }
      } finally {
        if (current()) {
          busy = false
          focusKey = key
          draw()
        }
      }
    }
    redraw = draw
    draw()
    root.tabIndex = -1
    root.focus()
    try {
      if (kind === 'computer') {
        if (root.contains(document.activeElement))
          controls.find((c) => c.dataset.key === (currentBot?.computer ?? 'auto'))?.focus()
        // Status is a bonus: without it the tiles keep their plain descriptions.
        status = await frame.plugin.request('computer.status', { botId: bot.id }).catch(() => undefined)
        if (!current() || !status) return
        // Reopened while a step or the browser install is still going: keep following it.
        // Both can be under way at once on one host: follow each on its own.
        const step = status.desktop?.step
        if (step?.running) {
          setupBusy = step.action
          followStep(step.id)
        }
        if (status.browserInstalling) {
          browserBusy = true
          pollBrowser(60)
        }
        draw()
        return
      }
      if (kind === 'model') models = await frame.plugin.request('models.list', {})
      else connectors = await frame.plugin.request('mcp.list', {})
      if (!current()) return
      draw()
      if (root.contains(document.activeElement)) controls.find((c) => !c.disabled)?.focus()
    } catch (error) {
      if (!current()) return
      problem = error instanceof Error ? error.message : 'Could not load capabilities.'
      draw()
    }
  }
  document.addEventListener('click', (event) => {
    if (active && !root.contains(event.target as Node) && !trigger?.contains(event.target as Node))
      close(false)
  })
  document.addEventListener('keydown', (event) => {
    if (!active) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const available = controls.filter((c) => !c.disabled)
      if (!available.length) return
      event.preventDefault()
      const index = available.indexOf(document.activeElement as HTMLButtonElement)
      available[
        (index + (event.key === 'ArrowDown' ? 1 : available.length - 1)) % available.length
      ].focus()
    }
  })
  window.addEventListener('blur', () => close(false))
  window.addEventListener('resize', () => close(false))
  return {
    open,
    close,
    update(bot: Bot) {
      if (active && bot.id === currentBot?.id) {
        currentBot = bot
        redraw?.()
      }
    },
    switching: () => busy
  }
}
