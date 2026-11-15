import { mock } from 'node:test'
import { assert, test } from 'orca/testing'
import { openChat, signInAgain } from './omb-open.ts'
import type { CliDeps } from './omb-cli.ts'

const mac = '/Applications/Orca.app/Contents/Resources/bin/orca'
const origin = 'http://127.0.0.1:18799'
const secret = `${origin}/pair#code=FAKE-SECRET`
const input = { port: 18799, startedByPlugin: true }

function fake() {
  const calls: { file: string; args: string[]; timeout: number }[] = []
  const files = new Map<string, string>()
  const modes: number[] = []
  const deps: CliDeps = {
    home: '/fake', platform: 'darwin', env: { PATH: '/bin' },
    exists: (path) => path === mac,
    fileExists: (path) => files.has(path),
    write: (path, value, mode) => {
      files.set(path, value)
      modes.push(mode)
    },
    execFile: async (file, args, options) => {
      calls.push({ file, args, timeout: options.timeout })
      if (args[0] === 'pair') return `Sign in:\n${secret}\nConnect once`
      if (args[1] === 'list') return JSON.stringify({ ok: true, result: { tabs: [] } })
      return JSON.stringify({ ok: true, result: { browserPageId: 'page-1' } })
    }
  }
  return { deps, calls, files, modes }
}

test('first open pairs, creates tab with exact arguments and writes a private non-secret marker', async () => {
  const { deps, calls, files, modes } = fake()
  assert.deepEqual(await openChat(input, deps), { message: 'Opened in an Orca browser tab.' })
  assert.deepEqual(calls.map((call) => call.args), [
    ['tab', 'list', '--json'],
    ['pair', '--label', 'Orca', '--port', '18799', '--data-dir', '/fake/.bot-deck/data'],
    ['tab', 'create', '--url', secret, '--json']
  ])
  assert.equal(calls[0].file, mac)
  assert.match(calls[1].file, /\/node_modules\/\.bin\/openmausbot$/)
  assert.deepEqual(modes, [0o600])
  assert.doesNotMatch(files.get('/fake/.bot-deck/browser-signed-in')!, /FAKE-SECRET|pair#/)
  calls.length = 0
  await openChat(input, deps)
  assert.deepEqual(calls.map((call) => call.args), [['tab', 'list', '--json'], ['tab', 'create', '--url', `${origin}/`, '--json']])
})

test('existing same-origin tab is navigated and focused, including a pairing tab', async () => {
  const { deps, calls } = fake()
  const exec = deps.execFile
  deps.execFile = async (file, args, options) => {
    const result = await exec(file, args, options)
    if (args[1] === 'list') return JSON.stringify({ ok: true, result: { tabs: [
      { browserPageId: 'wrong', url: `${origin}0/` },
      { browserPageId: 'existing', url: secret }
    ] } })
    return result
  }
  await openChat({ ...input, startedByPlugin: false }, deps)
  assert.deepEqual(calls.map((call) => call.args), [
    ['tab', 'list', '--json'],
    ['goto', '--url', `${origin}/`, '--page', 'existing', '--json'],
    ['tab', 'switch', '--page', 'existing', '--focus', '--json']
  ])
})

test('external servers never pair, including sign in again', async () => {
  const { deps, calls, files } = fake()
  await openChat({ ...input, startedByPlugin: false }, deps)
  await signInAgain({ ...input, startedByPlugin: false }, deps)
  assert.equal(calls.some((call) => call.args[0] === 'pair'), false)
  assert.equal(files.size, 0)
})

test('sign in again always pairs for plugin-owned servers even with a marker', async () => {
  const { deps, calls } = fake()
  await openChat(input, deps)
  await signInAgain(input, deps)
  await signInAgain(input, deps)
  assert.equal(calls.filter((call) => call.args[0] === 'pair').length, 3)
})

test('every subprocess failure is sanitized and never saves a marker', async () => {
  for (const stage of ['list', 'pair', 'create']) {
    const { deps, files } = fake()
    const exec = deps.execFile
    deps.execFile = async (file, args, options) => {
      if (args.includes(stage)) throw new Error(`stdout stderr argv ${secret}`)
      return exec(file, args, options)
    }
    await assert.rejects(openChat(input, deps), (error: Error) => {
      assert.doesNotMatch(error.stack!, /FAKE-SECRET|pair#/)
      assert.equal(error.cause, undefined)
      assert.match(error.message, /Could not open chat/)
      return true
    })
    assert.equal(files.size, 0)
  }
})

test('malformed CLI output and wrong-origin sign-in links fail without leaking credentials', async () => {
  for (const output of ['garbage FAKE-SECRET', 'https://example.invalid/pair#code=FAKE-SECRET', 'http://127.0.0.1:28799/pair#code=FAKE-SECRET']) {
    const { deps } = fake()
    const exec = deps.execFile
    deps.execFile = async (file, args, options) => args[0] === 'pair' ? output : exec(file, args, options)
    await assert.rejects(openChat(input, deps), /Could not open chat/)
  }
})

test('PATH fallback works and missing Orca gives a clear error', async () => {
  const { deps, calls } = fake()
  deps.platform = 'linux'
  deps.exists = (path) => path === '/bin/orca'
  await openChat({ ...input, startedByPlugin: false }, deps)
  assert.equal(calls[0].file, '/bin/orca')
  deps.exists = () => false
  await assert.rejects(openChat(input, deps), /Orca CLI was not found/)
})

test('invalid bot IDs fail before commands, valid IDs use verified main UI fallback', async () => {
  const { deps, calls } = fake()
  await assert.rejects(openChat({ ...input, botId: 'bad' }, deps), /Invalid bot ID/)
  assert.equal(calls.length, 0)
  await openChat({ ...input, startedByPlugin: false, botId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, deps)
  assert.deepEqual(calls[1].args, ['tab', 'create', '--url', `${origin}/`, '--json'])
})


test('pairing credentials never reach console logs or returned values', async () => {
  const logs = ['log', 'info', 'warn', 'error', 'debug'] as const
  const spies = logs.map((name) => mock.method(console, name, () => {}))
  try {
    const { deps } = fake()
    const result = await openChat(input, deps)
    assert.doesNotMatch(JSON.stringify(result), /FAKE-SECRET|pair#/)
    deps.write = () => { throw new Error(secret) }
    await assert.rejects(signInAgain(input, deps), (error: Error) => {
      assert.doesNotMatch(error.stack!, /FAKE-SECRET|pair#/)
      return true
    })
    assert.ok(spies.every((spy) => spy.mock.callCount() === 0))
  } finally {
    for (const spy of spies) spy.mock.restore()
  }
})

test('CLI failure envelopes and malformed tab lists do not create tabs or leak output', async () => {
  for (const output of [JSON.stringify({ ok: false, error: secret }), JSON.stringify({ ok: true, result: { tabs: secret } }), 'bad json']) {
    const { deps } = fake()
    let calls = 0
    deps.execFile = async () => {
      calls++
      return output
    }
    await assert.rejects(openChat(input, deps), { message: 'Could not open chat. Check Orca and OpenMausBot, then try again.' })
    assert.equal(calls, 1)
  }
})
