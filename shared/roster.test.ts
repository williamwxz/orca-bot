import { assert, test } from 'orca/testing'
import { mainFirst, stateLabel } from './roster.ts'

test('panel labels omit idle and use plain state names', () => {
  assert.equal(stateLabel('working'), 'Working')
  assert.equal(stateLabel('waiting'), 'Waiting')
  assert.equal(stateLabel('idle'), '')
})

test('main ordering preserves server order without mutating it', () => {
  const bots = [{ main: false, name: 'A' }, { main: true, name: 'B' }, { main: false, name: 'C' }]
  assert.deepEqual(mainFirst(bots).map((bot) => bot.name), ['B', 'A', 'C'])
  assert.equal(bots[0].name, 'A')
})
