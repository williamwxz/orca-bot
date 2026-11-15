import { assert, test } from 'orca/testing'
import { createBot, listModels, setModel } from './omb-manage.ts'
import type { CliDeps } from './omb-cli.ts'
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function fake() {
  const calls: string[][] = []
  const deps: CliDeps = {
    home: '/fake', platform: 'darwin', env: {}, exists: () => true, sleep: async () => {},
    execFile: async (_file, args) => {
      calls.push(args)
      if (args[0] === 'models') return JSON.stringify({ instances: [{ instanceId: 'claude', displayName: 'Claude', snapshot: { state: 'available' }, models: { default: 'sonnet', options: [{ id: 'sonnet', label: 'Sonnet' }] } }] })
      if (args[0] === 'bots') return JSON.stringify({ bots: [{ id, busy: false, waitingForTeammates: false }] })
      return JSON.stringify({ bot: { id, activeTaskId: 'thread' } })
    }
  }
  return { deps, calls }
}

test('create uses exact model argv and returns receipt without a retry', async () => {
  const { deps, calls } = fake()
  assert.deepEqual(await createBot({ port: 18799, name: ' Helper ', model: 'claude/sonnet' }, deps), { id, activeTaskId: 'thread' })
  assert.deepEqual(calls, [['models', '--port', '18799', '--json'], ['new-bot', 'Helper', '--model', 'claude/sonnet', '--port', '18799', '--json']])
})

test('ambiguous create failure is never retried and warns about duplicate creation', async () => {
  const { deps, calls } = fake()
  const run = deps.execFile
  deps.execFile = async (file, args, options) => {
    const result = await run(file, args, options)
    if (args[0] === 'new-bot') throw new Error('private stderr')
    return result
  }
  await assert.rejects(createBot({ port: 18799, name: 'Helper', model: 'claude/sonnet' }, deps), /may already exist/)
  assert.equal(calls.filter((args) => args[0] === 'new-bot').length, 1)
})

test('set model checks availability and current busy state then uses exact argv', async () => {
  const { deps, calls } = fake()
  await setModel({ port: 18799, botId: id, model: 'claude/sonnet' }, deps)
  assert.deepEqual(calls[2], ['set-model', id, '--model', 'claude/sonnet', '--port', '18799', '--json'])
  const run = deps.execFile
  for (const status of [{ busy: true }, { waitingForTeammates: true }]) {
    calls.length = 0
    deps.execFile = async (file, args, options) => args[0] === 'bots' ? JSON.stringify({ bots: [{ id, ...status }] }) : run(file, args, options)
    await assert.rejects(setModel({ port: 18799, botId: id, model: 'claude/sonnet' }, deps), /busy.*idle/)
    assert.equal(calls.some((args) => args[0] === 'set-model'), false)
  }
})

test('invalid names and unavailable models never mutate', async () => {
  const { deps, calls } = fake()
  for (const name of ['', ' ', '-flag', 'a\nname']) await assert.rejects(createBot({ port: 18799, name, model: 'claude/sonnet' }, deps), /Enter a name/)
  await assert.rejects(createBot({ port: 18799, name: 'Helper', model: 'missing/model' }, deps), /available model/)
  assert.equal(calls.some((args) => args[0] === 'new-bot'), false)
  assert.equal((await listModels({ port: 18799 }, deps))[0].label, 'Claude')
})
