import { assert, test } from 'orca/testing'
import { mainFirst, stateLabel } from './roster.ts'

test('panel labels omit idle and use plain state names', () => {
  assert.equal(stateLabel('working'), 'Working')
  assert.equal(stateLabel('waiting'), 'Waiting')
  assert.equal(stateLabel('idle'), '')
})

test('main ordering preserves server order without mutating it', () => {
  const bots = [
    { main: false, name: 'A' },
    { main: true, name: 'B' },
    { main: false, name: 'C' }
  ]
  assert.deepEqual(
    mainFirst(bots).map((bot) => bot.name),
    ['B', 'A', 'C']
  )
  assert.equal(bots[0].name, 'A')
})

test('dragging a bot to a group pins, unpins, regroups or ungroups only as needed', async () => {
  const { dropActions, modelText } = await import('./roster.ts')
  const base = { id: 'a', name: 'A', title: '', main: false, state: 'idle', unread: false, modelLabel: 'm' } as const
  assert.deepEqual(dropActions({ ...base }, { kind: 'pinned' }), [{ botId: 'a', action: 'pin', pinned: true }])
  assert.deepEqual(dropActions({ ...base, pinned: true }, { kind: 'pinned' }), [])
  assert.deepEqual(dropActions({ ...base, pinned: true, section: 'Ops' }, { kind: 'section', name: 'Ops' }), [
    { botId: 'a', action: 'pin', pinned: false }
  ])
  assert.deepEqual(dropActions({ ...base, pinned: true, section: 'Ops' }, { kind: 'section', name: 'Dev' }), [
    { botId: 'a', action: 'pin', pinned: false },
    { botId: 'a', action: 'group', section: 'Dev' }
  ])
  assert.deepEqual(dropActions({ ...base, section: 'Ops' }, { kind: 'rest' }), [
    { botId: 'a', action: 'group', section: null }
  ])
  assert.deepEqual(dropActions({ ...base }, { kind: 'rest' }), [])
  assert.equal(modelText({ modelLabel: 'm', backendLabel: 'Claude' }), 'Claude · m')
  assert.equal(modelText({ modelLabel: 'm' }), 'm')
})
