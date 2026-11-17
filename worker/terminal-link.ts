import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { NEXT, PING, READY, WINDOW, pack, parseFrame, unpack } from './relay-frames.ts'

export const TERMINAL_TITLE = 'Bot Team for Orca'
/** The panel polls while it is open, so this long without a request means nobody is using it. */
export const IDLE_MS = 10 * 60 * 1000
export type Bundle = { hash: string; files: Record<string, string> }
type Host = { id: string; name: string }
type Session = { host: Host; handle: string; cursor: string }
export type Saved = { hostId: string; handle: string }
export type LinkDeps = {
  /** Runs one Orca CLI command and returns its `result`. */
  call(args: string[]): Promise<any>
  bundle(): Promise<Bundle>
  sleep(ms: number): Promise<void>
  now(): number
  load(): Promise<Saved | undefined>
  save(saved: Saved | undefined): Promise<void>
  /** Runs `fn` after `ms` unless the returned function cancels it first. */
  later(ms: number, fn: () => void): () => void
}

/** An error the bot host answered with, as opposed to a broken connection. */
export class HostAnswer extends Error {}

// The loader is typed into the server's shell as plain JavaScript. It reads the bundle from the
// terminal, writes it under ~/.orca-bot/relay/<hash> and starts relay-host.ts with Node's own
// TypeScript support. Every statement ends in a semicolon so the lines can be joined; it uses
// no single quotes, so the shell passes it to Node unchanged.
const LOADER = [
  'const stdin = process.stdin;',
  'const fail = (error) => {',
  '  const reason = String((error && error.message) || error).replace(/[^\\w.-]+/g, "_");',
  '  process.stdout.write("@bt:fail:" + reason + "\\r\\n");',
  '  process.exit(1);',
  '};',
  'let buffer = "";',
  'const take = (chunk) => {',
  '  buffer += chunk;',
  '  const end = buffer.search(/[\\r\\n]/);',
  '  if (end < 0) return;',
  '  stdin.off("data", take);',
  '  stdin.pause();',
  '  try {',
  '    const fs = require("fs");',
  '    const path = require("path");',
  '    const os = require("os");',
  '    const url = require("url");',
  '    const zlib = require("zlib");',
  '    const packed = Buffer.from(buffer.slice(0, end), "base64");',
  '    const bundle = JSON.parse(zlib.gunzipSync(packed).toString("utf8"));',
  '    if (!/^[0-9a-f]{16}$/.test(bundle.hash)) throw new Error("bad bundle");',
  '    const folder = path.join(os.homedir(), ".orca-bot", "relay", bundle.hash);',
  '    fs.mkdirSync(path.join(folder, "worker"), { recursive: true });',
  '    fs.mkdirSync(path.join(folder, "shared"), { recursive: true });',
  '    fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ type: "module" }));',
  '    for (const [name, text] of Object.entries(bundle.files)) {',
  '      if (!/^(worker|shared)\\/[\\w.-]+\\.ts$/.test(name)) throw new Error("bad file name");',
  '      fs.writeFileSync(path.join(folder, name), text);',
  '    }',
  '    const entry = url.pathToFileURL(path.join(folder, "worker", "relay-host.ts")).href;',
  '    import(entry).then((relay) => relay.start(buffer.slice(end + 1), bundle.hash), fail);',
  '  } catch (error) {',
  '    fail(error);',
  '  }',
  '};',
  'if (stdin.setRawMode) stdin.setRawMode(true);',
  'stdin.setEncoding("utf8");',
  'stdin.on("data", take);',
  `process.stdout.write("${READY}\\r\\n");`
]

/** The command the server's shell runs: the loader on one line, in single quotes. */
export function loaderCommand(): string {
  const source = LOADER.map((line) => line.trim()).join(' ')
  if (source.includes("'")) throw new Error('The loader must not contain single quotes.')
  return ` node -e '${source}'`
}

/** The worker's own source, minus tests, as the server should run it. */
export async function pluginBundle(root = new URL('..', import.meta.url)): Promise<Bundle> {
  const files: Record<string, string> = {}
  for (const folder of ['worker', 'shared']) {
    for (const name of (await readdir(new URL(`${folder}/`, root))).sort()) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files[`${folder}/${name}`] = await readFile(new URL(`${folder}/${name}`, root), 'utf8')
    }
  }
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)
  return { hash, files }
}

export function createTerminalLink(deps: LinkDeps) {
  let session: Session | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let cancelIdle = () => {}
  const at = (s: Session) => ['--terminal', s.handle, '--environment', s.host.id, '--json']
  const send = (s: Session, text: string) => deps.call(['terminal', 'send', '--text', text, '--enter', ...at(s)])

  /** Reads new terminal lines until `take` says it has what it needs. */
  async function readUntil(s: Session, ms: number, take: (line: string) => Promise<boolean> | boolean): Promise<void> {
    const deadline = deps.now() + ms
    for (;;) {
      const terminal = (await deps.call(['terminal', 'read', '--cursor', s.cursor, '--limit', '1000', ...at(s)]))?.terminal
      if (!terminal || terminal.truncated) throw new Error('The connection to the bot host lost output.')
      if (terminal.nextCursor !== undefined) s.cursor = String(terminal.nextCursor)
      const lines: string[] = Array.isArray(terminal.tail) ? terminal.tail : []
      for (const line of lines) if (await take(line)) return
      if (terminal.status === 'exited') throw new Error('The connection to the bot host closed.')
      if (deps.now() > deadline) throw new Error('The bot host did not answer in time.')
      if (!lines.length) await deps.sleep(150)
    }
  }

  async function exchange(s: Session, name: string, input: unknown, ms = 30000): Promise<any> {
    const id = randomUUID().slice(0, 8)
    await send(s, pack({ id, name, input: input ?? {} }))
    const parts = new Map<number, string>()
    let total = 0
    await readUntil(s, ms, async line => {
      const frame = parseFrame(line)
      if (!frame || frame.id !== id) return false
      parts.set(frame.index, frame.data)
      total = frame.total
      if (parts.size === total) return true
      if (frame.index % WINDOW === 0) await send(s, NEXT)
      return false
    })
    let answer: { output?: unknown; error?: unknown }
    try { answer = unpack(Array.from({ length: total }, (_, i) => parts.get(i + 1) ?? '').join('')) }
    catch { throw new Error('The bot host sent a damaged answer.') }
    if (typeof answer.error === 'string') throw new HostAnswer(answer.error)
    return answer.output
  }

  async function reuse(host: Host, bundle: Bundle): Promise<Session | undefined> {
    const saved = await deps.load()
    if (saved?.hostId !== host.id) return undefined
    const s: Session = { host, handle: saved.handle, cursor: '0' }
    try {
      const terminal = (await deps.call(['terminal', 'read', '--limit', '1', ...at(s)]))?.terminal
      if (terminal?.status !== 'running') throw new Error('closed')
      s.cursor = String(terminal.latestCursor ?? terminal.nextCursor)
      if ((await exchange(s, PING, {}, 10000))?.hash === bundle.hash) return s
    } catch { /* Start a fresh connection below. */ }
    await close(s)
    return undefined
  }

  async function open(host: Host): Promise<Session> {
    const bundle = await deps.bundle()
    const reused = await reuse(host, bundle)
    if (reused) return reused
    const listed = await deps.call(['worktree', 'list', '--environment', host.id, '--json'])
    const trees: { id: string; isArchived?: boolean; isMainWorktree?: boolean }[] = (listed?.worktrees ?? []).filter((tree: any) => typeof tree?.id === 'string' && !tree.isArchived)
    const tree = trees.find(item => item.isMainWorktree) ?? trees[0]
    if (!tree) throw new Error(`Add a project to Orca on ${host.name} first. Bot Team for Orca connects through a terminal there.`)
    const created = await deps.call(['terminal', 'create', '--worktree', `id:${tree.id}`, '--title', TERMINAL_TITLE, '--command', loaderCommand(), '--environment', host.id, '--json'])
    const handle = created?.terminal?.handle
    if (typeof handle !== 'string') throw new Error(`Could not open a terminal on ${host.name}.`)
    const s: Session = { host, handle, cursor: '0' }
    await deps.save({ hostId: host.id, handle })
    try {
      await readUntil(s, 20000, line => {
        if (line.startsWith('@bt:fail') || /command not found|not recognized/.test(line)) throw new Error('loader')
        return line.trim() === READY
      })
      await send(s, pack(bundle))
      if ((await exchange(s, PING, {}, 20000))?.hash !== bundle.hash) throw new Error('version')
    } catch {
      await close(s)
      throw new Error(`Could not start Bot Team for Orca on ${host.name}. Check that Node.js 24 or newer is installed there.`)
    }
    return s
  }

  async function close(s: Session): Promise<void> {
    if (session === s) session = undefined
    await deps.call(['terminal', 'close', ...at(s)]).catch(() => {})
    const saved = await deps.load().catch(() => undefined)
    if (saved?.handle === s.handle) await deps.save(undefined).catch(() => {})
  }

  async function disconnect(): Promise<void> {
    cancelIdle()
    await queue
    if (session) await close(session)
  }

  return {
    /** Sends one panel request to the host's worker. Requests run one at a time. */
    request(host: Host, name: string, input: unknown): Promise<any> {
      const run = async () => {
        if (session && session.host.id !== host.id) await close(session)
        session ??= await open(host)
        const s = session
        try { return await exchange(s, name, input) }
        catch (error) {
          // A broken connection is replaced next time; an answer from the host is not.
          if (!(error instanceof HostAnswer)) await close(s)
          throw error
        }
      }
      cancelIdle()
      const result = queue.then(run, run)
      queue = result.catch(() => {})
      // Close the server's terminal once nobody has used it for a while; the next request reopens it.
      void queue.then(() => { if (queue === settled) cancelIdle = deps.later(IDLE_MS, () => void disconnect()) })
      const settled = queue
      return result
    },
    disconnect
  }
}

export function defaultLinkDeps(call: (args: string[]) => Promise<any>, storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }): LinkDeps {
  return {
    call,
    bundle: () => pluginBundle(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    later: (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer) },
    load: async () => {
      const value = await storage.get('pairedTerminal') as Saved | null
      return value && typeof value.hostId === 'string' && typeof value.handle === 'string' ? value : undefined
    },
    save: saved => storage.set('pairedTerminal', saved ?? null)
  }
}
