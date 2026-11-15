import { assert, test } from 'orca/testing'
import { openChat, repairChat } from './omb-open.ts'
import type { CliDeps } from './omb-cli.ts'

const origin = 'http://127.0.0.1:18799'
const secret = `${origin}/pair#code=FAKE-SECRET`
const input = { port: 18799, startedByPlugin: true }
function fake(paired = false, value: string | null = null) {
  const calls: string[][] = []
  const deps: CliDeps = {
    userInfo: () => ({ username: 'fake-user', shell: '/fake/shell' }), home: '/fake', platform: 'darwin', env: {}, exists: () => true, sleep: async () => {},
    execFile: async (_file, args) => {
      calls.push(args)
      if (args[0] === 'storage') return JSON.stringify({ ok: true, result: { value } })
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
    ['tab', 'create', '--url', `${origin}/api/health`, '--json'],
    ['storage', 'local', 'get', '--key', 'omb-analytics-opt-out', '--page', 'page-1', '--json'],
    ['storage', 'local', 'set', '--key', 'omb-analytics-opt-out', '--value', '1', '--page', 'page-1', '--json'],
    ['goto', '--url', wanted, '--page', 'page-1', '--json'],
    ['snapshot', '--page', 'page-1'],
    ['pair', '--label', 'Orca', '--port', '18799', '--data-dir', '/fake/.orca-bot/data'],
    ['goto', '--url', secret, '--page', 'page-1', '--json'],
    ['snapshot', '--page', 'page-1'],
    ['click', '--element', 'e11', '--page', 'page-1', '--json'],
    ['snapshot', '--page', 'page-1'],
    ['goto', '--url', wanted, '--page', 'page-1', '--json'],
    ['snapshot', '--page', 'page-1']
  ])
})

test('no pairing on a signed-in tab, preserving its conversation', async () => {
  const { deps, calls } = fake(true, '1')
  const run = deps.execFile
  deps.execFile = async (file, args, options) => args[1] === 'list'
    ? JSON.stringify({ ok: true, result: { tabs: [{ browserPageId: 'existing', url: `${origin}/?thread=current` }] } })
    : run(file, args, options)
  await openChat(input, deps)
  assert.deepEqual(calls[1], ['tab', 'switch', '--page', 'existing', '--focus', '--json'])
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
  assert.equal(calls.some((args) => ['pair', 'click', 'storage'].includes(args[0])), false)
})

test('automatic pairing failures are actionable and redact all credentials', async () => {
  for (const stage of ['pair', 'goto', 'click']) {
    const { deps } = fake()
    const run = deps.execFile
    deps.execFile = async (file, args, options) => {
      if (args[0] === stage && (stage !== 'goto' || args[2] === secret)) throw new Error(secret)
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
    assert.ok(calls.length < 24)
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
  assert.deepEqual(calls.filter((args) => args[0] === 'goto'), [['goto', '--url', `${origin}/`, '--page', 'page-1', '--json']])
})

test('new owned tab checks analytics before loading the requested app and preserves choices', async () => {
  for (const value of [null, '0', '1']) {
    const { deps, calls } = fake(true, value)
    const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const wanted = `${origin}/?thread=task-1&bot=${botId}`
    await openChat({ ...input, botId, activeTaskId: 'task-1' }, deps)
    assert.deepEqual(calls.slice(0, value === null ? 5 : 4), [
      ['tab', 'list', '--json'],
      ['tab', 'create', '--url', `${origin}/api/health`, '--json'],
      ['storage', 'local', 'get', '--key', 'omb-analytics-opt-out', '--page', 'page-1', '--json'],
      ...(value === null ? [['storage', 'local', 'set', '--key', 'omb-analytics-opt-out', '--value', '1', '--page', 'page-1', '--json']] : []),
      ['goto', '--url', wanted, '--page', 'page-1', '--json']
    ])
    assert.equal(calls.filter((args) => args[0] === 'storage' && args[2] === 'set').length, value === null ? 1 : 0)
  }
})

test('existing owned tab defaults analytics off and reloads the conversation or safe requested address', async () => {
  const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  for (const current of [`${origin}/?thread=current`, `${origin}/pair#fake`]) {
    for (const requested of [false, true]) {
      const { deps, calls } = fake(true)
      const run = deps.execFile
      deps.execFile = async (file, args, options) => args[1] === 'list'
        ? JSON.stringify({ ok: true, result: { tabs: [{ browserPageId: 'existing', url: current }] } })
        : run(file, args, options)
      await openChat({ ...input, ...(requested ? { botId, activeTaskId: 'task-1' } : {}) }, deps)
      const wanted = requested ? `${origin}/?thread=task-1&bot=${botId}` : current.includes('/pair') ? `${origin}/` : current
      assert.deepEqual(calls.slice(0, 4), [
        ['storage', 'local', 'get', '--key', 'omb-analytics-opt-out', '--page', 'existing', '--json'],
        ['storage', 'local', 'set', '--key', 'omb-analytics-opt-out', '--value', '1', '--page', 'existing', '--json'],
        ['goto', '--url', wanted, '--page', 'existing', '--json'],
        ['tab', 'switch', '--page', 'existing', '--focus', '--json']
      ])
    }
  }
})

test('storage failures on new or existing owned tabs fail closed with a generic error', async () => {
  for (const existing of [false, true]) {
    for (const stage of ['get', 'set', 'malformed']) {
      const { deps, calls } = fake(true)
      const run = deps.execFile
      deps.execFile = async (file, args, options) => {
        if (existing && args[1] === 'list') return JSON.stringify({ ok: true, result: { tabs: [{ browserPageId: 'existing', url: `${origin}/` }] } })
        if (args[0] === 'storage') {
          if (args[2] === stage) throw new Error('private failure details')
          if (stage === 'malformed') return '{"ok":true,"result":{}}'
        }
        return run(file, args, options)
      }
      await assert.rejects(openChat(input, deps), { message: 'Could not open chat. Check Orca and OpenMausBot, then try again.' })
      assert.equal(calls.some((args) => ['goto', 'snapshot', 'pair', 'click'].includes(args[0])), false)
      assert.equal(calls.some((args) => args[0] === 'tab' && args[1] === 'create' && args[3] !== `${origin}/api/health`), false)
    }
  }
})

test('unowned new and existing tabs never access storage', async () => {
  for (const existing of [false, true]) {
    const { deps, calls } = fake(true)
    const run = deps.execFile
    deps.execFile = async (file, args, options) => existing && args[1] === 'list'
      ? JSON.stringify({ ok: true, result: { tabs: [{ browserPageId: 'existing', url: `${origin}/?thread=current` }] } })
      : run(file, args, options)
    await openChat({ ...input, startedByPlugin: false }, deps)
    assert.equal(calls.some((args) => args[0] === 'storage'), false)
    assert.equal(calls.some((args) => args[0] === 'goto'), false)
    if (!existing) assert.deepEqual(calls[1], ['tab', 'create', '--url', `${origin}/`, '--json'])
  }
})

function existingFake(paired = false, url = `${origin}/?thread=current`, value: string | null = '1') {
  const f = fake(paired, value)
  const run = f.deps.execFile
  f.deps.execFile = async (file, args, options) => {
    if (args[1] === 'list') {
      f.calls.push(args)
      return JSON.stringify({ ok: true, result: { tabs: [{ browserPageId: 'existing', url }] } })
    }
    return run(file, args, options)
  }
  return f
}

test('background repair pairs an existing tab without focus and restores a safe address', async () => {
  for (const url of [`${origin}/?thread=current`, `${origin}/pair#old-secret`]) {
    for (const value of [null, '0', '1']) {
      const { deps, calls } = existingFake(false, url, value)
      assert.equal(await repairChat(input, deps), true)
      const wanted = url.includes('/pair') ? `${origin}/` : url
      assert.equal(calls.some(args => args.includes('--focus') || ['create', 'switch'].includes(args[1])), false)
      assert.deepEqual(calls.filter(args => args[0] === 'goto').at(-1), ['goto', '--url', wanted, '--page', 'existing', '--json'])
      const firstGoto = calls.findIndex(args => args[0] === 'goto')
      assert.ok(calls.findIndex(args => args[0] === 'storage') < firstGoto)
      assert.equal(calls.filter(args => args[0] === 'storage' && args[2] === 'set').length, value === null ? 1 : 0)
      assert.equal(calls.filter(args => args[0] === 'pair').length, 1)
    }
  }
})

test('background repair does nothing for absent, foreign, signed-in or unowned tabs', async () => {
  for (const mode of ['absent', 'foreign', 'signed-in', 'unowned']) {
    const { deps, calls } = mode === 'absent' ? fake() : existingFake(mode === 'signed-in', mode === 'foreign' ? 'http://127.0.0.1:9999/' : `${origin}/`)
    assert.equal(await repairChat({ ...input, startedByPlugin: mode !== 'unowned' }, deps), true)
    assert.equal(calls.some(args => ['goto', 'pair', 'click', 'storage'].includes(args[0]) || args[1] === 'create'), false)
    if (mode === 'unowned') assert.equal(calls.length, 0)
  }
})

test('background failures expose only false, including storage, pairing and confirmation failures', async () => {
  for (const stage of ['list', 'snapshot', 'storage', 'pair', 'goto', 'click', 'confirmation']) {
    const { deps, calls } = existingFake()
    const run = deps.execFile
    deps.execFile = async (file, args, options) => {
      if (args[0] === stage || args[1] === stage) throw new Error(secret)
      const result = await run(file, args, options)
      if (stage === 'confirmation' && args[0] === 'snapshot') return 'button "Connect" [ref=e11]'
      return result
    }
    assert.equal(await repairChat(input, deps), false)
    if (stage === 'storage') assert.equal(calls.some(args => ['goto', 'pair', 'click'].includes(args[0])), false)
  }
})

test('background repair waits for enabled Connect before clicking', async () => {
  const { deps, calls } = existingFake()
  const run = deps.execFile
  let pairing = false, reads = 0
  deps.execFile = async (file, args, options) => {
    const result = await run(file, args, options)
    if (args[0] === 'pair') pairing = true
    if (pairing && args[0] === 'snapshot' && ++reads < 3) return 'button "Connect" [disabled ref=e11]'
    return result
  }
  assert.equal(await repairChat(input, deps), true)
  assert.equal(calls.filter(args => args[0] === 'click').length, 1)
  assert.ok(reads >= 3)
})
