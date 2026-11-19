import { assert, test } from 'orca/testing'
import { learningSettings, memoryView, readLearning, setSkill, skillsView, updateLearningSettings } from './omb-learning.ts'
import { HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const skillsReply = {
  skills: [
    { name: 'release-notes', description: 'Write release notes.', enabled: false, source: 'https://github.com/x/y', sha256: 'SECRET', warnings: ['SECRET'] },
    { name: 'weekly-sales-report', description: 'Builds the weekly report.', enabled: true, source: 'learn:automatic review of this conversation' },
    { name: 'Bad Name', description: 'dropped', enabled: true },
    { name: 'weekly-sales-report', description: 'duplicate', enabled: false }
  ],
  staged: [{ id: 's1' }]
}
const memoryReply = {
  botId: id,
  workspacePath: '/Users/SECRET/.openmausbot/workspaces/x',
  index: { lines: 47, maxLines: 200, truncated: false, hash: 'SECRET' },
  topics: [{ path: 'memory/SECRET.md', name: 'SECRET' }, { path: 'memory/b.md', name: 'b' }],
  logs: [{ path: 'memory/log/2026-11-19.md' }],
  text: 'OLD OVERVIEW TEXT'
}
function fake(replies: Record<string, unknown> = {}, fail?: (path: string, method?: string) => Error | undefined) {
  const calls: { path: string; body?: object; method?: string }[] = []
  const deps: HttpDeps = {
    avatar: async () => undefined,
    request: async (_port, path, body, method) => {
      calls.push({ path, ...(body ? { body } : {}), ...(method ? { method } : {}) })
      const problem = fail?.(path, method)
      if (problem) throw problem
      if (path in replies) return replies[path]
      if (path.endsWith('/skills')) return skillsReply
      if (path.endsWith('/memory')) return memoryReply
      if (path.endsWith('/memory/upkeep')) return { enabled: true, lastTidy: { at: 1 } }
      if (path.endsWith('/memory/file?path=MEMORY.md')) return { path: 'MEMORY.md', text: '- 2026-11-19 · likes short replies', hash: 'SECRET', exists: true }
      return {}
    }
  }
  return { deps, calls }
}

test('skills list keeps only names, descriptions and switches, learned ones first', () => {
  const view = skillsView(skillsReply)
  assert.deepEqual(view, {
    skills: [
      { name: 'weekly-sales-report', description: 'Builds the weekly report.', enabled: true, learned: true },
      { name: 'release-notes', description: 'Write release notes.', enabled: false, learned: false }
    ],
    waiting: 1
  })
  assert.doesNotMatch(JSON.stringify(view), /SECRET|github/)
  assert.deepEqual(skillsView(undefined), { skills: [], waiting: 0 })
  const many = skillsView({ skills: Array.from({ length: 150 }, (_, i) => ({ name: `s-${i}`, description: 'd'.repeat(500) })) })
  assert.equal(many.skills.length, 100)
  assert.equal(many.skills[0].description.length, 300)
})

test('memory shows the text and its gauge, never the folder or file names', () => {
  const view = memoryView(memoryReply, { text: '- 2026-11-19 · likes short replies', hash: 'SECRET' }, { enabled: true })
  assert.deepEqual(view, { text: '- 2026-11-19 · likes short replies', lines: 47, maxLines: 200, overflow: false, topics: 2, upkeep: true })
  assert.doesNotMatch(JSON.stringify(view), /SECRET|workspaces/)
  assert.equal(memoryView({ index: {} }, undefined, undefined), undefined)
  assert.equal(memoryView(undefined, { text: 'x' }, undefined), undefined)
  // An older server without the file route still has the overview's text.
  assert.equal(memoryView(memoryReply, undefined, undefined)?.text, 'OLD OVERVIEW TEXT')
  const big = memoryView({ index: { lines: 250, maxLines: 200, truncated: true } }, { text: 'x'.repeat(30000) }, { enabled: false })
  assert.equal(big?.text.length, 24000)
  assert.equal(big?.overflow, true)
  assert.equal(big?.upkeep, false)
})

test('reading a bot without memory yet still lists its skills; a failed skill read says so', async () => {
  const { deps, calls } = fake({}, (path) => (path.includes('/memory') ? new HttpStatusError(404, {}) : undefined))
  const learning = await readLearning({ port: 9, botId: id }, deps)
  assert.equal(learning.memory, undefined)
  assert.equal(learning.skills.length, 2)
  assert.deepEqual(calls.map((c) => c.path).sort(), [`/api/bots/${id}/memory`, `/api/bots/${id}/memory/file?path=MEMORY.md`, `/api/bots/${id}/memory/upkeep`, `/api/bots/${id}/skills`])
  const full = await readLearning({ port: 9, botId: id }, fake().deps)
  assert.equal(full.memory?.text, '- 2026-11-19 · likes short replies')
  const broken = fake({}, (path) => (path.endsWith('/skills') ? new Error('SECRET') : undefined))
  await assert.rejects(readLearning({ port: 9, botId: id }, broken.deps), /^Error: Could not read this bot’s skills/)
  await assert.rejects(readLearning({ port: 9, botId: '../x' }, deps), /Invalid bot ID/)
})

test('a skill switch patches only that skill and returns the fresh list', async () => {
  const { deps, calls } = fake()
  const learning = await setSkill({ port: 9, botId: id, name: 'release-notes', enabled: true }, deps)
  assert.deepEqual(calls[0], { path: `/api/bots/${id}/skills/release-notes`, body: { enabled: true }, method: 'PATCH' })
  assert.equal(learning.skills.length, 2)
  for (const name of ['../etc', 'Bad', '', 'a'.repeat(65), 7])
    await assert.rejects(setSkill({ port: 9, botId: id, name: name as any, enabled: true }, deps), /Unknown skill/)
  await assert.rejects(setSkill({ port: 9, botId: id, name: 'x', enabled: 'yes' as any }, deps), /Choose on or off/)
  const gone = fake({}, (_p, method) => (method === 'PATCH' ? new HttpStatusError(404, { error: 'no such skill' }) : undefined))
  await assert.rejects(setSkill({ port: 9, botId: id, name: 'x', enabled: false }, gone.deps), /This skill is gone/)
  const other = fake({}, (_p, method) => (method === 'PATCH' ? new HttpStatusError(409, { error: 'SECRET' }) : undefined))
  await assert.rejects(setSkill({ port: 9, botId: id, name: 'x', enabled: false }, other.deps), /^Error: Could not change this skill/)
})

test('automatic learning needs skill writing on, and saving touches only those two switches', async () => {
  assert.deepEqual(learningSettings({ features: { skillReview: true } }), { autoLearn: true })
  assert.deepEqual(learningSettings({ features: { skillReview: true, skillAuthoring: false } }), { autoLearn: false })
  assert.deepEqual(learningSettings({}), { autoLearn: false })
  const on = fake({ '/api/config': { features: { skillReview: true } } })
  assert.deepEqual(await updateLearningSettings({ port: 9, autoLearn: true }, on.deps), { autoLearn: true })
  assert.deepEqual(on.calls[0], { path: '/api/config', body: { features: { skillAuthoring: true, skillReview: true } }, method: 'PATCH' })
  const off = fake({ '/api/config': { features: {} } })
  assert.deepEqual(await updateLearningSettings({ port: 9, autoLearn: false }, off.deps), { autoLearn: false })
  assert.deepEqual(off.calls[0].body, { features: { skillReview: false } })
  await assert.rejects(updateLearningSettings({ port: 9, autoLearn: 1 as any }, off.deps), /Choose on or off/)
  const refused = fake({}, (_p, method) => (method === 'PATCH' ? new Error('SECRET') : undefined))
  await assert.rejects(updateLearningSettings({ port: 9, autoLearn: true }, refused.deps), /^Error: Could not save the learning setting/)
})
