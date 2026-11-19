import { assert, test } from 'orca/testing'
import {
  parseThread,
  collapseActivities,
  refreshInterval,
  sendDraft,
  displayText,
  reconcileAttempts,
  elapsedTime
} from './chat.ts'
import type { Composer } from './chat.ts'

test('recent messages hide digests, collapse tools, preserve text and flag unknown content', () => {
  const result = parseThread({
    hasMore: true,
    messages: [
      { id: '4', at: 4, kind: 'approval', text: 'SECRET' },
      { id: '1', at: 1, role: 'user', kind: 'text', text: 'Hello\nworld <b>text</b>' },
      {
        id: '2',
        at: 2,
        kind: 'activity',
        tool: { name: 'linear.list_teams', arguments: 'SECRET', output: 'SECRET' }
      },
      { id: '3', at: 3, kind: 'activity', tool: {} },
      { id: '5', at: 5, kind: 'digest', text: '[digest] SECRET' }
    ]
  })
  assert.equal(result.hasMore, true)
  assert.equal(result.messages[0].text, 'Hello\nworld <b>text</b>')
  assert.equal(result.messages[0].role, 'user')
  assert.equal(result.messages[1].text, 'Used a tool: list_teams')
  assert.deepEqual(
    collapseActivities(result.messages).map((m) => m.text),
    ['Hello\nworld <b>text</b>', 'Used 2 tools', 'This needs the full chat.']
  )
  assert.doesNotMatch(JSON.stringify(result), /SECRET|digest|arguments|output/)
  assert.equal(parseThread({ messages: [] }).hasMore, false)
})
test('text is cut only above 4000 characters and unknown kinds stay plain', () => {
  const thread = parseThread({
    messages: [
      { kind: 'text', text: 'a'.repeat(4000) },
      { kind: 'text', text: 'a'.repeat(4001) },
      ...['file', 'card', 'form', 'new-kind'].map((kind) => ({ kind, text: 'hidden' }))
    ]
  })
  assert.equal(thread.messages[0].text.length, 4000)
  assert.equal(displayText(thread.messages[1].text), 'a'.repeat(4000) + '… Open the full chat for the rest.')
  assert.equal(
    thread.messages.slice(2).every((m) => m.kind === 'unsupported' && m.text === 'This needs the full chat.'),
    true
  )
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
  const send = () => {
    calls++
    return new Promise<void>((_resolve, reject) => {
      fail = reject
    })
  }
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
    await sendDraft(
      state,
      [],
      async () => {
        throw new Error('must not call')
      },
      () => {}
    )
    assert.equal(state.attempts.length, 0)
  }
})

test('screenshot Hi echo and reply remove the local copy, even if echo arrived before acceptance', () => {
  const attempt = { text: 'Hi', state: 'sent' as const, sentAt: 10000 }
  const messages = parseThread({
    messages: [
      { id: 'hi', role: 'user', kind: 'text', text: 'Hi', at: 9000 },
      { id: 'reply', role: 'bot', kind: 'text', text: 'Hi! What can I help with?', at: 11000 }
    ]
  }).messages
  assert.deepEqual(reconcileAttempts([attempt], messages).attempts, [])
  assert.deepEqual(reconcileAttempts([{ ...attempt, state: 'pending' }], messages).attempts, [])
})
test('identical sends consume separate echoes across refreshes with five seconds of tolerance', () => {
  const first = { text: 'Hi', state: 'sent' as const, sentAt: 10000 }
  const second = { ...first, sentAt: 11000 }
  const echo = { id: 'one', at: 10000, role: 'user' as const, kind: 'text' as const, text: 'Hi' }
  const initial = reconcileAttempts([first, second], [echo])
  assert.deepEqual(initial.attempts, [second])
  const repeated = reconcileAttempts(initial.attempts, [echo], initial.matchedIds)
  assert.deepEqual(repeated.attempts, [second])
  assert.deepEqual(
    reconcileAttempts(repeated.attempts, [echo, { ...echo, id: 'two', at: 11000 }], repeated.matchedIds)
      .attempts,
    []
  )
  for (const invalid of [
    { ...echo, at: 4999 },
    { ...echo, role: 'bot' as const },
    { ...echo, text: 'hi' }
  ]) {
    assert.deepEqual(reconcileAttempts([first], [invalid]).attempts, [first])
  }
  assert.deepEqual(reconcileAttempts([first], [{ ...echo, at: 5000 }]).attempts, [])
  assert.deepEqual(reconcileAttempts([{ ...first, state: 'failed' }], [echo]).attempts.length, 1)
  assert.deepEqual(
    reconcileAttempts([{ ...first, text: 'x'.repeat(5000) }], [{ ...echo, text: 'x'.repeat(5000) }]).attempts,
    []
  )
})
test('elapsed working time counts whole seconds and minutes', () => {
  for (const [ms, label] of [
    [0, '0s'],
    [3999, '3s'],
    [59000, '59s'],
    [60000, '1m 0s'],
    [65000, '1m 5s'],
    [120000, '2m 0s'],
    [-1000, '0s']
  ] as const)
    assert.equal(elapsedTime(1000, 1000 + ms), label)
})

test('a message can be only attachments; files go by ID and history never carries their paths', async () => {
  const file = { id: 'upload-1', kind: 'image' as const, name: 'a.png' }
  const sent: [string, string[]][] = []
  const state = { draft: '', attempts: [], sending: false } as any
  await sendDraft(state, [], async (text, ids) => { sent.push([text, ids]) }, () => {}, () => 10, [file])
  assert.deepEqual(sent, [['', ['upload-1']]])
  assert.deepEqual(state.attempts[0].attachments, [file])
  state.draft = ' Look '
  await sendDraft(state, [], async () => { throw new Error('offline') }, () => {}, () => 20, [file])
  assert.equal(state.attempts[1].state, 'failed')
  assert.equal(state.draft, 'Look')
  state.draft = ''
  await sendDraft(state, [], async () => { sent.push(['nothing', []]) }, () => {})
  assert.equal(sent.length, 1)
  // The server's copy of a message holds file paths in tags: parsing keeps names only.
  const thread = parseThread({ messages: [
    { id: 'm1', at: 10, role: 'user', kind: 'text', text: '<attached-image path="/server/secret/a.png" name="a.png" />' },
    { id: 'm2', at: 11, role: 'user', kind: 'text', text: 'Look\n\n<attached-file path="/server/secret/b.pdf" name="b.pdf" />' }
  ] })
  assert.equal(JSON.stringify(thread).includes('/server/secret'), false)
  assert.deepEqual(thread.messages[0], { id: 'm1', at: 10, role: 'user', kind: 'text', text: '', attachments: [{ kind: 'image', name: 'a.png' }] })
  assert.equal(thread.messages[1].text, 'Look')
  // The pending bubble matches its echo by text and by the same files in order, not just a count.
  const pending = [{ text: '', state: 'sent' as const, sentAt: 10, attachments: [file] }]
  assert.equal(reconcileAttempts(pending, [thread.messages[1]]).attempts.length, 1)
  assert.equal(reconcileAttempts(pending, [thread.messages[0]]).attempts.length, 0)
  const other = { ...thread.messages[0], id: 'm3', attachments: [{ kind: 'image' as const, name: 'b.png' }] }
  assert.equal(reconcileAttempts(pending, [other]).attempts.length, 1)
  const wrongKind = { ...thread.messages[0], id: 'm4', attachments: [{ kind: 'file' as const, name: 'a.png' }] }
  assert.equal(reconcileAttempts(pending, [wrongKind]).attempts.length, 1)
  const two = [{ text: '', state: 'sent' as const, sentAt: 10, attachments: [file, { id: 'u2', kind: 'file' as const, name: 'b.pdf' }] }]
  const swapped = { ...thread.messages[0], id: 'm5', attachments: [{ kind: 'file' as const, name: 'b.pdf' }, { kind: 'image' as const, name: 'a.png' }] }
  assert.equal(reconcileAttempts(two, [swapped]).attempts.length, 1)
})
