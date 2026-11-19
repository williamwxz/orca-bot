import { defaultHttpDeps } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'
import { validBotId } from './omb-open.ts'
import type { Schedule, ScheduleAction, ScheduleResult, ScheduleWhen } from '../shared/schedules.ts'

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const ROUTINE_ID = /^[A-Za-z0-9_-]{1,128}$/
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const MAX_SCHEDULES = 50

/** A routine's timing as the panel shows it; cron and limit-reset schedules stay in the full chat. */
export function whenView(raw: unknown): ScheduleWhen {
  const s = object(raw)
  const weekdays = Array.isArray(s.weekdays)
    ? [...new Set(s.weekdays.filter((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) as number[])].sort()
    : undefined
  if (s.type === 'daily' && typeof s.time === 'string' && TIME.test(s.time))
    return { kind: 'daily', time: s.time, weekdays: weekdays?.length ? weekdays : [0, 1, 2, 3, 4, 5, 6] }
  if (s.type === 'interval' && Number.isInteger(s.everyMinutes)) {
    // Weekday, time-window and end-date limits set in OpenMausBot are not shown here, only flagged.
    const limited = (Array.isArray(s.weekdays) && s.weekdays.length < 7) || s.window != null || s.endsAt != null
    return limited ? { kind: 'interval', everyMinutes: s.everyMinutes, limited: true } : { kind: 'interval', everyMinutes: s.everyMinutes }
  }
  if (s.type === 'once' && Number.isFinite(s.at)) return { kind: 'once', at: s.at }
  if (s.type === 'cron' && typeof s.expression === 'string') return { kind: 'cron', expression: s.expression.slice(0, 100) }
  return { kind: 'other' }
}

/** This bot's routines: name, instructions, timing, switch and next run. Room goals and other bots' routines are left out. */
export function schedulesView(raw: unknown, botId: string): Schedule[] {
  const routines = object(raw).routines
  return (Array.isArray(routines) ? routines : [])
    .map(object)
    .filter((r) => r.botId === botId && (r.target ?? 'bot') === 'bot' && typeof r.id === 'string' && ROUTINE_ID.test(r.id))
    .slice(0, MAX_SCHEDULES)
    .map((r) => ({
      id: r.id,
      name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Schedule',
      prompt: typeof r.prompt === 'string' ? r.prompt.slice(0, 20000) : '',
      enabled: r.enabled === true,
      when: whenView(r.schedule),
      ...(Number.isFinite(r.nextRunAt) && r.enabled === true ? { nextRunAt: r.nextRunAt } : {})
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
}

export async function listSchedules(input: { port: number; botId: string }, deps: HttpDeps = defaultHttpDeps()): Promise<Schedule[]> {
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  try {
    return schedulesView(await deps.request(input.port, '/api/routines'), input.botId)
  } catch {
    throw new Error('Could not read this bot’s schedules. Try again.')
  }
}

/** The schedule OpenMausBot stores, from what the panel's form allows. */
export function scheduleBody(when: ScheduleWhen, now: number): Record<string, unknown> {
  if (when.kind === 'daily') {
    if (typeof when.time !== 'string' || !TIME.test(when.time)) throw new Error('Choose a time.')
    const days = Array.isArray(when.weekdays) ? [...new Set(when.weekdays)] : []
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Choose at least one day.')
    return { type: 'daily', time: when.time, weekdays: days.sort() }
  }
  if (when.kind === 'interval') {
    if (!Number.isInteger(when.everyMinutes) || when.everyMinutes < 5 || when.everyMinutes > 1440)
      throw new Error('Choose every 5 to 1,440 minutes.')
    return { type: 'interval', everyMinutes: when.everyMinutes }
  }
  if (when.kind === 'once') {
    if (!Number.isFinite(when.at) || when.at <= now) throw new Error('Choose a time in the future.')
    return { type: 'once', at: Math.round(when.at) }
  }
  throw new Error('Choose when it runs.')
}

/**
 * Creates, switches, runs or deletes one of this bot's routines, then lists them again. An action
 * on an ID that is not this bot's is refused before anything is sent. Once the change is made it
 * is never reported as failed: a list that cannot be read afterwards comes back empty-handed, so
 * the panel does not offer to repeat a create or a run that already happened.
 */
export async function actOnSchedule(
  input: { port: number; botId: string; now?: number } & ScheduleAction,
  deps: HttpDeps = defaultHttpDeps()
): Promise<ScheduleResult> {
  const fresh = () => listSchedules(input, deps).then((schedules) => ({ schedules }), () => ({}))
  if (!validBotId(input.botId)) throw new Error('Invalid bot ID.')
  const fail = (wording: string) => () => {
    throw new Error(wording)
  }
  if (input.action === 'create') {
    const name = String(input.name ?? '').trim()
    const prompt = String(input.prompt ?? '').trim()
    if (!name || name.length > 80) throw new Error('Give it a name of up to 80 characters.')
    if (!prompt || prompt.length > 20000) throw new Error('Say what the bot should do (up to 20,000 characters).')
    const schedule = scheduleBody(input.when, input.now ?? Date.now())
    await deps
      .request(input.port, '/api/routines', { name, prompt, botId: input.botId, schedule, runOn: 'maus', enabled: true }, 'POST')
      .catch(fail('Could not save this schedule. Check the time and try again.'))
    return fresh()
  }
  if (typeof input.id !== 'string' || !ROUTINE_ID.test(input.id)) throw new Error('Unknown schedule.')
  const current = await listSchedules(input, deps)
  if (!current.some((s) => s.id === input.id)) throw new Error('This schedule is gone. Reopen the list.')
  const path = `/api/routines/${input.id}`
  if (input.action === 'toggle') {
    if (typeof input.enabled !== 'boolean') throw new Error('Choose on or off.')
    await deps.request(input.port, path, { enabled: input.enabled }, 'PATCH').catch(fail('Could not change this schedule. Try again.'))
  } else if (input.action === 'run') {
    await deps.request(input.port, `${path}/run`, {}, 'POST').catch(fail('Could not start this schedule. Try again.'))
  } else if (input.action === 'delete') {
    await deps.request(input.port, path, undefined, 'DELETE').catch(fail('Could not delete this schedule. Try again.'))
  } else throw new Error('Unknown action.')
  return fresh()
}
