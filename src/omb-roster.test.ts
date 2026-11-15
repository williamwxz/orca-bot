import { assert, test } from 'orca/testing'
import { listBots } from './omb-roster.ts'
import type { CliDeps } from './omb-cli.ts'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const bot = { id, name: 'Helper', title: 'Research', chiefOfStaff: false, busy: false, waitingForTeammates: false, unread: false, modelSelection: { instanceId: 'codex', model: 'gpt-6' } }
function fake(output: string): CliDeps {
  return {
    home: '/fake', platform: 'darwin', env: {},
    exists: () => false, fileExists: () => false,
    write: () => { throw new Error('Roster must not write') },
    execFile: async (_file, args, options) => {
      assert.deepEqual(args, ['bots', '--port', '18799', '--json'])
      assert.equal(options.timeout, 10000)
      return output
    }
  }
}

test('roster maps all states, busy wins over waiting, and main comes first stably', async () => {
  const bots = [bot, { ...bot, name: 'Waiting', waitingForTeammates: true }, { ...bot, name: 'Main', chiefOfStaff: true, busy: true, waitingForTeammates: true, unread: true }]
  const result = await listBots({ port: 18799 }, fake(JSON.stringify({ bots })))
  assert.deepEqual(result.map((item) => item.name), ['Main', 'Helper', 'Waiting'])
  assert.deepEqual(result.map((item) => item.state), ['working', 'idle', 'waiting'])
  assert.deepEqual(result[0], { id, name: 'Main', title: 'Research', main: true, state: 'working', unread: true, modelLabel: 'codex / gpt-6' })
  assert.deepEqual(await listBots({ port: 18799 }, fake('{"bots":[]}')), [])
})

test('malformed roster output produces a plain error', async () => {
  for (const output of ['not json secret', 'null', '{}', '{"bots":{}}', '{"bots":[null]}', JSON.stringify({ bots: [{ ...bot, busy: 'yes' }] }), JSON.stringify({ bots: [{ ...bot, modelSelection: null }] }), JSON.stringify({ bots: [{ ...bot, id: 'bad' }] })]) {
    await assert.rejects(listBots({ port: 18799 }, fake(output)), { message: 'OpenMausBot returned an unexpected bot list.' })
  }
})

test('roster command errors never expose stderr', async () => {
  const deps = fake('')
  deps.execFile = async () => { throw new Error('stderr: password=secret') }
  await assert.rejects(listBots({ port: 18799 }, deps), { message: 'Could not refresh bots. Check that OpenMausBot is running.' })
})
