import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { childEnvironment } from './child-environment.ts'
import { join, posix, win32 } from 'node:path'
import { createServer } from 'node:net'
import { TESTED_OPENMAUSBOT_VERSION, compareVersions } from '../shared/omb-version.ts'

export type Server = { port: number; version: string }
export type ServerResult = Server & { started: boolean; startedByPlugin: boolean }
export type StopResult = { stopped: boolean; message: string }
export type ServerDeps = {
  fetch: (url: string, options: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>
  execFile: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<string>
  spawn: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; detached: true; stdio: ['ignore', number, number] }) => Promise<{ pid: number; unref(): void }>
  isDirectory: (path: string) => boolean
  realpath: (path: string) => string
  exists: (path: string) => boolean
  mkdir: (path: string) => void
  open: (path: string) => number
  close: (fd: number) => void
  read: (path: string) => string
  write: (path: string, value: string) => void
  remove: (path: string) => void
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
  state: 'needs_node' | 'install_failed' | 'start_failed'
  constructor(state: ServerError['state'], message: string) {
    super(message)
    this.state = state
  }
}

let defaults: ServerDeps | undefined
export function defaultServerDeps(): ServerDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject server dependencies')
  defaults ??= {
    fetch: (url, options) => fetch(url, options),
    execFile: (file, args, options) => new Promise((resolve, reject) => {
      execFile(file, args, options, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`))
        else resolve(stdout)
      })
    }),
    spawn: (file, args, options) => new Promise((resolve, reject) => {
      const child = spawn(file, args, options)
      child.once('error', reject)
      child.once('spawn', () => resolve({ pid: child.pid!, unref: () => child.unref() }))
    }),
    isDirectory: (path) => fs.statSync(path).isDirectory(),
    realpath: fs.realpathSync,
    exists: fs.existsSync,
    mkdir: (path) => { fs.mkdirSync(path, { recursive: true, mode: 0o700 }) },
    open: (path) => fs.openSync(path, 'w', 0o600),
    close: fs.closeSync,
    read: (path) => fs.readFileSync(path, 'utf8'),
    write: (path, value) => fs.writeFileSync(path, value, { mode: 0o600 }),
    remove: fs.unlinkSync,
    kill: (pid) => { process.kill(pid, 'SIGTERM') },
    processAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    portFree: (port) => new Promise((resolve) => {
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

const ENV_VERSION = 2
const ports = [8799, 18799, 28799]
type Health = { app: 'openmausbot'; version: string; pid?: number }
async function health(port: number, deps: ServerDeps, timeoutMs = 1500): Promise<Health | undefined> {
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
      const response = await deps.fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
      if (!response.ok) return undefined
      const value = await response.json() as Partial<Health> | null
      if (value?.app !== 'openmausbot') return undefined
      const version = typeof value.version === 'string' && value.version.trim() ? value.version : 'unknown'
      return { app: 'openmausbot', version, pid: value.pid }
    }
    return await Promise.race([request(), timeout])
  } catch {
    return undefined
  } finally {
    deps.clearTimer(timer)
  }
}

export async function serverHealthy(port: number, deps: ServerDeps = defaultServerDeps()): Promise<boolean> {
  return !!await health(port, deps, 1000)
}

export async function findServer(deps: ServerDeps = defaultServerDeps()): Promise<Server | undefined> {
  for (const port of ports) {
    const result = await health(port, deps)
    if (result) return { port, version: result.version }
  }
  return undefined
}

// Only this private helper handles the selected path; public results contain flags only.
export function claudeEnvironment(deps: Pick<ServerDeps, 'platform' | 'home' | 'env' | 'read' | 'realpath' | 'isDirectory' | 'userInfo'>, share: boolean) {
  const path = deps.platform === 'win32' ? win32 : posix
  let home: string | undefined
  try {
    const data = deps.platform === 'darwin' ? path.join(deps.home, 'Library/Application Support/orca')
      : deps.platform === 'win32' ? path.join(deps.env.APPDATA ?? path.join(deps.home, 'AppData/Roaming'), 'orca')
      : path.join(deps.env.XDG_CONFIG_HOME || path.join(deps.home, '.config'), 'orca')
    const profiles = path.join(data, 'claude-profiles')
    const selected = deps.read(path.join(profiles, 'selected-host')).trim()
    const inside = (root: string, target: string) => {
      const relative = path.relative(root, target)
      return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    }
    if (path.isAbsolute(selected) && path.basename(selected) === 'home' && inside(profiles, selected)
      && inside(deps.realpath(profiles), deps.realpath(selected)) && deps.isDirectory(selected)) home = selected
  } catch { /* Missing or invalid selection is normal; never expose filesystem errors. */ }
  const env = childEnvironment(deps)
  if (home && env.CLAUDE_CONFIG_DIR === undefined) env.CLAUDE_CONFIG_DIR = home
  // The setting controls this override even if the parent process supplied it.
  delete env.OMB_CLAUDE_INHERIT_USER_CONFIG
  if (share) env.OMB_CLAUDE_INHERIT_USER_CONFIG = '1'
  return { env, flags: { claudeHome: !!env.CLAUDE_CONFIG_DIR, inherit: share }, found: !!home }
}

export async function claudeSetupStatus(port: number, share: boolean, deps: ServerDeps = defaultServerDeps()): Promise<{ restart: boolean; message: string }> {
  if (!await isPluginServer(port, deps)) return { restart: false, message: '' }
  const { flags, found } = claudeEnvironment(deps, share)
  try {
    const record = JSON.parse(deps.read(join(deps.home, '.orca-bot/server.pid')))
    const restart = !Number.isInteger(record.env) || record.env < ENV_VERSION || record.claudeHome !== flags.claudeHome || record.inherit !== flags.inherit
    return { restart, message: !found ? '' : restart ? 'Claude setup changes will apply when bots are idle.'
      : '' }
  } catch { return { restart: false, message: '' } }
}

export async function checkNode(deps: ServerDeps = defaultServerDeps()): Promise<string> {
  let version: string
  try {
    version = (await deps.execFile('node', ['--version'], { env: childEnvironment(deps), timeout: 10000 })).trim().replace(/^v/, '')
  } catch {
    throw new ServerError('needs_node', 'Node.js was not found on PATH. Install Node.js 24 or newer, then press Retry.')
  }
  if (!/^\d+(\.\d+)*$/.test(version) || (compareVersions(version, '24') ?? -1) < 0) {
    throw new ServerError('needs_node', `Node.js ${version} is too old or unsupported. Install Node.js 24 or newer, then press Retry.`)
  }
  return version
}

function redact(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:[\w-]*token|password|secret|authorization|_auth)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\b(?:npm_|gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .split('\n').slice(-12).join('\n')
}

export async function ensureInstalled(version: string, deps: ServerDeps = defaultServerDeps()): Promise<string> {
  if (!/^\d+(\.\d+)*$/.test(version)) throw new ServerError('install_failed', 'Invalid OpenMausBot version.')
  const folder = join(deps.home, '.orca-bot/openmausbot', version)
  const bin = join(folder, 'node_modules/.bin/openmausbot')
  if (deps.exists(bin)) return bin
  try {
    await deps.execFile('npm', ['install', '--prefix', folder, '--no-audit', '--no-fund', '--ignore-scripts', `openmausbot@${version}`], { env: childEnvironment(deps), timeout: 300000 })
    if (!deps.exists(bin)) throw new Error('npm finished without installing the OpenMausBot binary.')
    return bin
  } catch (error) {
    throw new ServerError('install_failed', `Could not install OpenMausBot. Check your network and npm setup, then press Retry.\n${redact(error)}`)
  }
}

export async function startServer(bin: string, port: number, deps: ServerDeps = defaultServerDeps(), share = false): Promise<Server> {
  try {
    const setup = claudeEnvironment(deps, share)
    const folder = join(deps.home, '.orca-bot')
    deps.mkdir(folder)
    const fd = deps.open(join(folder, 'server.log'))
    let child: { pid: number; unref(): void }
    try {
      // Orca Bot keeps its own OpenMausBot workspace, apart from any the person already has in
      // ~/.openmausbot, so starting it never resumes routines or connections they set up elsewhere.
      const dataDir = join(folder, 'data')
      deps.mkdir(dataDir)
      child = await deps.spawn(bin, ['serve', '--port', String(port), '--data-dir', dataDir], { env: setup.env, detached: true, stdio: ['ignore', fd, fd] })
      child.unref()
    } finally {
      deps.close(fd)
    }
    const deadline = deps.now() + 30000
    while (deps.now() < deadline) {
      const result = await health(port, deps, Math.min(1500, deadline - deps.now()))
      if (!deps.processAlive(child.pid)) throw new Error('The OpenMausBot launcher exited before the server became ready.')
      if (result && Number.isSafeInteger(result.pid) && result.pid! > 0) {
        // The launcher owns the listening child and must receive the stop signal.
        deps.write(join(folder, 'server.pid'), JSON.stringify({ launcherPid: child.pid, serverPid: result.pid, port, ...setup.flags, env: ENV_VERSION }))
        return { port, version: result.version }
      }
      await deps.sleep(Math.min(250, Math.max(0, deadline - deps.now())))
    }
    throw new Error('The server did not become healthy within 30 seconds.')
  } catch (error) {
    // The log may contain a pairing code; never include its contents in an error.
    throw new ServerError('start_failed', `Could not start OpenMausBot. Check ~/.orca-bot/server.log locally, then press Retry. ${error instanceof Error && ['The server did not become healthy within 30 seconds.', 'The OpenMausBot launcher exited before the server became ready.'].includes(error.message) ? error.message : 'Server launch failed.'}`)
  }
}

export async function isPluginServer(port: number, deps: ServerDeps = defaultServerDeps()): Promise<boolean> {
  try {
    const record = JSON.parse(deps.read(join(deps.home, '.orca-bot/server.pid')))
    if (record.port !== port || !Number.isSafeInteger(record.serverPid) || record.serverPid <= 0) return false
    const running = await health(port, deps)
    return running?.pid === record.serverPid
  } catch {
    return false
  }
}

const attempts = new WeakMap<ServerDeps, Promise<ServerResult>>()
export function ensureServer(deps: ServerDeps = defaultServerDeps(), share = false): Promise<ServerResult> {
  const existing = attempts.get(deps)
  if (existing) return existing
  const attempt = async (): Promise<ServerResult> => {
    const running = await findServer(deps)
    if (running) return { ...running, started: false, startedByPlugin: await isPluginServer(running.port, deps) }
    await checkNode(deps)
    const bin = await ensureInstalled(TESTED_OPENMAUSBOT_VERSION, deps)
    for (const port of ports) {
      if (!await deps.portFree(port)) continue
      return { ...await startServer(bin, port, deps, share), started: true, startedByPlugin: true }
    }
    throw new ServerError('start_failed', 'Ports 8799, 18799 and 28799 are in use. Free one of these ports, then press Retry.')
  }
  const promise = attempt().finally(() => attempts.delete(deps))
  attempts.set(deps, promise)
  return promise
}

export async function stopServer(deps: ServerDeps = defaultServerDeps()): Promise<StopResult> {
  const path = join(deps.home, '.orca-bot/server.pid')
  try {
    const record = JSON.parse(deps.read(path)) as { launcherPid: number; serverPid: number; port: number }
    if (!Number.isSafeInteger(record.launcherPid) || record.launcherPid <= 0 || !Number.isSafeInteger(record.serverPid) || record.serverPid <= 0 || !ports.includes(record.port)) throw new Error('Invalid pid file')
    const result = await health(record.port, deps)
    if (!result || result.pid !== record.serverPid || !deps.processAlive(record.launcherPid)) return { stopped: false, message: 'Server identity did not match the pid file; no signal was sent.' }
    deps.kill(record.launcherPid)
    const deadline = deps.now() + 10000
    while (deps.now() < deadline) {
      const remaining = await health(record.port, deps, Math.min(1500, deadline - deps.now()))
      if (!remaining) {
        deps.remove(path)
        return { stopped: true, message: 'Stopped the OpenMausBot server started by Orca Bot.' }
      }
      await deps.sleep(Math.min(250, Math.max(0, deadline - deps.now())))
    }
    return { stopped: false, message: 'Sent the stop signal, but OpenMausBot health is still responding. The pid file was kept; try stopping again.' }
  } catch {
    return { stopped: false, message: 'Could not verify or stop a server started by Orca Bot; no other server was touched.' }
  }
}
