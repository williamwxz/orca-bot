import { test, assert } from 'orca/testing'
import { defaultLinkDeps, findAgents, syncAgentLinks } from './agent-link.ts'
import type { LinkDeps } from './agent-link.ts'

function fake(agents = ['claude', 'codex']) {
  let record: string | undefined
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const deps: LinkDeps = {
    home: '/fake', platform: 'darwin', env: { PATH: '/fake/bin' }, userInfo: () => ({ username: 'fake', shell: '/fake/sh' }),
    bin: '/fake/pinned/openmausbot', exists: (path) => agents.some((agent) => path === `/fake/bin/${agent}`),
    read: () => record, write: (value) => { record = value },
    execFile: async (file, args, env) => { calls.push({ file, args, env }) },
    codexEntryExists: async () => false,
    claudeEnv: () => ({ PATH: '/fake/bin', CLAUDE_CONFIG_DIR: '/fake/profile' })
  }
  return { deps, calls, record: () => JSON.parse(record ?? '{}') }
}
const input = { enabled: true, owned: true, port: 8799 }

test('link defaults refuse real effects in tests', () => { assert.throws(defaultLinkDeps, /inject/) })
test('agents are found on child PATH and missing programs are skipped', async () => {
  const { deps, calls } = fake(['codex'])
  assert.deepEqual(findAgents(deps), { claude: false, codex: true })
  await syncAgentLinks(input, deps)
  assert.equal(calls.length, 1)
  const empty = fake([])
  assert.deepEqual(findAgents(empty.deps), { claude: false, codex: false })
  await syncAgentLinks(input, empty.deps)
  assert.equal(empty.calls.length, 0)
})
test('adds exact agent commands and records only port and bin', async () => {
  const { deps, calls, record } = fake()
  await syncAgentLinks(input, deps)
  assert.deepEqual(calls.map((call) => [call.file, call.args]), [
    ['/fake/bin/claude', ['mcp', 'add', '--scope', 'user', 'bot-deck', '-e', 'OMB_PORT=8799', '--', deps.bin, 'mcp']],
    ['/fake/bin/codex', ['mcp', 'add', 'bot-deck', '--env', 'OMB_PORT=8799', '--', deps.bin, 'mcp']]
  ])
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, '/fake/profile')
  assert.deepEqual(record(), { claude: { port: 8799, bin: deps.bin }, codex: { port: 8799, bin: deps.bin } })
})
test('matching record is a no-op', async () => {
  const { deps, calls } = fake()
  await syncAgentLinks(input, deps)
  calls.length = 0
  deps.codexEntryExists = async () => { throw new Error('must not inspect') }
  await syncAgentLinks(input, deps)
  assert.deepEqual(calls, [])
})
test('port or pinned binary changes remove and add again', async () => {
  for (const changed of ['port', 'bin']) {
    const { deps, calls, record } = fake()
    await syncAgentLinks(input, deps)
    calls.length = 0
    if (changed === 'bin') deps.bin = '/fake/new/openmausbot'
    const next = { ...input, port: changed === 'port' ? 18799 : 8799 }
    await syncAgentLinks(next, deps)
    assert.deepEqual(calls.map((call) => call.args[1]), ['remove', 'add', 'remove', 'add'])
    assert.deepEqual(record().codex, { port: next.port, bin: deps.bin })
  }
})
test('unlink removes only recorded bot-deck entries', async () => {
  const { deps, calls, record } = fake()
  deps.read = () => JSON.stringify({ claude: { port: 8799, bin: deps.bin } })
  await syncAgentLinks({ ...input, enabled: false }, deps)
  assert.deepEqual(calls.map((call) => call.args), [['mcp', 'remove', '--scope', 'user', 'bot-deck']])
  assert.deepEqual(record(), {})
})
test('unowned servers never read records or run commands', async () => {
  const { deps, calls } = fake()
  deps.read = () => { throw new Error('must not read') }
  await syncAgentLinks({ ...input, owned: false }, deps)
  await syncAgentLinks({ ...input, owned: false, enabled: false }, deps)
  assert.deepEqual(calls, [])
})
test('existing unrecorded Codex bot-deck entry is preserved', async () => {
  const { deps, calls } = fake(['codex'])
  deps.codexEntryExists = async () => true
  await assert.rejects(syncAgentLinks(input, deps), { message: 'Could not add Bot Deck to Codex.' })
  assert.deepEqual(calls, [])
})
test('failures contain only the generic agent sentence and preserve successful entries', async () => {
  const { deps, record } = fake()
  deps.execFile = async (file) => { if (file.endsWith('codex')) throw new Error('private-output') }
  await assert.rejects(syncAgentLinks(input, deps), { message: 'Could not add Bot Deck to Codex.' })
  assert.deepEqual(record(), { claude: { port: 8799, bin: deps.bin } })
})
test('corrupt ownership record fails closed', async () => {
  const { deps, calls } = fake()
  deps.read = () => '{bad record'
  await assert.rejects(syncAgentLinks(input, deps), { message: 'Could not read Bot Deck setup.' })
  assert.deepEqual(calls, [])
})
