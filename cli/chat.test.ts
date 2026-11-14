import { assert, test } from 'orca/testing'
import { formatEntry, runChat, wrap } from './chat.ts'
import type { ChatClient } from './chat.ts'
import type { Bot, Entry } from '../shared/model.ts'

function bot(name: string, hidden = false): Bot {
  return { id: name, name, hidden, instructions: '', avatarShape: '', avatarColor: '', serverRun: false }
}

function entry(id: string, text: string, ts: number, patch: Partial<Entry> = {}): Entry {
  return { id, text, ts, role: 'bot', type: 'text', ...patch }
}

// This harness never constructs a connection: every client method is an in-memory fake.
async function chat(lines: (string | null)[], options: {
  bots?: Bot[]
  threads?: (Entry[] | Error)[]
  send?: ChatClient['sendMessage']
  list?: ChatClient['listBots']
  stopAfterSleep?: boolean
} = {}) {
  const output: string[] = []
  const reads: { id: string; limit: number }[] = []
  const sends: { id: string; text: string }[] = []
  const sleeps: number[] = []
  let now = 0
  let lists = 0
  let stopped = false
  const threads = [...(options.threads ?? [[]])]
  let last: Entry[] = []
  const client: ChatClient = {
    listBots: async () => {
      lists += 1
      return options.list ? options.list() : options.bots ?? [bot('Archive', true), bot('Ada'), bot('Atlas')]
    },
    readThread: async (id, limit) => {
      reads.push({ id, limit })
      const next = threads.shift()
      if (next instanceof Error) throw next
      if (next) last = next
      return [...last]
    },
    sendMessage: async (id, text) => {
      sends.push({ id, text })
      return options.send ? options.send(id, text) : { delivery: 'accepted' }
    }
  }
  await runChat(client, {
    readLine: async prompt => {
      output.push(prompt)
      const line = lines.shift() ?? null
      if (line !== null) output.push(`${line}\n`)
      return line
    },
    write: text => { output.push(text) },
    now: () => now,
    sleep: async ms => {
      sleeps.push(ms)
      now += ms
      stopped = options.stopAfterSleep ?? false
    },
    stopped: () => stopped
  })
  return { output: output.join(''), reads, sends, sleeps, now, lists }
}

test('lists visible bots first, marks hidden bots, and selects by number', async () => {
  const result = await chat(['1', '/q'])
  assert.match(result.output, /^1\. Ada\n2\. Atlas\n3\. Archive \[hidden\]\nbot> 1\n> \/q\n$/)
  assert.deepEqual(result.reads, [{ id: 'Ada', limit: 10 }])
})

test('selects by case-insensitive prefix including hidden bots', async () => {
  const result = await chat(['arc', '/q'])
  assert.deepEqual(result.reads, [{ id: 'Archive', limit: 10 }])
  const upper = await chat(['AD', '/q'])
  assert.equal(upper.reads[0].id, 'Ada')
})

test('ambiguous, unknown, and out-of-range choices remain at the bot prompt', async () => {
  const result = await chat(['a', 'missing', '99', '0', '2', '/q'])
  assert.match(result.output, /Ambiguous bot/)
  assert.equal(result.output.split('Unknown bot.').length - 1, 3)
  assert.deepEqual(result.reads, [{ id: 'Atlas', limit: 10 }])
})

test('prints ten oldest-first history entries, roles, events and app placeholders', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(`m${i}`, `text${i}`, i))
  entries[3].role = 'user'
  entries[4] = entry('event', 'Routine updated', 4, { role: 'event', type: 'event' })
  entries[5].type = 'form'
  entries[6].type = 'file'
  entries[7].type = 'email'
  const result = await chat(['1', '/q'], { threads: [entries.reverse()] })
  assert.ok(!result.output.includes('Ada: text0\n'))
  assert.ok(result.output.indexOf('Ada: text2') < result.output.indexOf('you: text3'))
  assert.match(result.output, /-- Routine updated --/)
  for (const label of ['form', 'file', 'draft']) {
    assert.ok(result.output.includes(`[${label}: open the Grok Bot app]`))
  }
})

test('wraps text at 60 columns and cuts at 1500 characters with a marker', async () => {
  const result = await chat(['1', '/q'], { threads: [[entry('long', 'x'.repeat(1600), 1)]] })
  const body = result.output.slice(result.output.indexOf('Ada:'), result.output.indexOf('> /q'))
  assert.ok(body.trimEnd().endsWith('[...]'))
  assert.equal((body.match(/x/g) ?? []).length, 1500)
  assert.ok(body.split('\n').every(line => Array.from(line).length <= 60))
  assert.equal(wrap('word '.repeat(20)).split('\n')[0], 'word '.repeat(12).trimEnd())
  assert.equal(formatEntry(entry('control', 'safe\x1b[31m\rtext', 1), 'Ada').includes('\x1b'), false)
})

test('sends once and receives a completed reply after two polls (sample transcript)', async () => {
  const history = [entry('old-user', 'Hi', 1, { role: 'user' }), entry('old-bot', 'Hello', 2)]
  const user = entry('new-user', 'What is next?', 3, { role: 'user' })
  const result = await chat(['1', 'What is next?', '/q'], { threads: [
    history,
    [...history, user, entry('reply', 'Checking', 4, { streaming: true })],
    [...history, user, entry('reply', 'Try the next step.', 4, { streaming: false })]
  ] })
  assert.deepEqual(result.sends, [{ id: 'Ada', text: 'What is next?' }])
  assert.deepEqual(result.sleeps, [3000, 3000])
  assert.match(result.output, /Ada: Checking\nAda: Try the next step\./)
  assert.equal(result.output.split('Ada: Hello').length - 1, 1)
  assert.equal(result.output, '1. Ada\n2. Atlas\n3. Archive [hidden]\nbot> 1\nyou: Hi\nAda: Hello\n> What is next?\nyou: What is next?\nAda: Checking\nAda: Try the next step.\n> /q\n')
})

test('gives up after 120 seconds when only events or streaming messages arrive', async () => {
  const result = await chat(['1', 'Hello', '/q'], { threads: [[], [
    entry('busy', 'Working', 1, { streaming: true }),
    entry('event', 'Started', 2, { role: 'event', type: 'event' })
  ]] })
  assert.equal(result.now, 120000)
  assert.equal(result.sleeps.length, 40)
  assert.match(result.output, /Still working\. \/r refreshes/)
  assert.equal(result.sends.length, 1)
})

test('/r shows new entries and changes only, without replaying older tail entries', async () => {
  const current = entry('current', 'Current', 10)
  const next = entry('next', 'New', 11)
  const result = await chat(['1', '/r', '/r', '/q'], { threads: [
    [current], [entry('older', 'Old', 1), current, next], [current, next]
  ] })
  assert.equal(result.output.split('Ada: Current').length - 1, 1)
  assert.equal(result.output.split('Ada: New').length - 1, 1)
  assert.ok(!result.output.includes('Ada: Old'))
  assert.equal(result.sends.length, 0)
})

test('/m caps history at 50 and /b returns to a refreshed bot list', async () => {
  const result = await chat(['1', '/m 3', '/m 99', '/b', '2', '/q'])
  assert.deepEqual(result.reads.map(read => read.limit), [10, 3, 50, 10])
  assert.equal(result.lists, 2)
  assert.equal(result.reads.at(-1)?.id, 'Atlas')
})

test('/h, unknown commands and invalid history counts print help without sending', async () => {
  const result = await chat(['/h', '/x', '1', '/h', '/x', '/m 0', '/m nope', '/q'])
  assert.equal(result.output.split('/b bots |').length - 1, 6)
  assert.equal(result.sends.length, 0)
})

test('client read errors are single lines and the loop continues', async () => {
  const result = await chat(['1', '/r', '/q'], { threads: [new Error('Read failed\ntry again'), [entry('ok', 'Recovered', 1)]] })
  assert.match(result.output, /Error: Read failed try again\n> \/r/)
  assert.match(result.output, /Ada: Recovered/)
})

test('listing errors can be retried with /r and empty lists stay usable', async () => {
  let attempts = 0
  const result = await chat(['/r', '1', '/q'], { list: async () => {
    attempts += 1
    if (attempts === 1) throw new Error('Offline')
    return [bot('Ada')]
  } })
  assert.match(result.output, /Error: Offline/)
  assert.equal(result.reads.length, 1)
  assert.match((await chat(['/q'], { bots: [] })).output, /No bots found/)
})

test('unclear returned or thrown sends are reported once and never repeated', async () => {
  for (const send of [
    async () => ({ delivery: 'unknown' as const }),
    async () => { throw Object.assign(new Error('Outcome unknown'), { code: 'outcome_unknown' }) }
  ]) {
    const result = await chat(['1', 'Hello', '/r', '/h', '/q'], { send })
    assert.equal(result.sends.length, 1)
    assert.equal(result.output.split('Send outcome unclear.').length - 1, 1)
    assert.equal(result.sleeps.length, 0)
    assert.equal(result.reads.length, 2)
  }
})

test('ordinary send errors allow a later explicit send', async () => {
  let attempts = 0
  const result = await chat(['1', 'first', 'second', '/q'], {
    send: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Refused')
      return { delivery: 'accepted' }
    },
    threads: [[], [entry('reply', 'Done', 1)]]
  })
  assert.match(result.output, /Error: Refused/)
  assert.equal(result.sends.length, 2)
  assert.match(result.output, /Ada: Done/)
})

test('/q and end-of-input end cleanly at either prompt', async () => {
  for (const lines of [['/q'], [null], ['1', '/q'], ['1', null]]) {
    const result = await chat(lines)
    assert.equal(result.sends.length, 0)
    assert.equal(result.sleeps.length, 0)
  }
})

test('shutdown interrupts polling without another read or timeout notice', async () => {
  const result = await chat(['1', 'Hello'], { stopAfterSleep: true })
  assert.equal(result.reads.length, 1)
  assert.equal(result.sleeps.length, 1)
  assert.ok(!result.output.includes('Still working'))
})
