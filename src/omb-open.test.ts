import { assert, test } from 'orca/testing'
import { openChat } from './omb-open.ts'
import type { CliDeps } from './omb-cli.ts'

const origin = 'http://127.0.0.1:18799'
const secret = `${origin}/pair#code=FAKE-SECRET`
const input = { port: 18799, startedByPlugin: true }
function fake(paired = false) {
  const calls: string[][] = []
  const deps: CliDeps = {
    userInfo: () => ({ username: 'fake-user', shell: '/fake/shell' }), home: '/fake', platform: 'darwin', env: {}, exists: () => true, sleep: async () => {},
    execFile: async (_file, args) => {
      calls.push(args)
      if (args[0] === 'pair') return secret
      if (args[0] === 'snapshot') return paired ? 'heading "Chat"' : 'button "Connect" [ref=e11]'
      if (args[0] === 'click') paired = true
      if (args[1] === 'list') return JSON.stringify({ ok: true, result: { tabs: [] } })
      return JSON.stringify({ ok: true, result: { browserPageId: 'page-1' } })
    }
  }
  return { deps, calls }
}

test('pairing screen triggers a fresh pair, exact snapshot/click arrays, then requested chat', async () => {
  const { deps, calls } = fake()
  const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const wanted = `${origin}/?thread=thread-1&bot=${botId}`
  assert.deepEqual(await openChat({ ...input, botId, activeTaskId: 'thread-1' }, deps), { message: '' })
  assert.deepEqual(calls, [
    ['tab', 'list', '--json'],
    ['tab', 'create', '--url', wanted, '--json'],
    ['snapshot', '--page', 'page-1'],
    ['pair', '--label', 'Orca', '--port', '18799', '--data-dir', '/fake/.bot-deck/data'],
    ['goto', '--url', secret, '--page', 'page-1', '--json'],
    ['snapshot', '--page', 'page-1'],
    ['click', '--element', 'e11', '--page', 'page-1', '--json'],
    ['snapshot', '--page', 'page-1'],
    ['goto', '--url', wanted, '--page', 'page-1', '--json'],
    ['snapshot', '--page', 'page-1']
  ])
})

test('no pairing on a signed-in tab, preserving its conversation', async () => {
  const { deps, calls } = fake(true)
  const run = deps.execFile
  deps.execFile = async (file, args, options) => args[1] === 'list'
    ? JSON.stringify({ ok: true, result: { tabs: [{ browserPageId: 'existing', url: `${origin}/?thread=current` }] } })
    : run(file, args, options)
  await openChat(input, deps)
  assert.deepEqual(calls[0], ['tab', 'switch', '--page', 'existing', '--focus', '--json'])
  assert.equal(calls.some((args) => ['pair', 'goto', 'click'].includes(args[0])), false)
})

test('lost sessions repair on every open without a marker', async () => {
  const { deps, calls } = fake()
  const run = deps.execFile
  let sawPair = false
  deps.execFile = async (file, args, options) => {
    if (args[1] === 'list') sawPair = false
    if (args[0] === 'pair') sawPair = true
    const output = await run(file, args, options)
    return args[0] === 'snapshot' && !sawPair ? 'button "Connect" [ref=e11]' : output
  }
  await openChat(input, deps)
  await openChat(input, deps)
  assert.equal(calls.filter((args) => args[0] === 'pair').length, 2)
})

test('external server pairing screen never pairs or presses Connect', async () => {
  const { deps, calls } = fake()
  assert.deepEqual(await openChat({ ...input, startedByPlugin: false }, deps), { message: 'Sign in to OpenMausBot in the browser tab.' })
  assert.equal(calls.some((args) => ['pair', 'click'].includes(args[0])), false)
})

test('automatic pairing failures are actionable and redact all credentials', async () => {
  for (const stage of ['pair', 'goto', 'click']) {
    const { deps } = fake()
    const run = deps.execFile
    deps.execFile = async (file, args, options) => {
      if (args[0] === stage) throw new Error(secret)
      return run(file, args, options)
    }
    const result = await openChat(input, deps)
    assert.deepEqual(result, { message: 'Press Connect in the browser tab to finish.' })
    assert.doesNotMatch(JSON.stringify(result), /FAKE-SECRET/)
  }
})

test('waiting for Connect and confirmation is bounded, no retry of click', async () => {
  for (const stuck of [true, false]) {
    const { deps, calls } = fake()
    const run = deps.execFile
    let fresh = false
    deps.execFile = async (file, args, options) => {
      const response = await run(file, args, options)
      if (args[0] === 'pair') fresh = true
      if (args[0] === 'snapshot' && fresh) return stuck ? 'button "Connect" [ref=e11]' : 'Loading'
      return response
    }
    assert.match((await openChat(input, deps)).message, /Press Connect/)
    assert.equal(calls.filter((args) => args[0] === 'click').length, stuck ? 1 : 0)
    assert.ok(calls.length < 20)
  }
})

test('ordinary open failures and malformed tab lists are sanitized', async () => {
  const { deps } = fake()
  for (const text of ['not json FAKE-SECRET', '{"ok":false}', '{"ok":true,"result":{"tabs":null}}']) {
    deps.execFile = async () => text
    await assert.rejects(openChat(input, deps), { message: 'Could not open chat. Check Orca and OpenMausBot, then try again.' })
  }
})

test('invalid bot id fails before any subprocess', async () => {
  const { deps, calls } = fake()
  await assert.rejects(openChat({ ...input, botId: 'bad' }, deps), /Invalid bot ID/)
  assert.equal(calls.length, 0)
})

test('delayed pairing screen is detected, and a mismatched pairing link is never opened', async () => {
  const { deps, calls } = fake()
  const run = deps.execFile
  let reads = 0
  deps.execFile = async (file, args, options) => {
    const result = await run(file, args, options)
    if (args[0] === 'snapshot' && ++reads < 4) return 'Loading'
    if (args[0] === 'pair') return 'http://127.0.0.1:28799/pair#code=FAKE-OTHER'
    return result
  }
  assert.match((await openChat(input, deps)).message, /Press Connect/)
  assert.equal(calls.filter((args) => args[0] === 'snapshot').length, 4)
  assert.equal(calls.some((args) => args[0] === 'goto'), false)
})
