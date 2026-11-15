export type Bot = {
  id: string
  name: string
  title: string
  main: boolean
  state: 'working' | 'waiting' | 'idle'
  unread: boolean
  modelLabel: string
  activeTaskId?: string
}

export function mainFirst<T extends { main: boolean }>(bots: T[]): T[] {
  return [...bots.filter((bot) => bot.main), ...bots.filter((bot) => !bot.main)]
}

export function stateLabel(state: Bot['state']): string {
  return state === 'working' ? 'Working' : state === 'waiting' ? 'Waiting' : ''
}
