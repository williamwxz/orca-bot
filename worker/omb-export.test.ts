import { assert, test } from 'orca/testing'
import { exportTeam, folderName } from './omb-export.ts'
import type { ExportFs } from './omb-export.ts'
import type { HttpDeps } from './omb-http.ts'

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function fakeFs(folders: Record<string, boolean> = {}) {
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
      if (!folders[from]) return false
      copies.push([from, to])
      files.set(`${to}/SKILL.md`, `copied from ${from}`)
      return true
    },
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
      if (path === `/api/bots/${a}/memory`) return { workspacePath: '/data/workspaces/a', topics: [{ path: 'memory/parts.md' }, { path: '../../etc/passwd' }, { path: 'memory/sub/x.md' }], logs: [{ path: 'memory/log/2026-11-18.md' }] }
      if (path.startsWith(`/api/bots/${a}/memory/file?path=`)) {
        const file = decodeURIComponent(path.split('=')[1])
        return { path: file, text: `text of ${file}`, exists: true, hash: 'SECRET' }
      }
      if (path === `/api/bots/${a}/skills`)
        return {
          skills: [
            { name: 'weekly-report', source: 'learn:automatic review' },
            { name: 'from-api', source: 'https://github.com/x/y' },
            { name: 'orca-cli', origin: 'native', source: '/Users/me/.agents/skills/orca-cli' },
            { name: 'gone', source: 'learn:x' },
            { name: '../evil', source: 'learn:x' }
          ]
        }
      if (path === `/api/bots/${a}/skills/from-api`) return { text: '---\nname: from-api\n---\n' }
      if (path === `/api/bots/${b}`) return { bot: { name: 'Manufacturing Eng', soul: '' } }
      throw new Error('404 SECRET')
    }
  }
  return { deps, calls }
}

test('export writes each bot as a Hermes-style folder, copies only its own skills and safe memory files', async () => {
  const { fs, files, copies } = fakeFs({ '/data/workspaces/a/skills/weekly-report': true })
  const { deps, calls } = fakeHttp()
  const result = await exportTeam({ port: 9, bots: [{ id: a, name: 'x' }, { id: b, name: 'y' }, { id: 'bad id', name: 'z' }] }, deps, fs)
  const root = '/home/me/Downloads/bot-team-export-2026-11-19-0905-2'
  assert.deepEqual(result, { folder: root, bots: 2, skills: 2, memoryFiles: 3, skipped: ['Manufacturing Eng: skill gone'] })
  assert.equal(files.get(`${root}/Manufacturing Eng/SOUL.md`), '# Persona\n')
  assert.equal(files.get(`${root}/Manufacturing Eng/memories/MEMORY.md`), 'text of MEMORY.md')
  assert.equal(files.get(`${root}/Manufacturing Eng/memories/parts.md`), 'text of memory/parts.md')
  assert.equal(files.get(`${root}/Manufacturing Eng/memories/log/2026-11-18.md`), 'text of memory/log/2026-11-18.md')
  assert.deepEqual(copies, [['/data/workspaces/a/skills/weekly-report', `${root}/Manufacturing Eng/skills/weekly-report`]])
  assert.equal(files.get(`${root}/Manufacturing Eng/skills/from-api/SKILL.md`), '---\nname: from-api\n---\n')
  // The second bot with the same name gets its own folder and no empty SOUL.md.
  assert.equal([...files.keys()].some((f) => f.startsWith(`${root}/Manufacturing Eng-2/`)), false)
  assert.ok(!calls.some((p) => p.includes('passwd') || p.includes('sub%2Fx') || p.includes('evil') || p.includes('orca-cli')))
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
    skills: ['weekly-report', 'from-api'],
    skillsFromYourAgents: ['orca-cli'],
    memory: ['MEMORY.md', 'memory/parts.md', 'memory/log/2026-11-18.md']
  })
  assert.equal(team.bots[1].folder, 'Manufacturing Eng-2')
  assert.match(files.get(`${root}/README.md`)!, /hermes profile create/)
  assert.doesNotMatch([...files.values()].join('\n'), /SECRET/)
  await assert.rejects(exportTeam({ port: 9, bots: [] }, deps, fs), /There are no bots to export/)
})

test('folder names are safe on every system and unique regardless of case', () => {
  const taken = new Set<string>()
  assert.equal(folderName('Work/Bot: "A"?', taken), 'Work-Bot- -A')
  assert.equal(folderName('work-bot- -a', taken), 'work-bot- -a-2')
  assert.equal(folderName('..', taken), 'bot')
  assert.equal(folderName('CON', taken), 'CON-bot')
  assert.equal(folderName('美标制造', taken), '美标制造')
  assert.equal(folderName('x'.repeat(100), taken).length, 60)
})
