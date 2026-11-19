import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { childEnvironment } from './child-environment.ts'

/** A problem the panel can show as it is: fixed wording, no paths, tickets or server text. */
export class HermesError extends Error {
  code: 'not_installed' | 'not_running' | 'closed' | 'timeout' | 'refused'
  /** Hermes' own short reason code for a refused request, such as `invalid_params`. */
  reason?: string
  constructor(code: HermesError['code'], message: string, reason?: string) {
    super(message)
    this.code = code
    this.reason = reason
  }
}

export type GatewayEvent = { type: string; sessionId: string; payload: Record<string, any> }
/** The parts of a WebSocket this uses, so tests can pass a fake. */
export type Socket = {
  send(text: string): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}
export type GatewayDeps = {
  /** Asks Hermes for the profile's gateway address and a one-use ticket. `start` may start the gateway. */
  attach(profile: string, start: boolean): Promise<{ url: string; protocols: string[] }>
  socket(url: string, protocols: string[]): Socket
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** Connections kept open at once; the one unused longest closes to make room. */
export const MAX_CONNECTIONS = 16

export function defaultGatewayDeps(): GatewayDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject gateway dependencies')
  const env = childEnvironment({ home: homedir(), platform: process.platform, env: process.env, userInfo })
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile('hermes', args, { env, timeout: 70000, maxBuffer: 1 << 20 }, (error, stdout) =>
        error ? reject(Object.assign(error, { stdout })) : resolve(stdout)
      )
    )
  return {
    attach: async (profile, start) => {
      let output: string
      try {
        output = await run(['-p', profile, 'gateway', 'attach', '--json', ...(start ? ['--start'] : [])])
      } catch (error) {
        // The ticket is a credential and stdout may hold one: only the kind of failure leaves here.
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
          throw new HermesError('not_installed', 'Hermes is not installed on this computer. Install it, then press Retry.')
        throw new HermesError('not_running', 'Hermes is not running. Open Hermes, then press Retry.')
      }
      try {
        const reply = JSON.parse(output)
        if (typeof reply?.url !== 'string' || !/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(reply.url)) throw new Error()
        if (!Array.isArray(reply.protocols) || reply.protocols.some((p: unknown) => typeof p !== 'string')) throw new Error()
        return { url: reply.url, protocols: reply.protocols }
      } catch {
        throw new HermesError('not_running', 'Hermes did not give a connection. Update Hermes, then press Retry.')
      }
    },
    socket: (url, protocols) => new WebSocket(url, protocols) as unknown as Socket,
    now: Date.now,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: unknown }
type Connection = { socket?: Socket; ready: Promise<void>; opening: boolean; pending: Map<number, Pending>; used: number; closed: boolean }

/**
 * One connection per Hermes profile to its local gateway, opened on first use and reopened after
 * it drops. A ticket admits only its own profile, so each bot needs a connection of its own.
 */
export function createGateway(deps: GatewayDeps = defaultGatewayDeps()) {
  const connections = new Map<string, Connection>()
  const listeners = new Set<(profile: string, event: GatewayEvent) => void>()
  const dropListeners = new Set<(profile: string) => void>()
  /** Profiles whose connection carries a chat's events: never closed to make room for another. */
  const held = new Set<string>()
  let nextId = 0

  function drop(profile: string, connection: Connection, error: HermesError) {
    if (connection.closed) return
    connection.closed = true
    if (connections.get(profile) === connection) connections.delete(profile)
    for (const waiting of connection.pending.values()) {
      deps.clearTimer(waiting.timer)
      waiting.reject(error)
    }
    connection.pending.clear()
    try {
      connection.socket?.close()
    } catch {
      /* Already closed. */
    }
    held.delete(profile)
    // Whoever followed events on this socket hears that it is gone, even if a new one opens at once.
    for (const listener of dropListeners) listener(profile)
  }

  function open(profile: string): Connection {
    const connection: Connection = { ready: Promise.resolve(), opening: true, pending: new Map(), used: deps.now(), closed: false }
    connection.ready = (async () => {
      let target: { url: string; protocols: string[] }
      try {
        target = await deps.attach(profile, false)
      } catch (error) {
        if (!(error instanceof HermesError) || error.code !== 'not_running') throw error
        // No gateway serves this profile yet: let Hermes start it once.
        target = await deps.attach(profile, true)
      }
      if (connection.closed) throw new HermesError('closed', 'The connection to Hermes closed. Try again.')
      const socket = deps.socket(target.url, target.protocols)
      connection.socket = socket
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = () => reject(new HermesError('not_running', 'Could not connect to Hermes. Press Retry.'))
        socket.onclose = () => reject(new HermesError('not_running', 'Could not connect to Hermes. Press Retry.'))
      })
      const lost = () => drop(profile, connection, new HermesError('closed', 'The connection to Hermes closed. Try again.'))
      socket.onclose = lost
      socket.onerror = lost
      socket.onmessage = (message) => {
        let frame: any
        try {
          frame = JSON.parse(String(message.data))
        } catch {
          return
        }
        if (!frame || typeof frame !== 'object') return
        const waiting = typeof frame.id === 'number' ? connection.pending.get(frame.id) : undefined
        if (waiting) {
          connection.pending.delete(frame.id)
          deps.clearTimer(waiting.timer)
          if (frame.error) {
            const reason = typeof frame.error.message === 'string' && /^[a-z_]{1,40}$/.test(frame.error.message) ? frame.error.message : undefined
            waiting.reject(new HermesError('refused', 'Hermes refused this request.', reason))
          } else waiting.resolve(frame.result)
          return
        }
        // A question from Hermes (an approval, a clarification): this panel answers none, so say so
        // at once and the bot is told there is no answer here. Answer those in Hermes itself.
        if (frame.id !== undefined && typeof frame.method === 'string') {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'not implemented' } }))
          return
        }
        const params = frame.params
        if (frame.method !== 'event' || !params || typeof params.type !== 'string') return
        const event: GatewayEvent = {
          type: params.type,
          sessionId: typeof params.session_id === 'string' ? params.session_id : '',
          payload: params.payload && typeof params.payload === 'object' ? params.payload : {}
        }
        for (const listener of listeners) listener(profile, event)
      }
      connection.opening = false
    })()
    connection.ready.catch(() => drop(profile, connection, new HermesError('closed', 'The connection to Hermes closed. Try again.')))
    connections.set(profile, connection)
    if (connections.size > MAX_CONNECTIONS) {
      // Only a settled connection nobody is waiting on or following may go.
      const idle = [...connections].filter(([name, c]) => name !== profile && !c.opening && !c.pending.size && !held.has(name)).sort((a, b) => a[1].used - b[1].used)[0]
      if (idle) drop(idle[0], idle[1], new HermesError('closed', 'The connection to Hermes closed. Try again.'))
    }
    return connection
  }

  return {
    async request(profile: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<any> {
      if (!PROFILE.test(profile)) throw new Error('Unknown bot.')
      const connection = connections.get(profile) ?? open(profile)
      connection.used = deps.now()
      await connection.ready
      if (connection.closed || !connection.socket) throw new HermesError('closed', 'The connection to Hermes closed. Try again.')
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = deps.setTimer(() => {
          connection.pending.delete(id)
          reject(new HermesError('timeout', 'Hermes took too long to answer. Try again.'))
        }, timeoutMs)
        connection.pending.set(id, { resolve, reject, timer })
        try {
          connection.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        } catch {
          drop(profile, connection, new HermesError('closed', 'The connection to Hermes closed. Try again.'))
        }
      })
    },
    /** True while a connection for the profile is open; events for its sessions arrive only then. */
    connected: (profile: string) => !!connections.get(profile)?.socket && !connections.get(profile)!.closed,
    onEvent(listener: (profile: string, event: GatewayEvent) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Called when a profile's connection closes: events for its sessions stop until it is attached again. */
    onDrop(listener: (profile: string) => void): () => void {
      dropListeners.add(listener)
      return () => dropListeners.delete(listener)
    },
    /** Keeps the profile's open connection from being closed to make room; ends when it drops. */
    hold(profile: string): void {
      if (connections.get(profile)?.socket && !connections.get(profile)!.closed) held.add(profile)
    },
    close() {
      for (const [profile, connection] of [...connections]) drop(profile, connection, new HermesError('closed', 'The connection to Hermes closed. Try again.'))
    }
  }
}

export type Gateway = ReturnType<typeof createGateway>
