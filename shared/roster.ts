export type Bot = {
  id: string
  name: string
  title: string
  main: boolean
  state: 'working' | 'waiting' | 'idle'
  unread: boolean
  connectorCount?: number
  modelLabel: string
  model?: string
  backendLabel?: string
  /** Where the bot works (its "backend"); undefined means Auto. */
  computer?: Computer
  avatar?: string
  addable?: boolean
  activeTaskId?: string
  pinned?: boolean
  section?: string
  defaultBot?: boolean
  knownSections?: string[]
}

export type GroupRename = { section: string; name: string }

export const COMPUTERS = ['cloud', 'vm', 'local', 'browser', 'off'] as const
export type Computer = (typeof COMPUTERS)[number]
/** OpenMausBot's own names and one-line descriptions for where a bot works. */
export const COMPUTER_CHOICES: { value: Computer | 'auto'; label: string; description: string }[] = [
  { value: 'auto', label: 'Auto', description: 'Choose automatically' },
  { value: 'cloud', label: 'Cloud desktop', description: 'A desktop in the cloud' },
  { value: 'vm', label: 'Private desktop', description: "Sandboxed, can't see your files" },
  { value: 'local', label: 'This computer', description: 'Your files and apps' },
  { value: 'browser', label: 'Browser', description: 'Only websites' },
  { value: 'off', label: 'Off', description: 'No computer access' }
]
/** Real state of each place a bot can work, as far as the server reports it. */
export type ComputerState = 'ready' | 'stopped' | 'setup' | 'repair'
export type ComputerStatus = {
  /** Where the bot's open conversation is working right now. */
  now?: Exclude<Computer, 'off'>
  cloud?: ComputerState
  vm?: ComputerState
  browser?: ComputerState
}
/** A short status for a tile, or undefined when the plain description says enough. */
export function computerNote(value: Computer | 'auto', status: ComputerStatus | undefined): string | undefined {
  const state = value === 'cloud' ? status?.cloud : value === 'vm' ? status?.vm : value === 'browser' ? status?.browser : undefined
  if (state === 'setup') return 'Not set up yet'
  if (state === 'repair') return 'Needs repair'
  if (state === 'stopped') return 'Stopped; starts when needed'
  return undefined
}
/** One line under the grid about the chosen place, in OpenMausBot's manner. */
export function computerHint(value: Computer | 'auto', status: ComputerStatus | undefined): string {
  const state = value === 'cloud' ? status?.cloud : value === 'vm' ? status?.vm : value === 'browser' ? status?.browser : undefined
  if (state === 'setup' || state === 'repair')
    return `${computerLabel(value === 'auto' ? undefined : value)} ${state === 'setup' ? 'is not set up yet' : 'needs repair'}. Do that in native OpenMausBot; until then this bot works without it.`
  switch (value) {
    case 'auto': return 'Uses a computer that is already set up and ready. It never sets one up or takes over this computer on its own.'
    case 'cloud': return 'A remote desktop that stays available while this computer is off.'
    case 'vm': return 'A separate Linux desktop in a container on this computer. It cannot see your files.'
    case 'local': return 'Works with the real apps and files on this computer. You approve what it may do.'
    case 'browser': return 'The built-in browser only: websites, no desktop.'
    default: return 'This bot works without a computer.'
  }
}
export const computerLabel = (computer: Computer | undefined): string =>
  COMPUTER_CHOICES.find((c) => c.value === (computer ?? 'auto'))!.label

export function validateGroupName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 60) throw new Error('Enter a group name between 1 and 60 characters.')
  if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('Group names cannot contain control characters.')
  return name
}

export type BotAction =
  | { botId: string; action: 'model'; instanceId: string; model: string }
  | { botId: string; action: 'pin'; pinned: boolean }
  | { botId: string; action: 'rename'; name: string }
  | { botId: string; action: 'group'; section: string | null }
  | { botId: string; action: 'computer'; computer: Computer | 'auto' }
  | { botId: string; action: 'delete' }

export type RosterGroup = {
  title: string
  bots: Bot[]
  kind: DropTarget['kind']
}

/** Where a dragged bot can land: the Pinned group, a named group, or no group. */
export type DropTarget = { kind: 'pinned' } | { kind: 'section'; name: string } | { kind: 'rest' }

export function groupTarget(group: RosterGroup): DropTarget {
  return group.kind === 'section' ? { kind: 'section', name: group.title } : { kind: group.kind }
}

/** The actions that move a bot into a target group; empty when it is already there. */
export function dropActions(bot: Bot, target: DropTarget): BotAction[] {
  if (target.kind === 'pinned') return bot.pinned ? [] : [{ botId: bot.id, action: 'pin', pinned: true }]
  const actions: BotAction[] = bot.pinned ? [{ botId: bot.id, action: 'pin', pinned: false }] : []
  const section = target.kind === 'section' ? target.name : null
  if ((bot.section ?? null) !== section) actions.push({ botId: bot.id, action: 'group', section })
  return actions
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
  const builtInTitle = (title: string) => {
    let unique = title
    while (sections.includes(unique)) unique += ' (automatic)'
    return unique
  }
  if (pinned.length) groups.push({ title: builtInTitle('Pinned'), bots: pinned, kind: 'pinned' })
  for (const section of sections) {
    const members = visible.filter((bot) => !bot.pinned && bot.section === section)
    if (members.length) groups.push({ title: section, bots: members, kind: 'section' })
  }
  const rest = visible.filter((bot) => !bot.pinned && !bot.section && !bot.main)
  if (rest.length) groups.push({ title: builtInTitle('Bots'), bots: rest, kind: 'rest' })
  return { ungroupedTop, groups, addable, sections }
}

/** "Claude · claude-sonnet-5": the backend a bot runs on, then its model. */
export function modelText(bot: Pick<Bot, 'modelLabel' | 'backendLabel'>): string {
  return bot.backendLabel && bot.modelLabel ? `${bot.backendLabel} · ${bot.modelLabel}` : bot.modelLabel
}

export function stateLabel(state: Bot['state']): string {
  return state === 'working' ? 'Working' : state === 'waiting' ? 'Waiting' : ''
}

export type BotCreate = { name?: string; section?: string }
export type BotCreated = { botId: string; name: string; section?: string }

export function validateBotCreate(value: unknown): BotCreate {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid new bot details.')
  const { name, section } = value as BotCreate
  if (name !== undefined && (typeof name !== 'string' || !name.trim() ||
      name.trim().length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)))
    throw new Error('Enter a single-line bot name between 1 and 80 characters.')
  return { ...(name !== undefined && { name: name.trim() }),
    ...(section !== undefined && { section: validateGroupName(section) }) }
}
