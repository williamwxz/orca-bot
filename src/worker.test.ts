// Runs the worker against a fake gbot script, so no test ever reaches a real Grok Bot account.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { removeRoutineMessage, routinesFrom, scheduleMessage, toEntry } from '../shared/model'
import * as main from './worker'

const BOT = '11111111-2222-4333-8444-555555555555'

// The fake appends each call's arguments to calls.jsonl and prints a canned gbot result.
function fakeGbot(): { path: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'bot-deck-test-'))
  const log = join(dir, 'calls.jsonl')
  const path = join(dir, 'gbot')
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const bot = { id: '${BOT}', kind: 'bot', name: 'Researcher', description: 'Find jobs', avatarColor: 'green', hiddenFromSidebar: false }
const out = (value) => process.stdout.write(JSON.stringify(value))
if (args[0] === 'doctor') out({ gatewayAuthPresent: true, grokBotAppSession: { usable: true } })
else if (args[0] === 'bots' && args.includes('--name=Boom')) { out({ error: { code: 'x', message: 'name taken' } }); process.exit(1) }
else if (args[0] === 'bots') out(args[1] === 'list' ? [bot] : bot)
else if (args[0] === 'thread') out({ transcript: { entries: [
  { kind: 'message', id: 'u1', role: 'user', content: 'hi', timestampMs: 1 },
  { kind: 'send-message', id: 's1', message: { type: 'text', content: 'hello' }, timestampMs: 2 },
  { kind: 'event', id: 'e1', event: { type: 'automation-changed', action: 'created', automationId: 'daily', automationName: 'Daily check' }, timestampMs: 3 }
] } })
else if (args[0] === 'send') out({ delivery: 'accepted' })
`
  )
  chmodSync(path, 0o755)
  return {
    path,
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
  }
}

async function mount() {
  const gbot = fakeGbot()
  const host = mockHost({ settings: { gbotPath: gbot.path } })
  const worker = await mountWorker(main, { host })
  return { gbot, worker }
}

test('lists bots and reads a thread in the shapes the panel draws', async () => {
  const { worker } = await mount()
  assert.deepEqual(await worker.request('status'), { ok: true, message: '' })
  assert.deepEqual(await worker.request('bots.list'), [
    {
      id: BOT,
      name: 'Researcher',
      instructions: 'Find jobs',
      avatarShape: 'square',
      avatarColor: 'green',
      hidden: false
    }
  ])
  const entries = (await worker.request('thread.read', { id: BOT })) as ReturnType<typeof toEntry>[]
  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.text]),
    [
      ['user', 'hi'],
      ['bot', 'hello'],
      ['event', 'Routine created: Daily check']
    ]
  )
  assert.deepEqual(
    routinesFrom(entries).map((routine) => routine.name),
    ['Daily check']
  )
  await worker.deactivate()
})

test('create, update, delete and send pass exact arguments to gbot', async () => {
  const { gbot, worker } = await mount()
  await worker.request('bots.create', { name: 'Writer', instructions: '--be brief' })
  await worker.request('bots.update', { id: BOT, hidden: true })
  await worker.request('bots.delete', { id: BOT })
  await worker.request('message.send', { id: BOT, text: '--json; rm -rf /' })
  const calls = gbot.calls().filter((args) => args[1] !== 'list')
  assert.deepEqual(calls, [
    ['bots', 'create', '--json', '--name=Writer', '--description=--be brief'],
    ['bots', 'update', '--json', '--hidden=on', BOT],
    ['bots', 'delete', '--json', BOT],
    // The message follows `--`, so it is text to gbot whatever it looks like.
    ['send', '--json', '--no-history', BOT, '--', '--json; rm -rf /']
  ])
  await worker.deactivate()
})

test('refuses targets that are not bot ids, and surfaces gbot errors', async () => {
  const { gbot, worker } = await mount()
  await assert.rejects(worker.request('bots.delete', { id: 'Researcher' }), /Unknown bot id/)
  await assert.rejects(worker.request('message.send', { id: '--gateway', text: 'x' }), /Unknown bot id/)
  await assert.rejects(worker.request('message.send', { id: BOT, text: '  ' }), /Message is required/)
  await assert.rejects(worker.request('bots.create', { name: 'Boom' }), /name taken/)
  assert.deepEqual(
    gbot.calls().map((args) => args.slice(0, 2)),
    [['bots', 'create']]
  )
  await worker.deactivate()
})

test('reports a missing gbot as a setup problem instead of throwing', async () => {
  const host = mockHost({ settings: { gbotPath: '/nonexistent/gbot' } })
  const worker = await mountWorker(main, { host })
  const status = (await worker.request('status')) as { ok: boolean; message: string }
  assert.equal(status.ok, false)
  assert.match(status.message, /not found at \/nonexistent\/gbot/)
  await worker.deactivate()
})

test('scheduling and routine removal are plain messages to the bot', () => {
  assert.equal(
    scheduleMessage({ name: ' Standup ', task: 'Summarize PRs', when: 'every day at 09:00', timeZone: 'UTC' }),
    'Please create a scheduled routine.\nName: Standup\nWhen: every day at 09:00 (time zone: UTC)\nTask: Summarize PRs\nConfirm once it is scheduled.'
  )
  assert.match(removeRoutineMessage('Standup'), /delete the scheduled routine "Standup"/)
  const deleted = [
    toEntry({ kind: 'event', id: 'a', timestampMs: 1, event: { type: 'automation-changed', action: 'created', automationId: 'x', automationName: 'X' } }),
    toEntry({ kind: 'event', id: 'b', timestampMs: 2, event: { type: 'automation-changed', action: 'deleted', automationId: 'x', automationName: 'X' } })
  ]
  assert.deepEqual(routinesFrom(deleted), [])
})
