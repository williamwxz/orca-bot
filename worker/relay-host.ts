// Runs on a paired Orca server, inside a terminal the client opened there. It hosts the same
// worker the plugin runs locally and answers the client's requests over the terminal.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { defaultWorkerDeps, register } from './worker.ts'
import type { WorkerDeps } from './worker.ts'
import {
  defaultServerDeps,
  ensureInstalled,
  ensureServer,
  isPluginServer,
  stopServer
} from './omb-server.ts'
import type { ServerDeps } from './omb-server.ts'
import { defaultCliDeps } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'
import { openChat } from './omb-open.ts'
import { TESTED_OPENMAUSBOT_VERSION } from '../shared/omb-version.ts'
import { NEXT, PING, RELAYED, WINDOW, frames, lineReader, unpack } from './relay-frames.ts'

type Store = { storage: Record<string, unknown>; settings: Record<string, unknown> }
export type RelayIo = {
  write(text: string): void
  load(): Store | undefined
  save(store: Store): void
  hash: string
}

/**
 * Runs the same worker capabilities on the paired server, using detached launcher processes
 * so OpenMausBot survives terminal idle disconnects and `open-url` so the Bot Dashboard opens
 * inside the paired client desktop's Orca browser.
 */
export function pairedClientDeps(
  base: WorkerDeps = defaultWorkerDeps(),
  server: ServerDeps = { ...defaultServerDeps(), spawn: orphanSpawn },
  cli?: CliDeps
): WorkerDeps {
  return {
    ...base,
    ensureServer: (share, allowInstall) => ensureServer(server, share, allowInstall),
    prepareServer: (allowInstall) =>
      ensureInstalled(TESTED_OPENMAUSBOT_VERSION, server, allowInstall),
    stopServer: () => stopServer(server),
    openChat: async (input) => {
      const resolvedCli = cli ?? defaultCliDeps()
      return openChat(
        {
          ...input,
          clientBrowser: true,
          startedByPlugin: input.startedByPlugin && (await isPluginServer(input.port, server))
        },
        resolvedCli
      )
    },
    repairChat: undefined
  }
}

/**
 * Orca stops everything started from a terminal when it closes, so OpenMausBot is started
 * through a shell that exits at once: the launcher then belongs to the system, not to this
 * terminal, and the bots keep running after the connection closes. The shell prints the
 * launcher's process ID, which the stop signal needs.
 */
export function orphanSpawn(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', number, number] },
  spawnChild?: typeof spawn
): Promise<{ pid: number; unref(): void }> {
  if (!spawnChild && process.env.NODE_TEST_CONTEXT)
    throw new Error('Tests must inject relay spawn dependencies')
  const launch = spawnChild ?? spawn
  const script = '"$0" "$@" </dev/null >&3 2>&3 3>&- & echo $!'
  return new Promise((resolve, reject) => {
    const shell = launch('/bin/sh', ['-c', script, file, ...args], {
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore', options.stdio[1]]
    })
    let output = ''
    shell.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    shell.once('error', reject)
    shell.once('close', (code) => {
      const pid = Number(output.trim())
      if (code === 0 && Number.isSafeInteger(pid) && pid > 0) resolve({ pid, unref() {} })
      else reject(new Error('Could not start the OpenMausBot launcher.'))
    })
  })
}

export function createRelay(
  io: RelayIo,
  host: (api: OrcaWorkerApi) => void = (api) => register(api, pairedClientDeps())
): (chunk: string) => void {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>()
  const store: Store = io.load() ?? { storage: {}, settings: {} }
  const value = (bag: Record<string, unknown>, key: string) =>
    Promise.resolve(key in bag ? bag[key] : null)
  const set = (bag: Record<string, unknown>, key: string, next: unknown) => {
    bag[key] = next
    io.save(store)
    return Promise.resolve()
  }
  const disposable = { dispose() {} }
  host({
    panels: {
      handle: (name: string, handler: (input: unknown, context: unknown) => unknown) => {
        handlers.set(name, handler)
        return disposable
      }
    },
    commands: { register: () => disposable },
    storage: {
      get: (key: string) => value(store.storage, key),
      set: (key: string, next: unknown) => set(store.storage, key, next)
    },
    settings: {
      get: (key: string) => value(store.settings, key),
      set: (key: string, next: unknown) => set(store.settings, key, next)
    }
  } as unknown as OrcaWorkerApi)

  let reply: { lines: string[]; at: number } | undefined
  const flush = () => {
    if (!reply) return
    const end = Math.min(reply.lines.length, reply.at + WINDOW)
    io.write(
      reply.lines
        .slice(reply.at, end)
        .map((line) => `${line}\r\n`)
        .join('')
    )
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
        else if (!(RELAYED as readonly unknown[]).includes(request.name))
          throw new Error('Unsupported bot request.')
        else
          answer = {
            output: await handlers.get(request.name as string)!(request.input ?? {}, {
              panelId: 'paired-client'
            })
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
  const folder = join(homedir(), '.orca-bot')
  const file = join(folder, 'paired-client.json')
  // Earlier versions' code is no longer used once this one runs.
  try {
    for (const old of fs.readdirSync(join(folder, 'relay'))) {
      if (old !== hash && /^[0-9a-f]{16}$/.test(old))
        fs.rmSync(join(folder, 'relay', old), { recursive: true, force: true })
    }
  } catch {
    /* Nothing to tidy. */
  }
  const feed = createRelay({
    hash,
    write: (text) => {
      process.stdout.write(text)
    },
    load: () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return undefined
      }
    },
    save: (store) => {
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 })
    }
  })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', feed)
  process.stdin.resume()
  if (rest) feed(rest)
}
