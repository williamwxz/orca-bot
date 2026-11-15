// The subset of the wire live record used for display; other wire fields stay private.
export type GrokBotAgentLiveState = {
  agentId?: string
  isRunning?: boolean
  hasRunningSubagents?: boolean
  isComposingMessage?: boolean
  updatedAtMs?: string | number
  staleAfterMs?: string | number
  activity?: { kind?: string; tool?: string; detail?: string; target?: string; callId?: string }
}
export type StatusLine = { state: 'idle' | 'working' | 'typing'; text: string }
const WORKING = ['Getting it done', 'Making progress', 'Working on it', 'Handling it', 'Chipping away']
const THINKING = ['Thinking it through', 'Mulling it over', 'Putting it together']

function formatDetail(detail: string): string {
  const stripped = detail.trim().replace(/^is /i, '')
  const characters = Array.from(stripped)
  const text = ((characters.shift() ?? '').toUpperCase() + characters.join('')).replace(/\s+/g, ' ')
  if (text.length <= 60) return text
  // Match the app's UTF-16 limit without cutting a grapheme (including emoji/combining marks).
  let clipped = ''
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (clipped.length + segment.length > 60) break
    clipped += segment
  }
  return clipped + '…'
}
function phrase(phrases: string[], random: () => number): string {
  const draw = random()
  const index = Number.isFinite(draw) ? Math.max(0, Math.min(phrases.length - 1, Math.floor(draw * phrases.length))) : 0
  return phrases[index]
}
export function statusLine(live: GrokBotAgentLiveState | undefined, now: number, random = Math.random): StatusLine {
  const timestamp = live?.updatedAtMs
  const updated = typeof timestamp === 'string' && !timestamp.trim() ? NaN : Number(timestamp)
  const stale = Number(live?.staleAfterMs)
  if (!live || !(live.isRunning === true || live.hasRunningSubagents === true) ||
      (Number.isFinite(updated) && now - updated > (stale > 0 ? stale : 90_000) + 120_000)) {
    return { state: 'idle', text: '' }
  }
  const activity = live.activity
  if (activity?.kind === 'tool' && activity.tool === 'SetStatus' && typeof activity.detail === 'string') {
    const text = formatDetail(activity.detail)
    if (text) return { state: 'working', text }
  }
  if (activity?.kind === 'thinking') return { state: 'working', text: phrase(THINKING, random) }
  if (!activity?.kind && live.isRunning === true && live.isComposingMessage === true) {
    return { state: 'typing', text: 'Typing…' }
  }
  return { state: 'working', text: phrase(WORKING, random) }
}

// One instance per bot. Only display-relevant activity fields participate in stability.
export function createStatusLine(random = Math.random) {
  let previousKey: string | undefined
  let previous: StatusLine | undefined
  return (live: GrokBotAgentLiveState | undefined, now: number): StatusLine => {
    const activity = live?.activity
    const key = JSON.stringify([activity?.kind, activity?.tool, activity?.detail, activity?.target,
      activity?.callId, live?.isRunning, live?.isComposingMessage])
    const result = statusLine(live, now, () => 0)
    if (result.state === 'idle') {
      previousKey = undefined
      previous = undefined
      return result
    }
    if (key === previousKey && previous) return previous
    previousKey = key
    previous = statusLine(live, now, random)
    return previous
  }
}
