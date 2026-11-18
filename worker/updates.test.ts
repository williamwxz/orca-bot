import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { CHECK_EVERY, registerUpdates } from './updates.ts'
import type { UpdateDeps } from './updates.ts'
import { OrcaCliError } from './orca-cli.ts'
import { register } from './worker.ts'
import type { WorkerDeps } from './worker.ts'

type Plugin = { pluginKey: string; isDev: boolean }
function fakeOrca(options: { latest?: string; plugins?: Plugin[]; update?: () => unknown } = {}) {
  let clock = 0
  const asked: string[] = []
  const updated: string[][] = []
  const deps: UpdateDeps = {
    version: async () => '0.1.3',
    latest: async () => {
      asked.push('latest')
      return options.latest
    },
    call: async (args) => {
      if (args[1] === 'list') return { plugins: options.plugins ?? [{ pluginKey: 'williamwxz.bot-for-orca', isDev: false }] }
      if (args[1] === 'update') {
        updated.push(args)
        return options.update?.() ?? {}
      }
      throw new Error(`unexpected ${args.join(' ')}`)
    },
    now: () => clock
  }
  return { deps, asked, updated, tick: (ms: number) => { clock += ms } }
}

test('updates: up to date, available, a development copy, or unknown when GitHub cannot say', async () => {
  for (const [options, state] of [
    [{ latest: '0.1.3' }, 'current'],
    [{ latest: '0.2.0' }, 'available'],
    [{ latest: '0.2.0', plugins: [{ pluginKey: 'williamwxz.bot-for-orca', isDev: false }, { pluginKey: 'local.bot-for-orca', isDev: true }] }, 'dev'],
    [{}, 'unknown']
  ] as const) {
    const orca = fakeOrca(options)
    const worker = await mountWorker({ default: (api) => registerUpdates(api, orca.deps) }, { host: mockHost() })
    try {
      const updates = (await worker.request('updates.get', {})) as { state: string; version: string }
      assert.equal(updates.state, state)
      assert.equal(updates.version, '0.1.3')
    } finally {
      await worker.deactivate()
    }
  }
})

test('updates: GitHub is asked at most every six hours unless the person checks now', async () => {
  const orca = fakeOrca({ latest: '0.1.3' })
  const worker = await mountWorker({ default: (api) => registerUpdates(api, orca.deps) }, { host: mockHost() })
  try {
    await worker.request('updates.get', {})
    await worker.request('updates.get', {})
    assert.equal(orca.asked.length, 1)
    await worker.request('updates.get', { check: true })
    assert.equal(orca.asked.length, 2)
    orca.tick(CHECK_EVERY)
    await worker.request('updates.get', {})
    assert.equal(orca.asked.length, 3)
  } finally {
    await worker.deactivate()
  }
})

test('updates: installing uses Orca, and an update asking for new access waits for approval', async () => {
  const orca = fakeOrca({ latest: '0.2.0', update: () => { throw new OrcaCliError('hidden', 'approval_required') } })
  const worker = await mountWorker({ default: (api) => registerUpdates(api, orca.deps) }, { host: mockHost() })
  try {
    const result = (await worker.request('updates.install', {})) as { state: string; message: string }
    assert.deepEqual(orca.updated, [['plugin', 'update', 'williamwxz.bot-for-orca', '--json']])
    assert.equal(result.state, 'available')
    assert.match(result.message, /asks for new access/)
    assert.doesNotMatch(result.message, /hidden/)
  } finally {
    await worker.deactivate()
  }
  const fine = fakeOrca({ latest: '0.2.0' })
  const updated = await mountWorker({ default: (api) => registerUpdates(api, fine.deps) }, { host: mockHost() })
  try {
    assert.equal(((await updated.request('updates.install', {})) as { state: string }).state, 'updated')
  } finally {
    await updated.deactivate()
  }
})

test('updates: automatic updates install each new version once, and only when switched on', async () => {
  const orca = fakeOrca({ latest: '0.2.0' })
  const host = mockHost()
  const worker = await mountWorker({ default: (api) => registerUpdates(api, orca.deps) }, { host })
  try {
    assert.equal(((await worker.request('updates.get', {})) as { state: string }).state, 'available')
    assert.equal(orca.updated.length, 0)
    assert.equal(((await worker.request('updates.auto', { on: true })) as { state: string }).state, 'updating')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(orca.updated.length, 1)
    assert.equal(host.data().settings.autoUpdate, true)
    assert.equal(host.data().storage.autoUpdateTried, '0.2.0')
    await worker.request('updates.get', { check: true })
    assert.equal(orca.updated.length, 1)
    await assert.rejects(worker.request('updates.auto', {}), /Choose whether/)
  } finally {
    await worker.deactivate()
  }
})

test('permissions can change after setup, and a change answers the setup card', async () => {
  const deps = { findAgents: () => ({ claude: true, codex: false }) } as unknown as WorkerDeps
  const host = mockHost({ settings: { shareClaudeSetup: false, linkAgents: true } })
  const worker = await mountWorker({ default: (api) => register(api, deps) }, { host })
  try {
    assert.deepEqual(await worker.request('prefs.get', {}), { shareTools: false, linkAgents: true, agents: { claude: true, codex: false } })
    const saved = await worker.request('prefs.set', { shareTools: true })
    assert.deepEqual(saved, { shareTools: true, linkAgents: true, agents: { claude: true, codex: false } })
    assert.equal(host.data().settings.shareClaudeSetup, true)
    assert.equal(host.data().storage.setupAnswered, true)
    await assert.rejects(worker.request('prefs.set', { linkAgents: 'yes' } as never), /Choose a setting/)
    assert.equal(host.data().settings.linkAgents, true)
  } finally {
    await worker.deactivate()
  }
})
