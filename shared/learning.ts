/**
 * Where a skill comes from: `learned` the bot wrote itself (with /learn or on its own); `claude`,
 * `codex` and `agents` are folders its engine loads by itself (~/.claude/skills, ~/.codex/skills,
 * ~/.agents/skills); `project` a project folder it works in; `computer` copied from this computer;
 * `package` a team package; `added` anything else added to the bot.
 */
export type SkillFrom = 'learned' | 'claude' | 'codex' | 'agents' | 'project' | 'computer' | 'package' | 'library' | 'added'
export const SKILL_FROM_LABEL: Record<SkillFrom, string> = {
  learned: 'Learned',
  claude: 'Claude Code',
  codex: 'Codex',
  agents: 'Agents folder',
  project: 'Project',
  computer: 'This computer',
  package: 'Team package',
  library: 'Library',
  added: 'Added'
}
/**
 * `switchable` is false for a project's skill (on while the bot works there, changed only there)
 * and a library skill (assigned in OpenMausBot's skills library).
 */
export type Skill = { name: string; description: string; enabled: boolean; from: SkillFrom; switchable: boolean }

/** What a bot remembers: its MEMORY.md, the part of it loaded each turn, and how many topic notes it keeps. */
export type Memory = {
  text: string
  lines: number
  maxLines: number
  /** Some lines of MEMORY.md no longer load into the bot's turns. */
  overflow: boolean
  topics: number
  /** OpenMausBot tidies this bot's memory each night. */
  upkeep: boolean
  /** The version of MEMORY.md this text is, so a save never overwrites a newer one. Absent: read-only. */
  hash?: string
}

export type Learning = {
  skills: Skill[]
  /** Skill changes waiting for an answer in the full chat. */
  waiting: number
  /** Absent until the bot has run a turn and its memory folder exists. */
  memory?: Memory
}

/** `autoLearn`: after a task with many tool steps, a bot reviews it and may save or improve a skill. */
export type LearningSettings = { autoLearn: boolean }

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_SKILLS = 100
export const MAX_MEMORY_TEXT = 24000

/** A finished export: the folder it was written to, on the bot host, and what went in. */
export type ExportResult = { folder: string; bots: number; skills: number; memoryFiles: number; skipped: string[] }
/** An export runs on the bot host in the background; the panel follows it by `id`. */
export type ExportJob = { id: number; running: boolean; result?: ExportResult; error?: string }
