import { defaultHttpDeps, HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { validBotId } from './omb-open.ts'
import { MAX_MEMORY_TEXT, MAX_SKILLS, SKILL_NAME } from '../shared/learning.ts'
import type { Learning, LearningSettings, Memory, Skill, SkillFrom } from '../shared/learning.ts'

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/**
 * Where a skill comes from, as a label. The source path itself never leaves the worker. A skill the
 * engine loads by itself is named by its folder, or else by the bot's engine (`engine`, the
 * OpenMausBot instance ID): a Claude bot's own folder may be any Claude profile.
 */
export function skillFrom(s: Record<string, any>, engine = ''): SkillFrom {
  const source = typeof s.source === 'string' ? s.source : ''
  // OpenMausBot's origin is authoritative: a skill moved to the library keeps its learn: or package: source.
  if (s.origin === 'library') return 'library'
  if (s.origin === 'project') return 'project'
  if (source.startsWith('learn:')) return 'learned'
  if (source.startsWith('package:')) return 'package'
  if (s.origin === 'imported') return 'computer'
  if (s.origin === 'native') {
    const path = source.replace(/\\/g, '/')
    if (/\/\.claude(\/|$)/.test(path)) return 'claude'
    if (/\/\.codex(\/|$)/.test(path) || path.startsWith('/etc/codex')) return 'codex'
    if (/\/\.agents(\/|$)/.test(path)) return 'agents'
    if (/^claude/i.test(engine)) return 'claude'
    if (/^codex/i.test(engine)) return 'codex'
    return 'agents'
  }
  return 'added'
}

const FROM_ORDER: SkillFrom[] = ['learned', 'added', 'package', 'library', 'computer', 'claude', 'codex', 'agents', 'project']

/**
 * The skills a bot can use, by name, description, switch and where each comes from. Only these
 * cross: the reply also holds file hashes, scan warnings and the folders skills come from.
 */
export function skillsView(raw: unknown, engine = ''): Pick<Learning, 'skills' | 'waiting'> {
  const reply = object(raw)
  const skills: Skill[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(reply.skills) ? reply.skills : []) {
    const s = object(entry)
    if (typeof s.name !== 'string' || !SKILL_NAME.test(s.name) || s.name.length > 64 || seen.has(s.name)) continue
    seen.add(s.name)
    const from = skillFrom(s, engine)
    skills.push({
      name: s.name,
      description: text(s.description, 300),
      enabled: s.enabled === true,
      from,
      switchable: from !== 'project' && from !== 'library'
    })
    if (skills.length >= MAX_SKILLS) break
  }
  skills.sort((a, b) => FROM_ORDER.indexOf(a.from) - FROM_ORDER.indexOf(b.from) || a.name.localeCompare(b.name))
  return { skills, waiting: Array.isArray(reply.staged) ? reply.staged.length : 0 }
}

/**
 * MEMORY.md and its gauge. The folder path and file names stay on the server. The text comes from
 * the file route; the overview's own `text` is kept by OpenMausBot for one release only.
 */
export function memoryView(raw: unknown, file: unknown, upkeep: unknown): Memory | undefined {
  const reply = object(raw)
  const index = object(reply.index)
  const doc = object(file)
  const body = typeof doc.text === 'string' ? doc.text : reply.text
  if (!reply.index || typeof body !== 'string') return undefined
  // Only a whole file can be saved back: a text cut to the panel's size never carries its version.
  const whole = typeof doc.text === 'string' && doc.text.length <= MAX_MEMORY_TEXT
  const hash = whole && typeof doc.hash === 'string' && /^[a-f0-9]{16,128}$/.test(doc.hash) ? doc.hash : undefined
  return {
    ...(hash ? { hash } : {}),
    text: text(body, MAX_MEMORY_TEXT),
    lines: count(index.lines),
    maxLines: count(index.maxLines) || 200,
    overflow: index.truncated === true,
    topics: Array.isArray(reply.topics) ? reply.topics.length : 0,
    upkeep: object(upkeep).enabled === true
  }
}

export async function readLearning(
  input: { port: number; botId: string; engine?: string },
  deps: HttpDeps = defaultHttpDeps()
): Promise<Learning> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const bot = `/api/bots/${input.botId}`
  // A bot that has never run a turn has no memory folder yet: that is "nothing remembered", not an error.
  const optional = (path: string) => deps.request(input.port, path).catch(() => undefined)
  const [skills, memory, file, upkeep] = await Promise.all([
    deps.request(input.port, `${bot}/skills`).catch(() => {
      throw new Error('Could not read this bot’s skills. Try again.')
    }),
    optional(`${bot}/memory`),
    optional(`${bot}/memory/file?path=MEMORY.md`),
    optional(`${bot}/memory/upkeep`)
  ])
  const view = memoryView(memory, file, upkeep)
  return { ...skillsView(skills, input.engine), ...(view ? { memory: view } : {}) }
}

export async function setSkill(
  input: { port: number; botId: string; name: string; enabled: boolean; engine?: string },
  deps: HttpDeps = defaultHttpDeps()
): Promise<Learning> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  if (typeof input.name !== 'string' || input.name.length > 64 || !SKILL_NAME.test(input.name))
    throw new Error('Unknown skill.')
  if (typeof input.enabled !== 'boolean') throw new Error('Choose on or off.')
  try {
    await deps.request(
      input.port,
      `/api/bots/${input.botId}/skills/${input.name}`,
      { enabled: input.enabled },
      'PATCH'
    )
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 404)
      throw new Error('This skill is gone. Reopen the list.')
    throw new Error('Could not change this skill. Try again.')
  }
  return readLearning(input, deps)
}

/**
 * Saves MEMORY.md as the person edited it. OpenMausBot refuses with 409 when the bot changed the
 * file since it was read, so the bot's newer note is never overwritten.
 */
export async function saveMemory(
  input: { port: number; botId: string; text: string; hash: string; engine?: string },
  deps: HttpDeps = defaultHttpDeps()
): Promise<Learning> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  if (typeof input.text !== 'string' || input.text.length > MAX_MEMORY_TEXT)
    throw new Error(`Keep memory under ${MAX_MEMORY_TEXT.toLocaleString('en-US')} characters.`)
  if (typeof input.hash !== 'string' || !/^[a-f0-9]{16,128}$/.test(input.hash)) throw new Error('Reopen memory, then edit it again.')
  try {
    await deps.request(
      input.port,
      `/api/bots/${input.botId}/memory/file`,
      { path: 'MEMORY.md', text: input.text, expectedHash: input.hash },
      'PUT'
    )
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 409)
      throw new Error('The bot changed its memory while you were editing. Copy your text, reopen memory and edit again.')
    throw new Error('Could not save memory. Try again.')
  }
  return readLearning(input, deps)
}

/** Automatic learning needs bots to be allowed to write skills at all; OpenMausBot allows that by default. */
export function learningSettings(config: unknown): LearningSettings {
  const features = object(object(config).features)
  return { autoLearn: features.skillAuthoring !== false && features.skillReview === true }
}

export async function readLearningSettings(
  input: { port: number },
  deps: HttpDeps = defaultHttpDeps()
): Promise<LearningSettings> {
  return learningSettings(await deps.request(input.port, '/api/config'))
}

export async function updateLearningSettings(
  input: { port: number; autoLearn: boolean },
  deps: HttpDeps = defaultHttpDeps()
): Promise<LearningSettings> {
  if (typeof input.autoLearn !== 'boolean') throw new Error('Choose on or off.')
  // OpenMausBot merges `features` key by key, so the other switches stay as they are.
  const features = input.autoLearn ? { skillAuthoring: true, skillReview: true } : { skillReview: false }
  try {
    await deps.request(input.port, '/api/config', { features }, 'PATCH')
  } catch {
    throw new Error('Could not save the learning setting. Try again.')
  }
  try {
    return await readLearningSettings(input, deps)
  } catch {
    throw new Error('Saved, but the new setting could not be read back. Reopen Settings to check it.')
  }
}
