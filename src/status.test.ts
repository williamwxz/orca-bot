import { assert, test } from 'orca/testing'
import { createStatusLine, statusLine, type GrokBotAgentLiveState } from '../shared/status.ts'

const live: GrokBotAgentLiveState = { isRunning: true, updatedAtMs: 1000, staleAfterMs: 100 }
const idle = { state: 'idle', text: '' }
function tool(detail: string, name = 'SetStatus') {
  return { ...live, activity: { kind: 'tool', tool: name, detail } }
}
test('status is idle for absent, stopped and stale records', () => {
  for (const record of [undefined, { ...live, isRunning: false }]) {
    assert.deepEqual(statusLine(record, 1000), idle)
  }
  assert.deepEqual(statusLine(live, 121_101), idle)
  assert.equal(statusLine(live, 121_100).state, 'working')
  for (const staleAfterMs of [0, -1, '0', undefined]) {
    assert.equal(statusLine({ ...live, staleAfterMs }, 211_000).state, 'working')
    assert.deepEqual(statusLine({ ...live, staleAfterMs }, 211_001), idle)
  }
  assert.equal(statusLine({ ...live, isRunning: false, hasRunningSubagents: true }, 1000).state, 'working')
})
test('timestamps accept decimal strings and numbers', () => {
  for (const updatedAtMs of [1000, '1000']) {
    for (const staleAfterMs of [100, '100']) {
      assert.equal(statusLine({ ...live, updatedAtMs, staleAfterMs }, 121_100).state, 'working')
      assert.deepEqual(statusLine({ ...live, updatedAtMs, staleAfterMs }, 121_101), idle)
    }
  }
})
test('SetStatus formatting follows the app and truncates without splitting graphemes', () => {
  assert.deepEqual(statusLine(tool('is checking the NVDA shares'), 1000), { state: 'working', text: 'Checking the NVDA shares' })
  assert.equal(statusLine(tool('  IS checking   the\nNVDA shares  '), 1000).text, 'Checking the NVDA shares')
  assert.equal(statusLine(tool('a'.repeat(60)), 1000).text, 'A' + 'a'.repeat(59))
  assert.equal(statusLine(tool('a'.repeat(61)), 1000).text, 'A' + 'a'.repeat(59) + '…')
  for (const ending of ['😀', 'e\u0301', '👩‍💻']) {
    assert.equal(statusLine(tool('a'.repeat(59) + ending + 'z'), 1000).text, 'A' + 'a'.repeat(58) + '…')
  }
})
test('exact fallback phrases, typing precedence and private tool details', () => {
  const working = ['Getting it done', 'Making progress', 'Working on it', 'Handling it', 'Chipping away']
  const thinking = ['Thinking it through', 'Mulling it over', 'Putting it together']
  working.forEach((text, index) => {
    for (const record of [live, tool('private arguments', 'UnknownTool'), tool('  ')]) {
      assert.equal(statusLine(record, 1000, () => index / working.length).text, text)
    }
  })
  thinking.forEach((text, index) => {
    assert.equal(statusLine({ ...live, activity: { kind: 'thinking' } }, 1000, () => index / thinking.length).text, text)
  })
  assert.deepEqual(statusLine({ ...live, isComposingMessage: true }, 1000), { state: 'typing', text: 'Typing…' })
  assert.equal(statusLine({ ...tool('is checking'), isComposingMessage: true }, 1000).text, 'Checking')
  assert.equal(statusLine({ ...live, isRunning: false, hasRunningSubagents: true, isComposingMessage: true }, 1000, () => 0).text, working[0])
})
test('a phrase stays stable across polls, changes with activity, and resets on idle', () => {
  let draws = 0
  const read = createStatusLine(() => draws++ / 5)
  const first = read(live, 1000)
  assert.deepEqual(read({ ...live, updatedAtMs: 1001 }, 1001), first)
  assert.equal(draws, 1)
  assert.equal(read(tool('private', 'Other'), 1001).text, 'Making progress')
  assert.deepEqual(read(undefined, 1001), idle)
  assert.equal(read(live, 1001).text, 'Working on it')
  assert.deepEqual(read(live, 121_101), idle)
})

test('polled status tolerates clock differences and missing or invalid timestamps', () => {
  const now = 1_000_000
  const polled = { isRunning: true, updatedAtMs: now, staleAfterMs: 90_000 }
  assert.equal(statusLine(polled, now + 180_000).state, 'working')
  assert.deepEqual(statusLine(polled, now + 600_000), idle)
  for (const updatedAtMs of [undefined, 'bad', '', '  ', NaN, Infinity, now + 600_000, String(now + 600_000)]) {
    assert.equal(statusLine({ ...polled, updatedAtMs }, now).state, 'working')
  }
  assert.equal(statusLine({ isRunning: true }, now).state, 'working')
})
