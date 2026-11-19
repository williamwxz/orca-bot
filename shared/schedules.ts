/**
 * When a schedule runs. Weekdays are 0 (Sunday) to 6. `cron` and `other` come from schedules made
 * in the full chat; the panel shows them and leaves their timing alone.
 */
export type ScheduleWhen =
  | { kind: 'daily'; time: string; weekdays: number[] }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'once'; at: number }
  | { kind: 'cron'; expression: string }
  | { kind: 'other' }

/** One of a bot's routines in OpenMausBot: a prompt it runs on a schedule. */
export type Schedule = { id: string; name: string; prompt: string; enabled: boolean; when: ScheduleWhen; nextRunAt?: number }

export type ScheduleAction =
  | { action: 'create'; name: string; prompt: string; when: ScheduleWhen }
  | { action: 'toggle'; id: string; enabled: boolean }
  | { action: 'run'; id: string }
  | { action: 'delete'; id: string }

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function whenText(when: ScheduleWhen): string {
  if (when.kind === 'daily') {
    const days = [...when.weekdays].sort().join(',')
    const on = days === '0,1,2,3,4,5,6' ? 'Every day' : days === '1,2,3,4,5' ? 'Weekdays' : days === '0,6' ? 'Weekends' : when.weekdays.map((d) => DAY[d]).join(', ')
    return `${on} at ${when.time}`
  }
  if (when.kind === 'interval')
    return when.everyMinutes % 60 === 0
      ? `Every ${when.everyMinutes === 60 ? 'hour' : `${when.everyMinutes / 60} hours`}`
      : `Every ${when.everyMinutes} minutes`
  if (when.kind === 'once') return `Once, ${new Date(when.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
  if (when.kind === 'cron') return `Custom (${when.expression})`
  return 'Custom timing'
}
