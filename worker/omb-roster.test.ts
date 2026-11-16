import { assert, test } from 'orca/testing'
import { listBots, addMausBot, rosterBusy } from './omb-roster.ts'
import type { HttpDeps } from './omb-http.ts'
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const bot = {
  id,
  name: 'Helper',
  title: '',
  chiefOfStaff: false,
  busy: false,
  modelSelection: { instanceId: 'codex', model: 'gpt-6' }
}
function fake(bots: unknown[]) {
  const calls: unknown[] = []
  const deps: HttpDeps = {
    request: async (port, path, patch) => {
      calls.push({ port, path, patch })
      return { bots }
    },
    avatar: async () => 'data:image/png;base64,ZmFrZQ=='
  }
  return { deps, calls }
}

test('roster uses explicit visibility, not missing activity or main badge', async () => {
  const { deps } = fake([
    bot,
    { ...bot, name: 'Hidden', hidden: true },
    { ...bot, name: 'MausBot', chiefOfStaff: true, defaultBot: {}, sidebarHidden: true },
    { ...bot, name: 'Visible main', chiefOfStaff: true, defaultBot: {}, sidebarHidden: false },
    { ...bot, name: 'Other person', defaultBot: { person: 'someone' } }
  ])
  const result = await listBots({ port: 18799 }, deps)
  assert.deepEqual(
    result.filter((item) => !item.addable).map((item) => item.name),
    ['Visible main', 'Helper']
  )
  assert.equal(result.find((item) => item.name === 'MausBot')?.addable, true)
})

test('raw fleet route carries thread, activity states and bounded avatar data', async () => {
  const { deps, calls } = fake([
    {
      ...bot,
      busy: true,
      waitingForTeammates: true,
      threadId: 'thread',
      avatarUrl: '/api/attachments/fake.png'
    },
    { ...bot, activity: 'waiting-on-you' }
  ])
  const result = await listBots({ port: 18799 }, deps)
  assert.deepEqual(calls, [{ port: 18799, path: '/api/bots?messages=0', patch: undefined }])
  assert.equal(result[0].state, 'working')
  assert.equal(result[1].state, 'waiting')
  assert.equal(result[0].activeTaskId, 'thread')
  assert.match(result[0].avatar!, /^data:image\/png/)
  assert.equal(result[0].model, 'codex/gpt-6')
  assert.equal(result[0].modelLabel, 'GPT-6')
  deps.avatar = async () => {
    throw new Error('missing')
  }
  assert.equal((await listBots({ port: 18799 }, deps))[0].avatar, undefined)
})

test('Add MausBot rechecks hidden default and sends the exact UI welcome patch once', async () => {
  const { deps, calls } = fake([{ ...bot, defaultBot: {}, sidebarHidden: true }])
  await addMausBot({ port: 18799, botId: id }, deps)
  assert.deepEqual(calls[1], {
    port: 18799,
    path: `/api/bots/${id}`,
    patch: { welcomed: true, sidebarHidden: false, pinned: true }
  })
  const visible = fake([bot])
  await assert.rejects(addMausBot({ port: 18799, botId: id }, visible.deps), /no longer hidden/)
  assert.equal(visible.calls.length, 1)
})

test('malformed and failed roster responses show a plain error', async () => {
  for (const bots of [[null], [{ ...bot, id: 'bad' }], [{ ...bot, modelSelection: null }]]) {
    await assert.rejects(listBots({ port: 18799 }, fake(bots).deps), /Could not refresh bots/)
  }
})

test('model labels prefer supplied labels, remove instance prefix and only capitalise GPT', async () => {
  for (const [selection, label, expected] of [
    [{ model: 'gpt-6.1-sol' }, undefined, 'GPT-6.1-sol'],
    [{ model: 'codex/gpt-6' }, undefined, 'GPT-6'],
    [{ model: 'claude-custom' }, undefined, 'claude-custom'],
    [{ model: 'id', label: 'Claude Sonnet' }, undefined, 'Claude Sonnet'],
    [{ model: 'id' }, 'Friendly model', 'Friendly model']
  ] as const) {
    const { deps, calls } = fake([
      { ...bot, modelSelection: { instanceId: 'codex', ...selection }, modelLabel: label }
    ])
    assert.equal((await listBots({ port: 18799 }, deps))[0].modelLabel, expected)
    assert.equal(calls.length, 1)
  }
})

test('restart safety includes hidden bots and fails closed on roster errors', async () => {
  for (const activity of [{ busy: true }, { waitingForTeammates: true }, { activity: 'waiting-on-you' }]) {
    assert.equal(await rosterBusy(18799, fake([{ ...bot, hidden: true, ...activity }]).deps), true)
  }
  assert.equal(await rosterBusy(18799, fake([bot]).deps), false)
  const { deps } = fake([])
  deps.request = async () => {
    throw new Error('offline')
  }
  assert.equal(await rosterBusy(18799, deps), true)
})
