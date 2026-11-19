import { assert, test } from 'orca/testing'
import { actOnSchedule, listSchedules, scheduleBody, schedulesView, whenView } from './omb-schedules.ts'
import { HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { whenText } from '../shared/schedules.ts'

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const routines = {
  routines: [
    { id: 'r1', name: 'Morning digest', prompt: 'Collect news.', target: 'bot', botId: a, enabled: true, schedule: { type: 'daily', time: '07:30', weekdays: [5, 1, 2, 3, 4] }, nextRunAt: 100, attachments: ['SECRET'] },
    { id: 'r2', name: 'Cron one', prompt: 'x', target: 'bot', botId: a, enabled: false, schedule: { type: 'cron', expression: '28 7 * * 1-5', timeZone: 'America/Los_Angeles' }, nextRunAt: 5 },
    { id: 'r3', name: 'Other bot', prompt: 'x', target: 'bot', botId: b, enabled: true, schedule: { type: 'interval', everyMinutes: 60 } },
    { id: 'r4', name: 'Room goal', prompt: 'x', target: 'room-goal', botId: a, enabled: true, schedule: { type: 'interval', everyMinutes: 60 } },
    { id: '../x', name: 'Bad', prompt: 'x', botId: a, enabled: true, schedule: {} }
  ],
  runs: []
}
function fake(fail?: (path: string, method?: string) => Error | undefined) {
  const calls: { path: string; body?: unknown; method?: string }[] = []
  const deps: HttpDeps = {
    avatar: async () => undefined,
    request: async (_port, path, body, method) => {
      calls.push({ path, ...(body !== undefined ? { body } : {}), ...(method ? { method } : {}) })
      const problem = fail?.(path, method)
      if (problem) throw problem
      return path === '/api/routines' && !method ? routines : {}
    }
  }
  return { deps, calls }
}

test('a bot sees only its own routines, with plain timing and no attachments', () => {
  const view = schedulesView(routines, a)
  assert.deepEqual(view.map((s) => s.id), ['r1', 'r2'])
  assert.deepEqual(view[0], { id: 'r1', name: 'Morning digest', prompt: 'Collect news.', enabled: true, when: { kind: 'daily', time: '07:30', weekdays: [1, 2, 3, 4, 5] }, nextRunAt: 100 })
  assert.equal(view[1].nextRunAt, undefined)
  assert.doesNotMatch(JSON.stringify(view), /SECRET|Los_Angeles/)
  assert.equal(whenText(view[0].when), 'Weekdays at 07:30')
  assert.equal(whenText(view[1].when), 'Custom (28 7 * * 1-5)')
  assert.equal(whenText({ kind: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] }), 'Every day at 09:00')
  assert.equal(whenText({ kind: 'daily', time: '09:00', weekdays: [1, 3] }), 'Mon, Wed at 09:00')
  assert.equal(whenText({ kind: 'interval', everyMinutes: 60 }), 'Every hour')
  assert.equal(whenText({ kind: 'interval', everyMinutes: 120 }), 'Every 2 hours')
  assert.equal(whenText({ kind: 'interval', everyMinutes: 15 }), 'Every 15 minutes')
  assert.deepEqual(whenView({ type: 'limit_reset' }), { kind: 'other' })
})

test('the form becomes OpenMausBot schedules and bad timing is refused before sending', () => {
  assert.deepEqual(scheduleBody({ kind: 'daily', time: '08:05', weekdays: [3, 1, 1] }, 0), { type: 'daily', time: '08:05', weekdays: [1, 3] })
  assert.deepEqual(scheduleBody({ kind: 'interval', everyMinutes: 30 }, 0), { type: 'interval', everyMinutes: 30 })
  assert.deepEqual(scheduleBody({ kind: 'once', at: 2000.4 }, 1000), { type: 'once', at: 2000 })
  for (const bad of [
    { kind: 'daily', time: '25:00', weekdays: [1] },
    { kind: 'daily', time: '08:00', weekdays: [] },
    { kind: 'daily', time: '08:00', weekdays: [7] },
    { kind: 'interval', everyMinutes: 4 },
    { kind: 'interval', everyMinutes: 1441 },
    { kind: 'once', at: 500 },
    { kind: 'cron', expression: '* * * * *' }
  ])
    assert.throws(() => scheduleBody(bad as any, 1000))
})

test('actions touch only this bot’s routines and answer with the fresh list', async () => {
  const { deps, calls } = fake()
  const created = await actOnSchedule({ port: 9, botId: a, now: 0, action: 'create', name: ' Daily ', prompt: ' Summarize. ', when: { kind: 'daily', time: '09:00', weekdays: [1] } }, deps)
  assert.deepEqual(calls[0], { path: '/api/routines', body: { name: 'Daily', prompt: 'Summarize.', botId: a, schedule: { type: 'daily', time: '09:00', weekdays: [1] }, runOn: 'maus', enabled: true }, method: 'POST' })
  assert.equal(created.length, 2)
  calls.length = 0
  await actOnSchedule({ port: 9, botId: a, action: 'toggle', id: 'r1', enabled: false }, deps)
  assert.deepEqual(calls[1], { path: '/api/routines/r1', body: { enabled: false }, method: 'PATCH' })
  calls.length = 0
  await actOnSchedule({ port: 9, botId: a, action: 'run', id: 'r1' }, deps)
  assert.deepEqual(calls[1], { path: '/api/routines/r1/run', body: {}, method: 'POST' })
  calls.length = 0
  await actOnSchedule({ port: 9, botId: a, action: 'delete', id: 'r2' }, deps)
  assert.deepEqual(calls[1], { path: '/api/routines/r2', method: 'DELETE' })
  // Another bot's routine, a room goal, or a malformed ID is refused before any change is sent.
  for (const id of ['r3', 'r4', '../x']) {
    calls.length = 0
    await assert.rejects(actOnSchedule({ port: 9, botId: a, action: 'delete', id }, deps))
    assert.ok(calls.every((c) => !c.method))
  }
  for (const bad of [{ name: '', prompt: 'x' }, { name: 'x'.repeat(81), prompt: 'x' }, { name: 'x', prompt: ' ' }])
    await assert.rejects(actOnSchedule({ port: 9, botId: a, action: 'create', when: { kind: 'interval', everyMinutes: 30 }, ...bad } as any, deps))
  await assert.rejects(actOnSchedule({ port: 9, botId: a, action: 'toggle', id: 'r1', enabled: 'no' as any }, deps), /Choose on or off/)
  const refused = fake((_p, method) => (method === 'POST' ? new HttpStatusError(400, { error: 'SECRET' }) : undefined))
  await assert.rejects(
    actOnSchedule({ port: 9, botId: a, action: 'create', name: 'x', prompt: 'y', when: { kind: 'interval', everyMinutes: 30 } }, refused.deps),
    /^Error: Could not save this schedule/
  )
  const down = fake(() => new Error('SECRET'))
  await assert.rejects(listSchedules({ port: 9, botId: a }, down.deps), /^Error: Could not read this bot’s schedules/)
})
