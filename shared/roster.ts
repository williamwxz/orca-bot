export type Bot = {
  id: string
  name: string
  title: string
  main: boolean
  state: 'working' | 'waiting' | 'idle'
  unread: boolean
  modelLabel: string
  model?: string
  avatar?: string
  addable?: boolean
  activeTaskId?: string
  pinned?: boolean
  section?: string
  defaultBot?: boolean
  knownSections?: string[]
}

export type BotAction =
  | { botId: string; action: 'pin'; pinned: boolean }
  | { botId: string; action: 'rename'; name: string }
  | { botId: string; action: 'group'; section: string | null }
  | { botId: string; action: 'delete' }

export type RosterGroup = {
  title: string
  bots: Bot[]
}

export type GroupedRoster = {
  ungroupedTop: Bot[]
  groups: RosterGroup[]
  addable: Bot[]
  sections: string[]
}

export function mainFirst<T extends { main: boolean }>(bots: T[]): T[] {
  return [...bots.filter((bot) => bot.main), ...bots.filter((bot) => !bot.main)]
}

export function groupRoster(bots: Bot[]): GroupedRoster {
  const addable = bots.filter((bot) => bot.addable)
  const visible = mainFirst(bots.filter((bot) => !bot.addable))
  const seen = new Set<string>()
  const sections: string[] = []
  for (const name of [
    ...bots.flatMap((bot) => bot.knownSections ?? []),
    ...visible.map((bot) => bot.section ?? '')
  ]) {
    const trimmed = name.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      sections.push(trimmed)
    }
  }
  const hasGroups = visible.some((bot) => bot.pinned || Boolean(bot.section))
  if (!hasGroups) {
    return { ungroupedTop: visible, groups: [], addable, sections }
  }
  const ungroupedTop = visible.filter((bot) => bot.main && !bot.pinned && !bot.section)
  const groups: RosterGroup[] = []
  const pinned = visible.filter((bot) => bot.pinned)
  if (pinned.length) groups.push({ title: 'Pinned', bots: pinned })
  for (const section of sections) {
    const members = visible.filter((bot) => !bot.pinned && bot.section === section)
    if (members.length) groups.push({ title: section, bots: members })
  }
  const rest = visible.filter((bot) => !bot.pinned && !bot.section && !bot.main)
  if (rest.length) groups.push({ title: 'Bots', bots: rest })
  return { ungroupedTop, groups, addable, sections }
}

export function stateLabel(state: Bot['state']): string {
  return state === 'working' ? 'Working' : state === 'waiting' ? 'Waiting' : ''
}
