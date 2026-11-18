import { connectorIcon } from './connector-icon.ts'
import type { Bot } from '../shared/roster.ts'
import type { Models } from '../shared/models.ts'
import type { Connectors } from '../worker/mcp-connectors.ts'
import type { FrameApi } from './chat-view.ts'

export type CapabilityHooks = {
  connectorCountChanged?(botId: string, count: number): void
  busyChanged?(): void
  changed(): Promise<void>
  manage(botId: string, enabled: boolean): void
  hostGeneration?(): number
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
    dismissed()
    if (restore) trigger?.focus()
  }
  function position() {
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
  async function open(kind: 'model' | 'connectors', bot: Bot, from: HTMLElement) {
    close()
    active = true
    currentBot = bot
    trigger = from
    const token = revision
    const host = hooks.hostGeneration?.()
    const current = () => active && token === revision && host === hooks.hostGeneration?.()
    root.hidden = false
    root.setAttribute('role', 'menu')
    root.setAttribute('aria-label', `${kind === 'model' ? 'Model' : 'Connectors'} for ${bot.name}`)
    let models: Models | undefined
    let connectors: Connectors | undefined
    let problem = ''
    let focusKey: string | undefined
    const draw = () => {
      if (!current()) return
      const wasInside = root.contains(document.activeElement)
      if (connectors)
        hooks.connectorCountChanged?.(
          bot.id,
          connectors.connectors.filter(
            (c) => c.enabled && (!c.bot || c.bot === bot.id) && c.bots.includes(bot.id)
          ).length
        )
      hooks.busyChanged?.()
      controls = []
      const children: HTMLElement[] = [
        node(
          'div',
          `${kind === 'model' ? 'Model' : 'Connectors'} for ${bot.name}`,
          'bot-menu-title'
        )
      ]
      const wait = currentBot?.state === 'working'
      if (problem) children.push(node('p', problem, 'bot-menu-note'))
      if (kind === 'model') {
        const selected = currentBot?.model
        const available = models?.groups.some((g) =>
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
        else if (models && !models.groups.some((g) => g.models.length))
          children.push(
            node(
              'p',
              'No ready models. Sign in to a provider in the Bot Dashboard.',
              'bot-menu-note'
            )
          )
        for (const group of models?.groups ?? []) {
          if (!group.models.length) continue
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
                  if (current()) currentBot = { ...currentBot!, model: id, modelLabel: model.label }
                }),
              id === selected
            )
            choice.dataset.key = id
            choice.disabled ||= !!wait
            children.push(choice)
          }
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
      children.push(
        node('div', '', 'bot-menu-sep'),
        item('Cancel', () => close(true))
      )
      root.replaceChildren(...children)
      position()
      if (wasInside) {
        const focus = controls.find((c) => c.dataset.key === focusKey && !c.disabled)
        if (focus) focus.focus()
        else {
          root.tabIndex = -1
          root.focus()
        }
      }
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
        await hooks.changed()
      } catch (error) {
        if (!current()) return
        problem = error instanceof Error ? error.message : 'Could not save. Refresh and try again.'
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
          draw()
        }
      }
    }
    redraw = draw
    draw()
    root.tabIndex = -1
    root.focus()
    try {
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
