import { defaultHttpDeps } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { validInstance, validModel, modelLabel } from '../shared/models.ts'
import type { Models } from '../shared/models.ts'

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' ? (v as Record<string, any>) : {}
const tiers: Record<string, number> = {
  claudeAgent: 0,
  codex: 1,
  geminiAgent: 2,
  antigravityAgent: 2,
  grokAgent: 3,
  grok: 3
}
const names: Record<string, string> = {
  claudeAgent: 'Claude',
  codex: 'Codex',
  geminiAgent: 'Gemini',
  antigravityAgent: 'Antigravity',
  grokAgent: 'Grok',
  grok: 'Grok'
}
const label = (value: unknown, fallback: string): string =>
  typeof value === 'string' &&
  value.trim() &&
  !/[\u0000-\u001f\u007f]|:\/\/|^(?:\/|~\/|[A-Za-z]:\\)/.test(value.trim())
    ? value.trim().slice(0, 200)
    : fallback

export async function listModels(
  port: number,
  deps: HttpDeps = defaultHttpDeps()
): Promise<Models> {
  try {
    const reply = object(await deps.request(port, '/api/instances'))
    if (!Array.isArray(reply.instances)) throw new Error('Invalid instances')
    const ready = reply.instances
      .map(object)
      .filter(
        (i) =>
          validInstance(i.instanceId) &&
          i.enabled !== false &&
          i.snapshot?.state === 'available' &&
          !i.policy?.reason &&
          !(i.access !== 'custom' && i.snapshot?.authenticated === false)
      )
    const tier = (i: Record<string, any>) =>
      i.snapshot?.freeFallback === true ? 5 : i.access === 'custom' ? 4 : (tiers[i.driverKind] ?? 4)
    ready.sort((a, b) => tier(a) - tier(b))
    const counts = new Map<string, number>()
    const groups = ready.map((i) => {
      const title = label(i.displayName, names[i.driverKind] ?? 'AI provider')
      counts.set(title, (counts.get(title) ?? 0) + 1)
      const options: Record<string, any>[] = Array.isArray(i.models?.options)
        ? i.models.options.map(object)
        : []
      const blocked = new Set(
        options
          .filter((o) => o.orgBlocked || o.needsCliUpdate)
          .map((o) => (typeof o.id === 'string' ? o.id.trim() : ''))
      )
      const models: { id: string; label: string }[] = []
      for (const o of options) {
        if (
          !validModel(o.id) ||
          blocked.has(o.id.trim()) ||
          models.some((m) => m.id === o.id.trim())
        )
          continue
        const id = o.id.trim()
        models.push({ id, label: label(o.label, modelLabel(id)) })
      }
      const fallback = i.models?.default
      if (
        validModel(fallback) &&
        !blocked.has(fallback.trim()) &&
        !models.some((m) => m.id === fallback.trim())
      )
        models.unshift({ id: fallback.trim(), label: modelLabel(fallback.trim()) })
      return { instanceId: i.instanceId as string, label: title, models }
    })
    const seen = new Map<string, number>()
    return {
      groups: groups.map((g) => {
        const n = (seen.get(g.label) ?? 0) + 1
        seen.set(g.label, n)
        return { ...g, label: counts.get(g.label)! > 1 ? `${g.label} (${n})` : g.label }
      })
    }
  } catch {
    throw new Error('Could not load models. Check that OpenMausBot is running.')
  }
}
