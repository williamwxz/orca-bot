import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '../src/worker.ts'
import { runChat } from './chat.ts'

console.log('Bot Deck terminal chat. /h for help.')
const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
const input = lines[Symbol.asyncIterator]()
const stop = new AbortController()
const close = () => {
  stop.abort()
  lines.close()
}
process.on('SIGINT', close)
lines.on('close', () => stop.abort())

try {
  const { client } = createClient({
    network: {
      // Closing the terminal also releases a pending HTTP request.
      fetch: (url, init) => fetch(url, {
        ...init,
        signal: AbortSignal.any([stop.signal, ...(init?.signal ? [init.signal] : [])])
      })
    }
  })
  await runChat(client, {
    readLine: async prompt => {
      process.stdout.write(prompt)
      const line = await input.next()
      return line.done ? null : line.value
    },
    write: text => { process.stdout.write(text) },
    now: Date.now,
    sleep: async ms => {
      try {
        await sleep(ms, undefined, { signal: stop.signal })
      } catch (error) {
        if (!stop.signal.aborted) throw error
      }
    },
    stopped: () => stop.signal.aborted
  })
} catch (error) {
  console.error(error instanceof Error ? error.message.replace(/\s+/g, ' ') : 'Could not start chat.')
  process.exitCode = 1
} finally {
  close()
  process.off('SIGINT', close)
}
