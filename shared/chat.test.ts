import { assert, test } from 'orca/testing'
import { parseThread, collapseActivities, refreshInterval, sendDraft } from './chat.ts'
import type { Composer } from './chat.ts'

test('recent messages hide digests, collapse tools, preserve text and flag unknown content', () => {
  const result = parseThread({ hasMore: true, messages: [
    { id: '4', at: 4, kind: 'approval', text: 'SECRET' },
    { id: '1', at: 1, role: 'user', kind: 'text', text: 'Hello\nworld <b>text</b>' },
    { id: '2', at: 2, kind: 'activity', tool: { name: 'linear.list_teams', arguments: 'SECRET', output: 'SECRET' } },
    { id: '3', at: 3, kind: 'activity', tool: {} },
    { id: '5', at: 5, kind: 'digest', text: '[digest] SECRET' }
  ] })
  assert.equal(result.hasMore, true)
  assert.equal(result.messages[0].text, 'Hello\nworld <b>text</b>')
  assert.equal(result.messages[0].role, 'user')
  assert.equal(result.messages[1].text, 'Used a tool: list_teams')
  assert.deepEqual(collapseActivities(result.messages).map((m) => m.text), ['Hello\nworld <b>text</b>', 'Used 2 tools', 'This needs the full chat.'])
  assert.doesNotMatch(JSON.stringify(result), /SECRET|digest|arguments|output/)
  assert.equal(parseThread({ messages: [] }).hasMore, false)
})
test('text is cut only above 4000 characters and unknown kinds stay plain', () => {
  const thread = parseThread({ messages: [
    { kind: 'text', text: 'a'.repeat(4000) }, { kind: 'text', text: 'a'.repeat(4001) },
    ...['file', 'card', 'form', 'new-kind'].map((kind) => ({ kind, text: 'hidden' }))
  ] })
  assert.equal(thread.messages[0].text.length, 4000)
  assert.equal(thread.messages[1].text, 'a'.repeat(4000) + '… Open the full chat for the rest.')
  assert.equal(thread.messages.slice(2).every((m) => m.kind === 'unsupported' && m.text === 'This needs the full chat.'), true)
})
test('refresh uses two seconds when working or sending, otherwise six', () => {
  for (const state of ['working', 'idle', 'waiting'] as const) {
    assert.equal(refreshInterval(state, true), 2000)
    assert.equal(refreshInterval(state, false), state === 'working' ? 2000 : 6000)
  }
})
test('send shows pending immediately, restores failed text and never resends automatically', async () => {
  const state: Composer = { draft: 'Hello', attempts: [], sending: false }
  let fail!: (error: Error) => void
  let calls = 0
  const send = () => { calls++; return new Promise<void>((_resolve, reject) => { fail = reject }) }
  const pending = sendDraft(state, ['old'], send, () => {})
  assert.equal(state.draft, '')
  assert.equal(state.attempts[0].state, 'pending')
  assert.equal(state.sending, true)
  await sendDraft(state, [], send, () => {})
  state.draft = 'new draft'
  fail(new Error('Could not confirm sending.'))
  await pending
  assert.equal(state.draft, 'Hello\nnew draft')
  assert.equal(state.attempts[0].state, 'failed')
  assert.equal(state.attempts[0].error, 'Could not confirm sending.')
  assert.equal(calls, 1)
  assert.equal(state.sending, false)
})
test('empty and over-limit messages do not send', async () => {
  for (const draft of ['  ', 'x'.repeat(16001)]) {
    const state: Composer = { draft, attempts: [], sending: false }
    await sendDraft(state, [], async () => { throw new Error('must not call') }, () => {})
    assert.equal(state.attempts.length, 0)
  }
})
