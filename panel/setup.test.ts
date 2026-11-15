import { test, assert } from 'orca/testing'
import { createSetup, agentNames } from './setup.ts'

test('setup starts checked and shows the found agent names', () => {
  const setup = createSetup(async () => {})
  assert.equal(setup.state.shareTools, true)
  assert.equal(setup.state.linkAgents, true)
  assert.equal(setup.state.loaded, false)
  for (const [agents, name] of [
    [{ claude: true, codex: true }, 'Claude and Codex'],
    [{ claude: true, codex: false }, 'Claude'],
    [{ claude: false, codex: true }, 'Codex'],
    [{ claude: false, codex: false }, '']
  ] as const) assert.equal(agentNames(agents), name)
})
test('Allow sends checked options, hides after success, and ignores repeat answers', async () => {
  const calls: unknown[] = []
  const setup = createSetup(async (answer) => { calls.push(answer) })
  setup.load({ answered: false, agents: { claude: true, codex: true } })
  setup.state.shareTools = false
  await setup.answer(true)
  await setup.answer(false)
  assert.deepEqual(calls, [{ shareTools: false, linkAgents: true }])
  assert.equal(setup.state.answered, true)
})
test('Not now disables both; no installed agents disables linking', async () => {
  for (const allow of [false, true]) {
    const calls: unknown[] = []
    const setup = createSetup(async (answer) => { calls.push(answer) })
    setup.load({ answered: false, agents: { claude: false, codex: false } })
    await setup.answer(allow)
    assert.deepEqual(calls, [{ shareTools: allow, linkAgents: false }])
  }
})
test('applying disables repeats, shows progress, and failures keep the card for retry', async () => {
  let fail!: () => void
  let calls = 0
  const setup = createSetup(() => { calls++; return new Promise((_, reject) => { fail = () => reject(new Error('private-output')) }) })
  setup.load({ answered: false, agents: { claude: true, codex: true } })
  const pending = setup.answer(true)
  assert.equal(setup.state.busy, true)
  assert.equal(setup.state.message, 'Setting up…')
  await setup.answer(false)
  assert.equal(calls, 1)
  fail(); await pending
  assert.equal(setup.state.busy, false)
  assert.equal(setup.state.answered, false)
  assert.equal(setup.state.message, 'Could not finish setup. Please try again.')
})

test('import row starts on, imports only visible checked tools after setup, and hides even on import failure', async () => {
  for (const mode of ['success', 'failure', 'partial', 'off', 'empty', 'skip']) {
    const calls: string[] = []
    const setup = createSetup(async () => { calls.push('setup') }, async () => {
      calls.push('import')
      if (mode === 'failure') throw new Error('SECRET_FAKE_TOKEN_789')
      return { added: [], skipped: mode === 'partial' ? [{ name: 'test', reason: 'failed' }] : [] }
    })
    assert.equal(setup.state.importTools, true)
    assert.deepEqual(setup.state.tools, [])
    setup.load({ answered: false, agents: { claude: true, codex: false } })
    if (mode !== 'empty') setup.loadTools([{ name: 'test', source: 'Cursor' }])
    if (mode === 'off') setup.state.importTools = false
    await setup.answer(mode !== 'skip')
    assert.deepEqual(calls, ['off', 'empty', 'skip'].includes(mode) ? ['setup'] : ['setup', 'import'])
    assert.equal(setup.state.answered, true)
    assert.equal(setup.state.message.includes('SECRET_FAKE_TOKEN_789'), false)
    if (['failure', 'partial'].includes(mode)) assert.match(setup.state.message, /could not be imported or switched off/)
  }
})
