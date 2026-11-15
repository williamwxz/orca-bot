export type ModelGroup = {
  instanceId: string
  label: string
  available: boolean
  defaultModel: string
  options: { value: string; label: string }[]
}

export function parseModels(value: unknown): ModelGroup[] {
  const instances = (value as { instances?: unknown })?.instances
  if (!Array.isArray(instances)) throw new Error('Invalid models')
  return instances.map((item) => {
    if (typeof item?.instanceId !== 'string' || typeof item.displayName !== 'string' || !Array.isArray(item.models?.options)) throw new Error('Invalid models')
    return {
      instanceId: item.instanceId,
      label: item.displayName,
      available: item.snapshot?.state === 'available',
      defaultModel: `${item.instanceId}/${item.models.default}`,
      options: item.models.options.map((option: { id: string; label: string }) => {
        if (typeof option.id !== 'string' || typeof option.label !== 'string') throw new Error('Invalid model')
        return { value: `${item.instanceId}/${option.id}`, label: option.label }
      })
    }
  })
}

export function availableModels(groups: ModelGroup[]): ModelGroup[] {
  const rank = (id: string) => id === 'claude' ? 0 : id === 'codex' ? 1 : 2
  return groups.filter((group) => group.available && group.options.length).sort((a, b) => rank(a.instanceId) - rank(b.instanceId))
}

export function defaultModel(groups: ModelGroup[]): string {
  const first = availableModels(groups)[0]
  return first?.options.find((option) => option.value === first.defaultModel)?.value ?? first?.options[0]?.value ?? ''
}

export function modelLabel(groups: ModelGroup[], value: string): string {
  return groups.flatMap((group) => group.options).find((option) => option.value === value)?.label ?? 'Unknown model'
}

export function requireModel(groups: ModelGroup[], value: unknown): string {
  if (typeof value !== 'string' || !availableModels(groups).some((group) => group.options.some((option) => option.value === value))) throw new Error('Choose an available model.')
  return value
}
