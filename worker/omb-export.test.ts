import { assert, test } from 'orca/testing'
import { createHash } from 'node:crypto'
import { exportTeam, folderLabel, folderName } from './omb-export.ts'
import type { ExportFs } from './omb-export.ts'
import type { HttpDeps } from './omb-http.ts'

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const rev = 'f'.repeat(64)
const reviewed = '---\nname: weekly-report\n---\nreviewed body\n'
const plain = '---\nname: notes-style\n---\nbody\n'
const ws = '/data/workspaces/a'

function fakeFs(disk: Record<string, string>) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const copies: [string, string][] = []
  const fs: ExportFs = {
    mkdir: async (dir) => void dirs.add(dir),
    write: async (file, text) => {
      if (files.has(file)) throw new Error('EEXIST')
      files.set(file, text)
    },
    exists: async (target) => dirs.has(target) || target === '/home/me/Downloads/bot-team-export-2026-11-19-0905',
    copyFolder: async (from, to) => {
      if (disk[`${from}/SKILL.md`] === undefined) return false
      copies.push([from, to])
      files.set(`${to}/SKILL.md`, disk[`${from}/SKILL.md`])
      return true
    },
    readText: async (file) => disk[file],
    downloads: async () => '/home/me/Downloads',
    now: () => new Date(2026, 10, 19, 9, 5)
  }
  return { fs, files, copies }
}
function fakeHttp() {
  const calls: string[] = []
  const deps: HttpDeps = {
    avatar: async () => undefined,
    request: async (_port, path) => {
      calls.push(path)
      if (path === `/api/bots/${a}`) return { bot: { name: 'Manufacturing Eng', title: '总工', section: 'Honex', soul: '# Persona', modelSelection: { instanceId: 'claude', model: 'claude-fable-5-2' }, approvalMode: 'ask', mcpServers: ['linear', 7], apiKey: 'SECRET' } }
      if (path === `/api/bots/${a}/memory`)
        return { workspacePath: ws, topics: [{ path: 'memory/parts.md' }, { path: 'memory/MEMORY.md' }, { path: '../../etc/passwd' }, { path: 'memory/sub/x.md' }, { path: 'memory/broken.md' }], logs: [{ path: 'memory/log/2026-11-18.md' }] }
      if (path === `/api/bots/${a}/memory/file?path=memory%2Fbroken.md`) throw new Error('500 SECRET')
      if (path.startsWith(`/api/bots/${a}/memory/file?path=`)) {
        const file = decodeURIComponent(path.split('=')[1])
        return { path: file, text: `text of ${file}`, exists: true, hash: 'SECRET' }
      }
      if (path === `/api/bots/${a}/skills`)
        return {
          skills: [
            { name: 'weekly-report', source: 'learn:automatic review', sha256: sha(reviewed) },
            { name: 'notes-style', source: 'learn:x', sha256: sha(plain) },
            { name: 'stale', source: 'learn:x', sha256: sha('newer text'), files: ['SKILL.md', 'references/a.md'] },
            { name: 'from-api', source: 'https://github.com/x/y', sha256: 'none' },
            { name: 'shared', origin: 'library', source: 'library:shared' },
            { name: 'orca-cli', origin: 'native', source: '/Users/me/.agents/skills/orca-cli' },
            { name: 'gone', source: 'learn:x' },
            { name: '../evil', source: 'learn:x' }
          ]
        }
      if (path === `/api/bots/${a}/skills/from-api`) return { text: '---\nname: from-api\n---\n' }
      if (path === `/api/bots/${a}/skills/stale`) return { text: 'newer text' }
      if (path === `/api/bots/${b}`) return { bot: { name: 'Manufacturing Eng', soul: '' } }
      if (path === `/api/bots/${b}/memory`) throw new Error('SECRET')
      if (path === `/api/bots/${b}/skills`) throw new Error('SECRET')
      throw new Error('404 SECRET')
    }
  }
  return { deps, calls }
}

test('export copies each bot’s reviewed skill folders and memory, and lists everything it could not read', async () => {
  const disk = {
    '/data/skill-state/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/skills.json': JSON.stringify({ 'weekly-report': { storageRevision: rev }, stale: {} }),
    [`${ws}/skills/.revisions/${rev}/SKILL.md`]: reviewed,
    [`${ws}/skills/weekly-report/SKILL.md`]: 'an older, unreviewed copy',
    [`${ws}/skills/notes-style/SKILL.md`]: plain,
    [`${ws}/skills/stale/SKILL.md`]: 'older text'
  }
  const { fs, files, copies } = fakeFs(disk)
  const { deps, calls } = fakeHttp()
  const result = await exportTeam({ port: 9, bots: [{ id: a, name: 'x' }, { id: b, name: 'y' }, { id: c, name: 'Gone bot' }, { id: 'bad id', name: 'z' }] }, deps, fs)
  const root = '/home/me/Downloads/bot-team-export-2026-11-19-0905-2'
  assert.equal(result.folder, 'bot-team-export-2026-11-19-0905-2')
  assert.equal(result.bots, 2)
  assert.equal(result.skills, 4)
  assert.equal(result.memoryFiles, 4)
  assert.deepEqual(result.skipped, [
    'Manufacturing Eng: memory file memory/broken.md',
    'Manufacturing Eng: 1 file of skill stale besides SKILL.md',
    'Manufacturing Eng: skill gone',
    'Manufacturing Eng: memory',
    'Manufacturing Eng: skills',
    'Gone bot: the bot could not be read'
  ])
  // The reviewed revision is copied, never the stale folder of the same name; a folder whose SKILL.md
  // differs from the listed one falls back to the served text.
  assert.deepEqual(copies, [
    [`${ws}/skills/.revisions/${rev}`, `${root}/Manufacturing Eng/skills/weekly-report`],
    [`${ws}/skills/notes-style`, `${root}/Manufacturing Eng/skills/notes-style`]
  ])
  assert.equal(files.get(`${root}/Manufacturing Eng/skills/weekly-report/SKILL.md`), reviewed)
  assert.equal(files.get(`${root}/Manufacturing Eng/skills/stale/SKILL.md`), 'newer text')
  assert.equal(files.get(`${root}/Manufacturing Eng/SOUL.md`), '# Persona\n')
  // A topic named MEMORY.md keeps its own file next to the bot's MEMORY.md.
  assert.equal(files.get(`${root}/Manufacturing Eng/memories/MEMORY.md`), 'text of MEMORY.md')
  assert.equal(files.get(`${root}/Manufacturing Eng/memories/MEMORY (topic).md`), 'text of memory/MEMORY.md')
  assert.equal(files.get(`${root}/Manufacturing Eng/memories/parts.md`), 'text of memory/parts.md')
  assert.equal(files.get(`${root}/Manufacturing Eng/memories/log/2026-11-18.md`), 'text of memory/log/2026-11-18.md')
  assert.ok(!calls.some((p) => p.includes('passwd') || p.includes('sub%2Fx') || p.includes('evil') || p.includes('orca-cli') || p.includes('/skills/shared')))
  const team = JSON.parse(files.get(`${root}/team.json`)!)
  assert.equal(team.format, 'bot-team-export/1')
  assert.deepEqual(team.bots[0], {
    name: 'Manufacturing Eng',
    folder: 'Manufacturing Eng',
    title: '总工',
    group: 'Honex',
    engine: 'claude',
    model: 'claude-fable-5-2',
    approval: 'ask',
    connectors: ['linear'],
    skills: ['weekly-report', 'notes-style', 'stale', 'from-api'],
    skillsFromYourAgents: ['orca-cli'],
    skillsFromLibrary: ['shared'],
    memory: ['MEMORY.md', 'memory/parts.md', 'memory/MEMORY.md', 'memory/log/2026-11-18.md']
  })
  assert.equal(team.bots[1].folder, 'Manufacturing Eng-2')
  assert.deepEqual(team.notExported, result.skipped)
  assert.match(files.get(`${root}/README.md`)!, /hermes profile create/)
  assert.doesNotMatch([...files.values()].join('\n'), /SECRET/)
  await assert.rejects(exportTeam({ port: 9, bots: [] }, deps, fs), /There are no bots to export/)
})

test('folder names are safe on every system, and the folder is shown without the home path', () => {
  const taken = new Set<string>()
  assert.equal(folderName('Work/Bot: "A"?', taken), 'Work-Bot- -A')
  assert.equal(folderName('work-bot- -a', taken), 'work-bot- -a-2')
  assert.equal(folderName('..', taken), 'bot')
  assert.equal(folderName('CON', taken), 'CON-bot')
  assert.equal(folderName('美标制造', taken), '美标制造')
  assert.equal(folderName('x'.repeat(100), taken).length, 60)
  assert.equal(folderLabel('/Users/me/Downloads/bot-team-export-1', '/Users/me'), '~/Downloads/bot-team-export-1')
  assert.equal(folderLabel('/srv/exports/bot-team-export-1', '/Users/me'), 'bot-team-export-1')
})
