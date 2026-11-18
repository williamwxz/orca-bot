import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir, userInfo, uptime } from 'node:os'
import { ombBinary } from './omb-cli.ts'
import { childEnvironment } from './child-environment.ts'
import { join, posix, win32 } from 'node:path'
import { createServer } from 'node:net'
import {
  TESTED_OPENMAUSBOT_VERSION,
  compareVersions,
  INSTALL_NOTICE
} from '../shared/omb-version.ts'

export type Server = { port: number; version: string }
export type ServerResult = Server & { started: boolean; startedByPlugin: boolean }
export type StopResult = { stopped: boolean; message: string }
export type ServerDeps = {
  pid: number
  uptimeMs?: () => number
  uniqueId(): string
  createExclusive(path: string, content: string): boolean
  modifiedAt(path: string): number
  fetch: (
    url: string,
    options: { signal: AbortSignal }
  ) => Promise<{ ok: boolean; json(): Promise<unknown> }>
  execFile: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number }
  ) => Promise<string>
  spawn: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; detached: true; stdio: ['ignore', number, number] }
  ) => Promise<{ pid: number; unref(): void }>
  isDirectory: (path: string) => boolean
  realpath: (path: string) => string
  exists: (path: string) => boolean
  readdir?: (path: string) => string[]
  mkdir: (path: string) => void
  open: (path: string) => number
  close: (fd: number) => void
  read: (path: string) => string
  write: (path: string, value: string) => void
  remove: (path: string) => void
  removeTree: (path: string) => void
  rename: (from: string, to: string) => void
  installAsset: (name: string) => string
  kill: (pid: number) => void
  processAlive: (pid: number) => boolean
  portFree: (port: number) => Promise<boolean>
  now: () => number
  sleep: (ms: number) => Promise<void>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  userInfo: () => { username: string; shell: string | null }
  home: string
  platform: string
  env: NodeJS.ProcessEnv
}

export class ServerError extends Error {
  state: 'needs_install' | 'needs_node' | 'install_failed' | 'start_failed'
  busy: boolean
  constructor(state: ServerError['state'], message: string, busy = false) {
    super(message)
    this.state = state
    this.busy = busy
  }
}

let defaults: ServerDeps | undefined
export function defaultServerDeps(): ServerDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject server dependencies')
  defaults ??= {
    pid: process.pid,
    uptimeMs: () => uptime() * 1000,
    uniqueId: randomUUID,
    createExclusive: (path, content) => {
      let fd: number
      try {
        fd = fs.openSync(path, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
      try {
        fs.writeFileSync(fd, content)
      } finally {
        fs.closeSync(fd)
      }
      return true
    },
    modifiedAt: (path) => fs.statSync(path).mtimeMs,
    fetch: (url, options) => fetch(url, options),
    execFile: (file, args, options) =>
      new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stderr}`))
          else resolve(stdout)
        })
      }),
    spawn: (file, args, options) =>
      new Promise((resolve, reject) => {
        const child = spawn(file, args, options)
        child.once('error', reject)
        child.once('spawn', () => resolve({ pid: child.pid!, unref: () => child.unref() }))
      }),
    isDirectory: (path) => fs.statSync(path).isDirectory(),
    realpath: fs.realpathSync,
    exists: fs.existsSync,
    readdir: fs.readdirSync,
    mkdir: (path) => {
      fs.mkdirSync(path, { recursive: true, mode: 0o700 })
    },
    open: (path) => fs.openSync(path, 'w', 0o600),
    close: fs.closeSync,
    read: (path) => fs.readFileSync(path, 'utf8'),
    write: (path, value) => fs.writeFileSync(path, value, { mode: 0o600 }),
    remove: fs.unlinkSync,
    removeTree: (path) => fs.rmSync(path, { recursive: true, force: true }),
    rename: fs.renameSync,
    installAsset: (name) =>
      fs.readFileSync(new URL(`./install-assets/${name}`, import.meta.url), 'utf8'),
    kill: (pid) => {
      process.kill(pid, 'SIGTERM')
    },
    processAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    portFree: (port) =>
      new Promise((resolve) => {
        const probe = createServer()
        probe.once('error', () => resolve(false))
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
      }),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    userInfo,
    home: homedir(),
    platform: process.platform,
    env: { ...process.env }
  }
  return defaults
}

// Async context makes nested lifecycle operations reentrant without admitting another request.
const MAX_LOCK_HOLD_MS = 15 * 60 * 1000
const heldLocks = new AsyncLocalStorage<Set<string>>()
export async function withServerLock<T>(deps: ServerDeps, operation: () => Promise<T>): Promise<T> {
  const path = join(deps.home, '.orca-bot/server.lock')
  if (heldLocks.getStore()?.has(path)) return operation()
  const token = deps.uniqueId()
  const record = JSON.stringify({ pid: deps.pid, createdAt: deps.now(), token })
  const deadline = deps.now() + 10000
  try {
    deps.mkdir(join(deps.home, '.orca-bot'))
  } catch {
    throw new ServerError('start_failed', 'Could not lock the bot lifecycle on this host.')
  }
  for (;;) {
    try {
      if (deps.createExclusive(path, record)) break
    } catch {
      throw new ServerError('start_failed', 'Could not lock the bot lifecycle on this host.')
    }
    try {
      const text = deps.read(path)
      let stale = false
      try {
        const owner = JSON.parse(text)
        const now = deps.now()
        const expired =
          !Number.isFinite(owner.createdAt) || now - owner.createdAt > MAX_LOCK_HOLD_MS
        const beforeBoot = deps.uptimeMs !== undefined && owner.createdAt < now - deps.uptimeMs()
        stale =
          Number.isSafeInteger(owner.pid) && owner.pid > 0
            ? !deps.processAlive(owner.pid) || expired || beforeBoot
            : now - deps.modifiedAt(path) > 30000
      } catch {
        stale = deps.now() - deps.modifiedAt(path) > 30000
      }
      // Bound leaked locks even when the owner's PID was reused after a crash or reboot.
      if (stale && deps.read(path) === text) {
        deps.remove(path)
        continue
      }
    } catch {
      /* Another process may have released the lock. */
    }
    if (deps.now() >= deadline)
      throw new ServerError(
        'start_failed',
        'Another bot lifecycle operation is in progress. Please retry shortly.',
        true
      )
    await deps.sleep(100)
  }
  try {
    return await heldLocks.run(new Set([...(heldLocks.getStore() ?? []), path]), operation)
  } finally {
    try {
      if (deps.read(path) === record) deps.remove(path)
    } catch {
      /* Already removed. */
    }
  }
}

const ENV_VERSION = 2
const ports = [8799, 18799, 28799]
type Health = { app: 'openmausbot'; version: string; pid?: number }
async function health(
  port: number,
  deps: ServerDeps,
  timeoutMs = 1500
): Promise<Health | undefined> {
  const controller = new AbortController()
  let timer: unknown
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = deps.setTimer(() => {
        controller.abort()
        resolve(undefined)
      }, timeoutMs)
    })
    const request = async (): Promise<Health | undefined> => {
      const response = await deps.fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: controller.signal
      })
      if (!response.ok) return undefined
      const value = (await response.json()) as Partial<Health> | null
      if (value?.app !== 'openmausbot') return undefined
      const version =
        typeof value.version === 'string' && value.version.trim() ? value.version : 'unknown'
      return { app: 'openmausbot', version, pid: value.pid }
    }
    return await Promise.race([request(), timeout])
  } catch {
    return undefined
  } finally {
    deps.clearTimer(timer)
  }
}

export async function serverHealthy(
  port: number,
  deps: ServerDeps = defaultServerDeps()
): Promise<boolean> {
  return !!(await health(port, deps, 1000))
}

export async function findServer(
  deps: ServerDeps = defaultServerDeps()
): Promise<Server | undefined> {
  for (const port of ports) {
    const result = await health(port, deps)
    if (result) return { port, version: result.version }
  }
  return undefined
}

// Only this private helper handles the selected path; public results contain flags only.
export function claudeEnvironment(
  deps: Pick<
    ServerDeps,
    'platform' | 'home' | 'env' | 'read' | 'realpath' | 'isDirectory' | 'userInfo'
  >,
  share: boolean
) {
  const path = deps.platform === 'win32' ? win32 : posix
  let home: string | undefined
  try {
    const data =
      deps.platform === 'darwin'
        ? path.join(deps.home, 'Library/Application Support/orca')
        : deps.platform === 'win32'
          ? path.join(deps.env.APPDATA ?? path.join(deps.home, 'AppData/Roaming'), 'orca')
          : path.join(deps.env.XDG_CONFIG_HOME || path.join(deps.home, '.config'), 'orca')
    const profiles = path.join(data, 'claude-profiles')
    const selected = deps.read(path.join(profiles, 'selected-host')).trim()
    const inside = (root: string, target: string) => {
      const relative = path.relative(root, target)
      return (
        !!relative &&
        relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative)
      )
    }
    if (
      path.isAbsolute(selected) &&
      path.basename(selected) === 'home' &&
      inside(profiles, selected) &&
      inside(deps.realpath(profiles), deps.realpath(selected)) &&
      deps.isDirectory(selected)
    )
      home = selected
  } catch {
    /* Missing or invalid selection is normal; never expose filesystem errors. */
  }
  const env = childEnvironment(deps)
  if (home && env.CLAUDE_CONFIG_DIR === undefined) env.CLAUDE_CONFIG_DIR = home
  // The setting controls this override even if the parent process supplied it.
  delete env.OMB_CLAUDE_INHERIT_USER_CONFIG
  if (share) env.OMB_CLAUDE_INHERIT_USER_CONFIG = '1'
  return { env, flags: { claudeHome: !!env.CLAUDE_CONFIG_DIR, inherit: share }, found: !!home }
}

async function ownedServer(
  port: number,
  deps: ServerDeps
): Promise<{ record: Record<string, any>; running: Health } | undefined> {
  try {
    const record = JSON.parse(deps.read(join(deps.home, '.orca-bot/server.pid')))
    if (record.port !== port || !Number.isSafeInteger(record.serverPid) || record.serverPid <= 0)
      return undefined
    const running = await health(port, deps)
    return running?.pid === record.serverPid ? { record, running } : undefined
  } catch {
    return undefined
  }
}

export async function claudeSetupStatus(
  port: number,
  share: boolean,
  deps: ServerDeps = defaultServerDeps()
): Promise<{ restart: boolean; message: string; updating?: boolean }> {
  const owned = await ownedServer(port, deps)
  if (!owned) return { restart: false, message: '' }
  if ((compareVersions(owned.running.version, TESTED_OPENMAUSBOT_VERSION) ?? 0) < 0)
    return {
      restart: true,
      updating: true,
      message: `OpenMausBot will update to ${TESTED_OPENMAUSBOT_VERSION} when bots are idle.`
    }
  const { flags, found } = claudeEnvironment(deps, share)
  const { record } = owned
  const restart =
    !Number.isInteger(record.env) ||
    record.env < ENV_VERSION ||
    record.claudeHome !== flags.claudeHome ||
    record.inherit !== flags.inherit
  return {
    restart,
    message: !found ? '' : restart ? 'Claude setup changes will apply when bots are idle.' : ''
  }
}

export async function checkNode(deps: ServerDeps = defaultServerDeps()): Promise<string> {
  let version: string
  try {
    version = (
      await deps.execFile('node', ['--version'], { env: childEnvironment(deps), timeout: 10000 })
    )
      .trim()
      .replace(/^v/, '')
  } catch {
    throw new ServerError(
      'needs_node',
      'Node.js was not found on PATH. Install Node.js 24 or newer, then press Retry.'
    )
  }
  if (!/^\d+(\.\d+)*$/.test(version) || (compareVersions(version, '24') ?? -1) < 0) {
    throw new ServerError(
      'needs_node',
      `Node.js ${version} is too old or unsupported. Install Node.js 24 or newer, then press Retry.`
    )
  }
  return version
}

export function validateInstallLock(manifest: string, source: string, version: string): void {
  const pkg = JSON.parse(manifest)
  const lock = JSON.parse(source)
  if (
    version !== TESTED_OPENMAUSBOT_VERSION ||
    pkg.dependencies?.openmausbot !== version ||
    lock.lockfileVersion !== 3 ||
    lock.packages?.[''].dependencies?.openmausbot !== version ||
    lock.packages?.['node_modules/openmausbot']?.version !== version
  )
    throw new Error('Invalid pinned OpenMausBot lockfile.')
  for (const [name, entry] of Object.entries(lock.packages) as [string, any][]) {
    if (!name) continue
    if (
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? '') ||
      !entry.resolved?.startsWith('https://registry.npmjs.org/')
    )
      throw new Error('Every installed package must have a pinned npm SHA-512 integrity hash.')
  }
}

async function installUnlocked(
  version: string,
  deps: ServerDeps = defaultServerDeps(),
  allowInstall = false
): Promise<string> {
  if (version !== TESTED_OPENMAUSBOT_VERSION)
    throw new ServerError('install_failed', 'Invalid OpenMausBot version.')
  const folder = join(deps.home, '.orca-bot/openmausbot', version)
  const bin = join(folder, 'node_modules/.bin/openmausbot')
  if (deps.exists(bin)) return bin
  if (!allowInstall) throw new ServerError('needs_install', INSTALL_NOTICE)
  const staging = `${folder}.staging-${deps.pid}-${deps.uniqueId()}`
  // Only dead owners' unique staging directories are eligible for cleanup.
  let stagingEntries: string[] = []
  try {
    stagingEntries = deps.readdir?.(join(deps.home, '.orca-bot/openmausbot')) ?? []
  } catch {
    /* First install. */
  }
  for (const name of stagingEntries) {
    const match = name.match(/^[0-9.]+\.staging-(\d+)-[a-zA-Z0-9-]+$/)
    if (match && !deps.processAlive(Number(match[1])))
      deps.removeTree(join(deps.home, '.orca-bot/openmausbot', name))
  }
  try {
    const manifest = deps.installAsset('package.json')
    const lock = deps.installAsset('package-lock.json')
    validateInstallLock(manifest, lock, version)
    deps.removeTree(staging)
    deps.mkdir(staging)
    deps.write(join(staging, 'package.json'), manifest)
    deps.write(join(staging, 'package-lock.json'), lock)
    // npm ci checks every fetched tarball against the committed SHA-512 hashes.
    // No lifecycle scripts or mutable dependency resolution run during installation.
    await deps.execFile(
      'npm',
      [
        'ci',
        '--prefix',
        staging,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
        '--cache',
        join(staging, '.npm-cache')
      ],
      { env: childEnvironment(deps), timeout: 300000 }
    )
    if (!deps.exists(join(staging, 'node_modules/.bin/openmausbot')))
      throw new Error('Missing OpenMausBot binary.')
    deps.removeTree(join(staging, '.npm-cache'))
    deps.removeTree(folder)
    deps.rename(staging, folder)
    return bin
  } catch (error) {
    const integrity = /integrity|EINTEGRITY|sha512/i.test(String(error))
    throw new ServerError(
      'install_failed',
      integrity
        ? 'OpenMausBot integrity verification failed. Installation was refused; please retry.'
        : 'Could not install verified OpenMausBot. Check Node.js and your network, then press Retry.'
    )
  } finally {
    deps.removeTree(staging)
  }
}

async function startUnlocked(
  bin: string,
  port: number,
  deps: ServerDeps = defaultServerDeps(),
  share = false
): Promise<Server> {
  try {
    const setup = claudeEnvironment(deps, share)
    const folder = join(deps.home, '.orca-bot')
    deps.mkdir(folder)
    const fd = deps.open(join(folder, 'server.log'))
    let child: { pid: number; unref(): void }
    try {
      // Bot Team for Orca keeps its own OpenMausBot workspace, apart from any the person already has in
      // ~/.openmausbot, so starting it never resumes routines or connections they set up elsewhere.
      const dataDir = join(folder, 'data')
      deps.mkdir(dataDir)
      child = await deps.spawn(bin, ['serve', '--port', String(port), '--data-dir', dataDir], {
        env: setup.env,
        detached: true,
        stdio: ['ignore', fd, fd]
      })
      child.unref()
    } finally {
      deps.close(fd)
    }
    const deadline = deps.now() + 30000
    while (deps.now() < deadline) {
      const result = await health(port, deps, Math.min(1500, deadline - deps.now()))
      if (!deps.processAlive(child.pid))
        throw new Error('The OpenMausBot launcher exited before the server became ready.')
      if (result && Number.isSafeInteger(result.pid) && result.pid! > 0) {
        // The launcher owns the listening child and must receive the stop signal.
        deps.write(
          join(folder, 'server.pid'),
          JSON.stringify({
            launcherPid: child.pid,
            serverPid: result.pid,
            port,
            ...setup.flags,
            env: ENV_VERSION
          })
        )
        return { port, version: result.version }
      }
      await deps.sleep(Math.min(250, Math.max(0, deadline - deps.now())))
    }
    throw new Error('The server did not become healthy within 30 seconds.')
  } catch (error) {
    // The log may contain a pairing code; never include its contents in an error.
    throw new ServerError(
      'start_failed',
      `Could not start OpenMausBot. Check ~/.orca-bot/server.log locally, then press Retry. ${error instanceof Error && ['The server did not become healthy within 30 seconds.', 'The OpenMausBot launcher exited before the server became ready.'].includes(error.message) ? error.message : 'Server launch failed.'}`
    )
  }
}

export async function isPluginServer(
  port: number,
  deps: ServerDeps = defaultServerDeps()
): Promise<boolean> {
  return !!(await ownedServer(port, deps))
}

const attempts = new WeakMap<ServerDeps, Promise<ServerResult>>()
export function ensureServer(
  deps: ServerDeps = defaultServerDeps(),
  share = false,
  allowInstall = false
): Promise<ServerResult> {
  const existing = attempts.get(deps)
  if (existing && !heldLocks.getStore()?.has(join(deps.home, '.orca-bot/server.lock')))
    return existing
  const attempt = async (): Promise<ServerResult> => {
    let stopped = false
    try {
      stopped =
        JSON.parse(deps.read(join(deps.home, '.orca-bot/preferences.json'))).stopped === true
    } catch {
      /* No saved stop choice. */
    }
    if (stopped)
      throw new ServerError(
        'start_failed',
        'OpenMausBot was stopped. Press Retry to start it again.'
      )
    const running = await findServer(deps)
    if (running)
      return {
        ...running,
        started: false,
        startedByPlugin: await isPluginServer(running.port, deps)
      }
    const existingBin = ombBinary(deps)
    if (!allowInstall && !deps.exists(existingBin))
      throw new ServerError('needs_install', INSTALL_NOTICE)
    await checkNode(deps)
    const bin =
      !allowInstall && deps.exists(existingBin)
        ? existingBin
        : await ensureInstalled(TESTED_OPENMAUSBOT_VERSION, deps, allowInstall)
    for (const port of ports) {
      if (!(await deps.portFree(port))) continue
      return {
        ...(await startUnlocked(bin, port, deps, share)),
        started: true,
        startedByPlugin: true
      }
    }
    throw new ServerError(
      'start_failed',
      'Ports 8799, 18799 and 28799 are in use. Free one of these ports, then press Retry.'
    )
  }
  if (heldLocks.getStore()?.has(join(deps.home, '.orca-bot/server.lock'))) return attempt()
  const promise = withServerLock(deps, attempt).finally(() => attempts.delete(deps))
  attempts.set(deps, promise)
  return promise
}

async function stopUnlocked(deps: ServerDeps = defaultServerDeps()): Promise<StopResult> {
  const path = join(deps.home, '.orca-bot/server.pid')
  try {
    const record = JSON.parse(deps.read(path)) as {
      launcherPid: number
      serverPid: number
      port: number
    }
    if (
      !Number.isSafeInteger(record.launcherPid) ||
      record.launcherPid <= 0 ||
      !Number.isSafeInteger(record.serverPid) ||
      record.serverPid <= 0 ||
      !ports.includes(record.port)
    )
      throw new Error('Invalid pid file')
    const result = await health(record.port, deps)
    if (!result || result.pid !== record.serverPid || !deps.processAlive(record.launcherPid))
      return {
        stopped: false,
        message: 'Server identity did not match the pid file; no signal was sent.'
      }
    deps.kill(record.launcherPid)
    const deadline = deps.now() + 10000
    while (deps.now() < deadline) {
      const remaining = await health(record.port, deps, Math.min(1500, deadline - deps.now()))
      if (!remaining) {
        deps.remove(path)
        return {
          stopped: true,
          message: 'Stopped the OpenMausBot server started by Bot Team for Orca.'
        }
      }
      await deps.sleep(Math.min(250, Math.max(0, deadline - deps.now())))
    }
    return {
      stopped: false,
      message:
        'Sent the stop signal, but OpenMausBot health is still responding. The pid file was kept; try stopping again.'
    }
  } catch {
    return {
      stopped: false,
      message:
        'Could not verify or stop a server started by Bot Team for Orca; no other server was touched.'
    }
  }
}

export { INSTALL_NOTICE } from '../shared/omb-version.ts'

export function ensureInstalled(
  version: string,
  deps = defaultServerDeps(),
  allowInstall = false
): Promise<string> {
  return withServerLock(deps, () => installUnlocked(version, deps, allowInstall))
}
export function startServer(
  bin: string,
  port: number,
  deps = defaultServerDeps(),
  share = false
): Promise<Server> {
  return withServerLock(deps, async () => {
    const existing = await findServer(deps)
    return existing ?? startUnlocked(bin, port, deps, share)
  })
}
export function stopServer(deps = defaultServerDeps()): Promise<StopResult> {
  return withServerLock(deps, () => stopUnlocked(deps))
}
