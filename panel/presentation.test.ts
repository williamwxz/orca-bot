import { assert, test } from 'orca/testing'
import { dayLabel, threadPreview } from './presentation.ts'
import type { ChatMessage } from '../shared/chat.ts'

test('preview uses the last text first line, ignoring activities and blank content', () => {
  const text: ChatMessage = { id: '1', role: 'bot', kind: 'text', at: 1, text: 'Hello\r\nSecond line' }
  assert.equal(threadPreview([text, { ...text, kind: 'activity', text: 'tool' }]), 'Hello')
  assert.equal(threadPreview([text, { ...text, text: '\nNo first line' }]), undefined)
  assert.equal(threadPreview([]), undefined)
})
test('day separators show once per local day and ignore invalid timestamps', () => {
  const now = new Date(2026, 10, 15, 10).getTime()
  assert.match(dayLabel(now, undefined, now)!, /^Today /)
  assert.equal(dayLabel(now, now - 1000, now), undefined)
  assert.equal(dayLabel(0, undefined, now), undefined)
  assert.equal(dayLabel(NaN, undefined, now), undefined)
  assert.equal(dayLabel(now - 86400000, undefined, now)?.startsWith('Today'), false)
})
