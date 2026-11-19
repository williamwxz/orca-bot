import { assert, test } from 'orca/testing'
import { botName, botsView, elapsed, mergeMessages, rowsView, toolLine } from './bots.ts'

test('bot names come from Hermes, else from the profile name; the default profile is Hermes', () => {
  assert.equal(botName({ name: 'sandbox-test' }), 'Sandbox Test')
  assert.equal(botName({ name: 'default', is_default: true }), 'Hermes')
  assert.equal(botName({ name: 'honex', display_name: '  Honex 同事 ' }), 'Honex 同事')
})

test('the roster keeps name, model, preview and time, newest first, and nothing about the machine', () => {
  const view = botsView(
    {
      install_id: 'SECRET',
      profiles: [
        { name: 'default', is_default: true, path: '/Users/SECRET/.hermes', model: 'gpt', canonical_session: { id: 'SECRET', preview: 'old\n  line', last_active: 100 } },
        { name: 'honex', path: '/Users/SECRET/x', model: 'claude', canonical_session: { preview: 'x'.repeat(300), last_active: 200.5 } },
        { name: 'quiet', path: '/p' },
        { name: '../evil', path: '/p' },
        { name: 7 }
      ]
    },
    (id) => id === 'honex'
  )
  assert.deepEqual(view.map((b) => b.id), ['honex', 'default', 'quiet'])
  assert.deepEqual(view[1], { id: 'default', name: 'Hermes', model: 'gpt', preview: 'old line', lastActive: 100000, working: false })
  assert.equal(view[0].preview.length, 140)
  assert.equal(view[0].working, true)
  assert.equal(view[0].lastActive, 200500)
  assert.deepEqual(view[2], { id: 'quiet', name: 'Quiet', model: '', preview: '', lastActive: 0, working: false })
  assert.doesNotMatch(JSON.stringify(view), /SECRET|Users/)
  assert.deepEqual(botsView(undefined), [])
})

test('stored rows become messages: tool calls read as one line, empty and hidden rows are skipped', () => {
  const view = rowsView({
    rows: [
      { role: 'user', row_kind: 'message', text: 'hello', row_id: 1, timestamp: 10 },
      { role: 'assistant', row_kind: 'message', text: '', row_id: 2, timestamp: 11 },
      { role: 'tool', row_kind: 'message', name: 'terminal', context: 'echo  hi\nthere', tool_call_id: 'toolu_1', timestamp: 12, args: { secret: 'SECRET' } },
      { role: 'assistant', row_kind: 'message', text: 'done', row_id: 4, timestamp: 13 },
      { role: 'assistant', row_kind: 'message', text: 'internal', row_id: 5, display_kind: 'hidden' },
      { role: 'assistant', row_kind: 'compaction', row_id: 6, compacted_messages: 40 },
      { role: 'system', row_kind: 'message', text: 'SECRET system prompt', row_id: 7 },
      { role: 'assistant', row_kind: 'message', text: 'x'.repeat(20500), row_id: 8 }
    ]
  })
  assert.deepEqual(view.slice(0, 4), [
    { id: 'r1', at: 10000, role: 'user', kind: 'text', text: 'hello' },
    { id: 'ttoolu_1', at: 12000, role: 'bot', kind: 'activity', text: 'Used terminal' },
    { id: 'r4', at: 13000, role: 'bot', kind: 'text', text: 'done' },
    { id: 'r6', at: 0, role: 'bot', kind: 'notice', text: 'Earlier messages were summarized here to save context.' }
  ])
  assert.equal(view.length, 5)
  assert.match(view[4].text, /Open the bot in Hermes for the rest\.$/)
  // The preview Hermes builds from a call's arguments never leaves the worker.
  assert.doesNotMatch(JSON.stringify(view), /SECRET|echo/)
  assert.equal(toolLine('bad name!'), 'Used a tool')
  assert.deepEqual(rowsView({}), [])
})

test('pages merge without repeats; a newer copy of a held row replaces it', () => {
  const m = (id: string, text = id) => ({ id, at: 0, role: 'bot' as const, kind: 'text' as const, text })
  assert.deepEqual(mergeMessages([m('c'), m('d')], [m('a'), m('b'), m('c')], 'older').map((x) => x.id), ['a', 'b', 'c', 'd'])
  const newer = mergeMessages([m('a'), m('b', 'part')], [m('b', 'whole'), m('c')], 'newer')
  assert.deepEqual(newer.map((x) => `${x.id}:${x.text}`), ['a:a', 'b:whole', 'c:c'])
  assert.equal(elapsed(0, 59000), '59s')
  assert.equal(elapsed(0, 125000), '2m 5s')
})
