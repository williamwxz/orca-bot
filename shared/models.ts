export type Models = {
  groups: { instanceId: string; label: string; models: { id: string; label: string }[] }[]
}
export function validInstance(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value)
}
export function validModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}
export function validateModelSelection(instanceId: unknown, model: unknown): void {
  if (!validInstance(instanceId) || !validModel(model))
    throw new Error('Choose a valid provider and model.')
}
export function modelLabel(id: string): string {
  return id.replace(/^[^/]+\//, '').replace(/^gpt(?=-|$)/i, 'GPT')
}
