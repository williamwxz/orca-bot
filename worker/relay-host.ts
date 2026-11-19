// Runs on a paired Orca server, inside a terminal the client opened there. It hosts the same
// worker the plugin runs locally and answers the client's requests over the terminal.
import type { OrcaWorkerApi } from 'orca/worker'
import { register } from './worker.ts'
import { NEXT, PING, RELAYED, WINDOW, frames, lineReader, unpack, validateRelayInput } from './relay-frames.ts'

export type RelayIo = { write(text: string): void; hash: string }

/** Feeds the client's request lines to the worker's handlers and writes each answer back in frames. */
export function createRelay(io: RelayIo, host: (api: OrcaWorkerApi) => void = (api) => register(api)): (chunk: string) => void {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>()
  const disposable = { dispose() {} }
  const nothing = { get: () => Promise.resolve(null), set: () => Promise.resolve() }
  host({
    panels: {
      handle: (name: string, handler: (input: unknown, context: unknown) => unknown) => {
        handlers.set(name, handler)
        return disposable
      }
    },
    commands: { register: () => disposable },
    // The worker keeps nothing between runs; which host to use is the client's own choice.
    storage: nothing,
    settings: nothing
  } as unknown as OrcaWorkerApi)

  let reply: { lines: string[]; at: number } | undefined
  const flush = () => {
    if (!reply) return
    const end = Math.min(reply.lines.length, reply.at + WINDOW)
    io.write(reply.lines.slice(reply.at, end).map((line) => `${line}\r\n`).join(''))
    reply.at = end
    if (end === reply.lines.length) reply = undefined
  }
  let queue = Promise.resolve()
  return lineReader((line) => {
    if (line === NEXT) return flush()
    let request: { id?: unknown; name?: unknown; input?: unknown }
    try {
      request = unpack(line)
    } catch {
      return
    }
    const id = request?.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(id)) return
    queue = queue.then(async () => {
      let answer: { output?: unknown; error?: string }
      try {
        if (request.name === PING) answer = { output: { hash: io.hash } }
        else if (!(RELAYED as readonly unknown[]).includes(request.name)) throw new Error('Unsupported bot request.')
        else {
          validateRelayInput(request.name, request.input)
          answer = { output: await handlers.get(request.name as string)!(request.input ?? {}, { panelId: 'paired-client' }) }
        }
      } catch (error) {
        answer = { error: error instanceof Error ? error.message : 'The bot request failed.' }
      }
      reply = { lines: frames(id, answer), at: 0 }
      flush()
    })
  })
}

/** Called by the loader the client typed into this terminal, with any input it already read. */
export function start(rest: string, hash: string): void {
  const feed = createRelay({ hash, write: (text) => void process.stdout.write(text) })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', feed)
  process.stdin.resume()
  if (rest) feed(rest)
}
