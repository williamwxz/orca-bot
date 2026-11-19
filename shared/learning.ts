/** A skill a bot can use. `learned` is one the bot wrote itself, with /learn or on its own. */
export type Skill = { name: string; description: string; enabled: boolean; learned: boolean }

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
