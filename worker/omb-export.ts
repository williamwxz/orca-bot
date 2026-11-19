import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { defaultHttpDeps } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { validBotId } from './omb-open.ts'
import { skillFrom } from './omb-learning.ts'
import { SKILL_NAME } from '../shared/learning.ts'
import type { ExportResult } from '../shared/learning.ts'

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')
/** A memory file OpenMausBot names: MEMORY.md, a topic note, or a daily log. Nothing with a folder of its own. */
const MEMORY_FILE = /^(?:MEMORY\.md|memory\/(?:log\/)?[^/\\]+\.md)$/
const MAX_MEMORY_FILES = 500

export type ExportFs = {
  mkdir(dir: string): Promise<void>
  write(file: string, text: string): Promise<void>
  exists(target: string): Promise<boolean>
  downloads(): Promise<string>
  now(): Date
}

export function defaultExportFs(): ExportFs {
  const exists = (target: string) => lstat(target).then(() => true, () => false)
  return {
    mkdir: (dir) => mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined),
    write: (file, text) => writeFile(file, text, { mode: 0o600, flag: 'wx' }),
    exists,
    downloads: async () => {
      const downloads = path.join(homedir(), 'Downloads')
      return (await readdir(downloads).then(() => true, () => false)) ? downloads : homedir()
    },
    now: () => new Date()
  }
}

/** A folder name that is safe on macOS, Windows and Linux, kept readable for any script (Chinese names stay). */
export function folderName(raw: string, taken: Set<string>): string {
  const base =
    raw
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.-]+|[\s.-]+$/g, '')
      .slice(0, 60) || 'bot'
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base) ? `${base}-bot` : base
  let name = reserved
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${reserved}-${i}`
  taken.add(name.toLowerCase())
  return name
}

const stamp = (date: Date) => {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`
}

/** The export folder as the person reads it: under ~ when it is in the home folder, never a full user path. */
export function folderLabel(folder: string, home = homedir()): string {
  const relative = path.relative(home, folder)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `~/${relative.split(path.sep).join('/')}` : path.basename(folder)
}

/**
 * Writes every bot's persona, memory and own skills as plain files: a folder per bot laid out as
 * a Hermes Agent profile (SOUL.md, memories/, skills/), with the skills in the SKILL.md format
 * Claude Code and Codex read too, plus team.json and a README. Chats, credentials, connector
 * settings, files a skill has besides SKILL.md, library skills and skills from Claude Code, Codex
 * or a project folder are not copied.
 * Anything that could not be read is listed in `skipped`, never left out silently.
 */
export async function exportTeam(
  input: { port: number; bots: { id: string; name: string }[] },
  deps: HttpDeps = defaultHttpDeps(),
  fs: ExportFs = defaultExportFs()
): Promise<ExportResult> {
  const bots = input.bots.filter((bot) => validBotId(bot.id))
  if (!bots.length) throw new Error('There are no bots to export.')
  const parent = await fs.downloads()
  let folder = path.join(parent, `bot-team-export-${stamp(fs.now())}`)
  for (let i = 2; await fs.exists(folder); i++) folder = path.join(parent, `bot-team-export-${stamp(fs.now())}-${i}`)
  await fs.mkdir(folder)
  const taken = new Set<string>(['readme.md', 'team.json'])
  const team: Record<string, unknown>[] = []
  const skipped: string[] = []
  let skillCount = 0
  let memoryFiles = 0
  const read = (path: string) => deps.request(input.port, path).then(object, () => undefined)
  for (const listed of bots) {
    const api = `/api/bots/${listed.id}`
    const bot = await read(api)
    if (!bot) {
      skipped.push(`${listed.name}: the bot could not be read`)
      continue
    }
    const record = object(bot.bot ?? bot)
    const name = str(record.name, 200) || listed.name
    const dir = path.join(folder, folderName(name, taken))
    await fs.mkdir(dir)
    const soul = str(record.soul, 200_000)
    if (soul.trim()) await fs.write(path.join(dir, 'SOUL.md'), soul.endsWith('\n') ? soul : `${soul}\n`)

    // Memory through OpenMausBot's own file route, so only files it lists and serves are read.
    const overview = await read(`${api}/memory`)
    const memoryNames: string[] = []
    if (!overview) skipped.push(`${name}: memory`)
    else {
      const files = ['MEMORY.md', ...[...(overview.topics ?? []), ...(overview.logs ?? [])].map((f: any) => str(f?.path, 300))]
      if (files.length > MAX_MEMORY_FILES) skipped.push(`${name}: ${files.length - MAX_MEMORY_FILES} more memory files`)
      const used = new Set<string>()
      for (const file of files.slice(0, MAX_MEMORY_FILES)) {
        if (!MEMORY_FILE.test(file) || file.split('/').some((part) => part === '..' || part === '.')) continue
        const doc = await read(`${api}/memory/file?path=${encodeURIComponent(file)}`)
        if (!doc || typeof doc.text !== 'string') {
          skipped.push(`${name}: memory file ${file}`)
          continue
        }
        if (doc.exists === false || !doc.text.trim()) continue
        // A topic note may share MEMORY.md's name: it keeps a name of its own.
        let relative = file === 'MEMORY.md' ? 'MEMORY.md' : file.slice('memory/'.length)
        if (used.has(relative.toLowerCase())) relative = relative.replace(/\.md$/, ' (topic).md')
        used.add(relative.toLowerCase())
        const target = path.join(dir, 'memories', relative)
        await fs.mkdir(path.dirname(target))
        await fs.write(target, doc.text)
        memoryNames.push(file)
        memoryFiles++
      }
    }

    // A skill is exported as the SKILL.md OpenMausBot serves, the reviewed text, never a folder read
    // from disk; any other files it has are named as not exported. Skills its engine or the library
    // provides stay where they are.
    const listing = await read(`${api}/skills`)
    const own: string[] = []
    const engine: string[] = []
    const library: string[] = []
    if (!listing) skipped.push(`${name}: skills`)
    for (const entry of Array.isArray(listing?.skills) ? listing.skills : []) {
      const s = object(entry)
      if (typeof s.name !== 'string' || s.name.length > 64 || !SKILL_NAME.test(s.name)) continue
      const from = skillFrom(s)
      if (from === 'library') {
        library.push(s.name)
        continue
      }
      if (['claude', 'codex', 'agents', 'project', 'computer'].includes(from)) {
        engine.push(s.name)
        continue
      }
      const file = await read(`${api}/skills/${s.name}`)
      if (typeof file?.text !== 'string' || !file.text.trim()) {
        skipped.push(`${name}: skill ${s.name}`)
        continue
      }
      const target = path.join(dir, 'skills', s.name)
      await fs.mkdir(target)
      await fs.write(path.join(target, 'SKILL.md'), file.text)
      own.push(s.name)
      skillCount++
      const others = Array.isArray(s.files) ? s.files.filter((f: unknown) => f !== 'SKILL.md').length : 0
      if (others) skipped.push(`${name}: ${others} file${others === 1 ? '' : 's'} of skill ${s.name} besides SKILL.md`)
      else if (typeof s.referencesSha256 === 'string' && s.referencesSha256) skipped.push(`${name}: the references of skill ${s.name}`)
    }
    const model = object(record.modelSelection)
    team.push({
      name,
      folder: path.basename(dir),
      ...(str(record.title, 300) ? { title: str(record.title, 300) } : {}),
      ...(str(record.description, 2000) ? { description: str(record.description, 2000) } : {}),
      ...(str(record.section, 200) ? { group: str(record.section, 200) } : {}),
      ...(str(model.instanceId, 100) ? { engine: str(model.instanceId, 100), model: str(model.model, 200) } : {}),
      ...(str(record.approvalMode, 40) ? { approval: str(record.approvalMode, 40) } : {}),
      connectors: Array.isArray(record.mcpServers) ? record.mcpServers.filter((n: unknown) => typeof n === 'string').slice(0, 50) : [],
      skills: own,
      skillsFromYourAgents: engine,
      ...(library.length ? { skillsFromLibrary: library } : {}),
      memory: memoryNames
    })
  }
  await fs.write(
    path.join(folder, 'team.json'),
    `${JSON.stringify({ format: 'bot-team-export/1', exportedAt: fs.now().toISOString(), bots: team, ...(skipped.length ? { notExported: skipped } : {}) }, null, 2)}\n`
  )
  await fs.write(path.join(folder, 'README.md'), readme(team))
  return { folder: folderLabel(folder), bots: team.length, skills: skillCount, memoryFiles, skipped }
}

function readme(team: Record<string, unknown>[]): string {
  return `# Bot team export

Exported by Bot Team for Orca from OpenMausBot. Everything here is plain text: open it in any editor.

## What is in it

- \`team.json\`: each bot's name, role, group, engine and model, approval level, connector names, and which skills and memory files were exported.
- One folder per bot (${team.map((b) => `\`${b.folder}\``).join(', ')}):
  - \`SOUL.md\`: the bot's persona and standing instructions.
  - \`memories/MEMORY.md\`: what the bot remembers and loads each turn. \`memories/<topic>.md\` are longer notes it reads when needed; \`memories/log/\` are its daily logs.
  - \`skills/<name>/SKILL.md\`: skills the bot learned or was given. This is the same skill format Claude Code, Codex and Hermes Agent use.

Not included: chats, files the bots made, credentials, connector settings, skills from OpenMausBot's skills library (\`skillsFromLibrary\`), and skills that come from your own Claude Code, Codex or project folders (they are still in those folders; \`team.json\` lists them under \`skillsFromYourAgents\`). Anything that could not be read is listed under \`notExported\`.

## Use it elsewhere

**Hermes Agent.** Each bot folder is laid out like a Hermes profile. For a bot folder \`NAME\`:

\`\`\`sh
hermes profile create name
cp NAME/SOUL.md ~/.hermes/profiles/name/SOUL.md
cp -R NAME/skills/. ~/.hermes/profiles/name/skills/
\`\`\`

Hermes keeps its own memory short, as entries separated by a line with \`§\`, so do not copy \`MEMORY.md\` over it. Add the facts that matter with Hermes' memory, or keep \`memories/\` in the profile's folder and tell the bot to read it.

**Claude Code.** Copy a bot's skills into \`~/.claude/skills/\` (or a project's \`.claude/skills/\`), and put \`SOUL.md\` and the parts of \`MEMORY.md\` you want in a \`CLAUDE.md\`.

**Codex.** Copy skills into \`~/.agents/skills/\` (or \`~/.codex/skills/\`), and put \`SOUL.md\` and memory in an \`AGENTS.md\`.

**OpenMausBot again.** Its own encrypted backup (Settings → Import & export → Export full backup, in OpenMausBot) restores everything, chats included. This export is the way out, not a backup to restore.
`
}
