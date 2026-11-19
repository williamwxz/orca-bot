import { defaultHttpDeps, HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { validBotId } from './omb-open.ts'
import { MAX_MEMORY_TEXT, MAX_SKILLS, SKILL_NAME } from '../shared/learning.ts'
import type { Learning, LearningSettings, Memory, Skill } from '../shared/learning.ts'

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/**
 * The skills a bot can use, by name, description and switch. Only these cross: the reply also
 * holds file hashes, scan warnings and where each skill came from on disk.
 */
export function skillsView(raw: unknown): Pick<Learning, 'skills' | 'waiting'> {
  const reply = object(raw)
  const skills: Skill[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(reply.skills) ? reply.skills : []) {
    const s = object(entry)
    if (typeof s.name !== 'string' || !SKILL_NAME.test(s.name) || s.name.length > 64 || seen.has(s.name)) continue
    seen.add(s.name)
    skills.push({
      name: s.name,
      description: text(s.description, 300),
      enabled: s.enabled === true,
      learned: typeof s.source === 'string' && s.source.startsWith('learn:')
    })
    if (skills.length >= MAX_SKILLS) break
  }
  skills.sort((a, b) => Number(b.learned) - Number(a.learned) || a.name.localeCompare(b.name))
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
  return {
    text: text(body, MAX_MEMORY_TEXT),
    lines: count(index.lines),
    maxLines: count(index.maxLines) || 200,
    overflow: index.truncated === true,
    topics: Array.isArray(reply.topics) ? reply.topics.length : 0,
    upkeep: object(upkeep).enabled === true
  }
}

export async function readLearning(
  input: { port: number; botId: string },
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
  return { ...skillsView(skills), ...(view ? { memory: view } : {}) }
}

export async function setSkill(
  input: { port: number; botId: string; name: string; enabled: boolean },
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
