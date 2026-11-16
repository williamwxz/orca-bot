import { test, assert } from 'orca/testing'
import { defaultLinkDeps, findAgents, syncAgentLinks } from './agent-link.ts'
import type { LinkDeps } from './agent-link.ts'

function fake(agents = ['claude', 'codex']) {
  let record: string | undefined
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const deps: LinkDeps = {
    home: '/fake',
    platform: 'darwin',
    env: { PATH: '/fake/bin' },
    userInfo: () => ({ username: 'fake', shell: '/fake/sh' }),
    bin: '/fake/pinned/openmausbot',
    exists: (path) => agents.some((agent) => path === `/fake/bin/${agent}`),
    read: () => record,
    write: (value) => {
      record = value
    },
    execFile: async (file, args, env) => {
      calls.push({ file, args, env })
    },
    codexEntryExists: async () => false,
    claudeEnv: () => ({ PATH: '/fake/bin', CLAUDE_CONFIG_DIR: '/fake/profile' })
  }
  return { deps, calls, record: () => JSON.parse(record ?? '{}') }
}
const input = { enabled: true, owned: true, port: 8799 }

test('link defaults refuse real effects in tests', () => {
  assert.throws(defaultLinkDeps, /inject/)
})
test('agents are found on child PATH and missing programs are skipped', async () => {
  const { deps, calls } = fake(['codex'])
  assert.deepEqual(findAgents(deps), { claude: false, codex: true, opencode: false, antigravity: false })
  await syncAgentLinks(input, deps)
  assert.equal(calls.length, 1)
  const empty = fake([])
  assert.deepEqual(findAgents(empty.deps), {
    claude: false,
    codex: false,
    opencode: false,
    antigravity: false
  })
  await syncAgentLinks(input, empty.deps)
  assert.equal(empty.calls.length, 0)
})
test('adds exact agent commands and records only port and bin', async () => {
  const { deps, calls, record } = fake()
  await syncAgentLinks(input, deps)
  assert.deepEqual(
    calls.map((call) => [call.file, call.args]),
    [
      [
        '/fake/bin/claude',
        ['mcp', 'add', '--scope', 'user', 'orca-bot', '-e', 'OMB_PORT=8799', '--', deps.bin, 'mcp']
      ],
      ['/fake/bin/codex', ['mcp', 'add', 'orca-bot', '--env', 'OMB_PORT=8799', '--', deps.bin, 'mcp']]
    ]
  )
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, '/fake/profile')
  assert.deepEqual(record(), { claude: { port: 8799, bin: deps.bin }, codex: { port: 8799, bin: deps.bin } })
})
test('matching record is a no-op', async () => {
  const { deps, calls } = fake()
  await syncAgentLinks(input, deps)
  calls.length = 0
  deps.codexEntryExists = async () => {
    throw new Error('must not inspect')
  }
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
    assert.deepEqual(
      calls.map((call) => call.args[1]),
      ['remove', 'add', 'remove', 'add']
    )
    assert.deepEqual(record().codex, { port: next.port, bin: deps.bin })
  }
})
test('unlink removes only recorded orca-bot entries', async () => {
  const { deps, calls, record } = fake()
  deps.read = () => JSON.stringify({ claude: { port: 8799, bin: deps.bin } })
  await syncAgentLinks({ ...input, enabled: false }, deps)
  assert.deepEqual(
    calls.map((call) => call.args),
    [['mcp', 'remove', '--scope', 'user', 'orca-bot']]
  )
  assert.deepEqual(record(), {})
})
test('unowned servers never read records or run commands', async () => {
  const { deps, calls } = fake()
  deps.read = () => {
    throw new Error('must not read')
  }
  await syncAgentLinks({ ...input, owned: false }, deps)
  await syncAgentLinks({ ...input, owned: false, enabled: false }, deps)
  assert.deepEqual(calls, [])
})
test('existing unrecorded Codex orca-bot entry is preserved', async () => {
  const { deps, calls } = fake(['codex'])
  deps.codexEntryExists = async () => true
  await assert.rejects(syncAgentLinks(input, deps), { message: 'Could not add Bot Team for Orca to Codex.' })
  assert.deepEqual(calls, [])
})
test('failures contain only the generic agent sentence and preserve successful entries', async () => {
  const { deps, record } = fake()
  deps.execFile = async (file) => {
    if (file.endsWith('codex')) throw new Error('private-output')
  }
  await assert.rejects(syncAgentLinks(input, deps), { message: 'Could not add Bot Team for Orca to Codex.' })
  assert.deepEqual(record(), { claude: { port: 8799, bin: deps.bin } })
})
test('corrupt ownership record fails closed', async () => {
  const { deps, calls } = fake()
  deps.read = () => '{bad record'
  await assert.rejects(syncAgentLinks(input, deps), { message: 'Could not read Bot Team for Orca setup.' })
  assert.deepEqual(calls, [])
})

for (const [agent, program, label] of [
  ['opencode', 'opencode', 'opencode'],
  ['antigravity', 'agy', 'Antigravity']
] as const) {
  test(`${label}: add, matching no-op, changed port and binary, unlink`, async () => {
    const { deps, calls, record } = fake([program])
    let config = JSON.stringify({ theme: 'keep', mcp: { servers: { other: { command: ['keep'] } } } })
    deps.readConfig = () => config
    deps.replaceConfig = (_path, value) => {
      config = value
    }
    deps.listAgent = async () => 'No MCP servers configured.\n'
    const exec = deps.execFile
    deps.execFile = async (file, args, env) => {
      await exec(file, args, env)
      if (agent === 'opencode') {
        const raw = JSON.parse(config)
        raw.mcp.servers['orca-bot'] = { type: 'local', command: [deps.bin, 'mcp'] }
        config = JSON.stringify(raw)
      }
    }
    assert.equal(findAgents(deps)[agent], true)
    await syncAgentLinks(input, deps)
    assert.deepEqual(
      calls[0].args,
      agent === 'opencode'
        ? ['mcp', 'add', '--global', '--env', 'OMB_PORT=8799', 'orca-bot', '--', deps.bin, 'mcp']
        : ['mcp', 'add', '-e', 'OMB_PORT=8799', 'orca-bot', deps.bin, 'mcp']
    )
    assert.deepEqual(record()[agent], { port: input.port, bin: deps.bin })
    calls.length = 0
    await syncAgentLinks(input, deps)
    assert.equal(calls.length, 0)
    await syncAgentLinks({ ...input, port: 1234 }, deps)
    assert.deepEqual(record()[agent], { port: 1234, bin: deps.bin })
    deps.bin = '/fake/changed/openmausbot'
    await syncAgentLinks(input, deps)
    assert.deepEqual(record()[agent], { port: input.port, bin: deps.bin })
    calls.length = 0
    await syncAgentLinks({ ...input, enabled: false }, deps)
    assert.deepEqual(record(), {})
    if (agent === 'opencode') {
      assert.equal(calls.length, 0)
      assert.deepEqual(JSON.parse(config), {
        theme: 'keep',
        mcp: { servers: { other: { command: ['keep'] } } }
      })
      assert.equal(config, JSON.stringify(JSON.parse(config), null, 2) + '\n')
    } else assert.deepEqual(calls[0].args, ['mcp', 'remove', 'orca-bot'])
  })
  test(`${label}: foreign entry and errors never expose tokens`, async () => {
    const { deps, calls } = fake([program])
    deps.readConfig = () =>
      JSON.stringify({ mcp: { servers: { 'orca-bot': { command: ['SECRET_FAKE_TOKEN'] } } } })
    deps.listAgent = async () => 'orca-bot SECRET_FAKE_TOKEN'
    await assert.rejects(syncAgentLinks(input, deps), {
      message: `Could not add Bot Team for Orca to ${label}.`
    })
    assert.deepEqual(calls, [])
    deps.readConfig = () => {
      throw new Error('SECRET_FAKE_TOKEN')
    }
    deps.listAgent = async () => {
      throw new Error('SECRET_FAKE_TOKEN')
    }
    await assert.rejects(syncAgentLinks(input, deps), (error) => !String(error).includes('SECRET_FAKE_TOKEN'))
  })
}
test('opencode removal supports legacy and V2, preserves other keys and refuses comments or mismatches', async () => {
  for (const v2 of [false, true]) {
    for (const kind of ['valid', 'comments', 'mismatch', 'missing', 'extra-args', 'invalid-servers']) {
      const { deps, record } = fake(['opencode'])
      deps.write(JSON.stringify({ opencode: { port: 8799, bin: deps.bin } }))
      const entries = {
        other: { url: 'https://fake/SECRET_FAKE_TOKEN' },
        ...(kind === 'missing'
          ? {}
          : {
              'orca-bot': {
                type: 'local',
                command: [
                  kind === 'mismatch' ? 'foreign' : deps.bin,
                  'mcp',
                  ...(kind === 'extra-args' ? ['extra'] : [])
                ]
              }
            })
      }
      const raw = { keep: ['yes'], mcp: v2 ? { servers: entries, extra: true } : entries }
      if (kind === 'invalid-servers') (raw.mcp as any).servers = null
      let config = (kind === 'comments' ? '// comment\n' : '') + JSON.stringify(raw)
      const before = config
      deps.readConfig = () => config
      deps.replaceConfig = (_path, value) => {
        config = value
      }
      if (kind !== 'valid') {
        await assert.rejects(syncAgentLinks({ ...input, enabled: false }, deps), {
          message: 'Remove orca-bot from opencode by hand.'
        })
        assert.equal(config, before)
        assert.ok(record().opencode)
      } else {
        await syncAgentLinks({ ...input, enabled: false }, deps)
        delete (entries as any)['orca-bot']
        assert.deepEqual(JSON.parse(config), raw)
        assert.deepEqual(record(), {})
      }
    }
  }
})
test('opencode V2 takes precedence and malformed config fails closed before add', async () => {
  for (const raw of [
    '// comment',
    '{',
    JSON.stringify({ mcp: { servers: null } }),
    JSON.stringify({ mcp: { servers: { 'orca-bot': {} } } })
  ]) {
    const { deps, calls } = fake(['opencode'])
    deps.readConfig = () => raw
    await assert.rejects(syncAgentLinks(input, deps), /Could not add/)
    assert.equal(calls.length, 0)
  }
})

test('atomic config replacement preserves mode and cleans up on failed rename using only fakes', async () => {
  const { replaceConfigAtomically } = await import('./agent-config.ts')
  for (const fail of [false, true]) {
    const calls: unknown[] = []
    const io = {
      statSync: (path: string) => {
        calls.push(['stat', path])
        return { mode: 0o100640 }
      },
      writeFileSync: (path: string, value: string, options: unknown) => {
        calls.push(['write', path, value, options])
      },
      chmodSync: (path: string, mode: number) => {
        calls.push(['chmod', path, mode])
      },
      renameSync: (from: string, to: string) => {
        calls.push(['rename', from, to])
        if (fail) throw new Error('fake')
      },
      unlinkSync: (path: string) => {
        calls.push(['unlink', path])
      }
    }
    const run = () => replaceConfigAtomically('/fake/config', '{}', '/fake/temp', io)
    if (fail) assert.throws(run, /fake/)
    else run()
    assert.deepEqual(calls, [
      ['stat', '/fake/config'],
      ['write', '/fake/temp', '{}', { flag: 'wx', mode: 0o640 }],
      ['chmod', '/fake/temp', 0o640],
      ['rename', '/fake/temp', '/fake/config'],
      ['unlink', '/fake/temp']
    ])
  }
})
