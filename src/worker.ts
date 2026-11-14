// The plugin's worker: every panel action becomes one call to the real Grok Bot, made by our
// own client (src/gateway.ts) with the session of the signed-in Grok Bot desktop app
// (src/session.ts). Nothing is stored: the session lives in this process's memory only.
import type { OrcaWorkerApi } from 'orca/worker'
import type { Bot } from '../shared/model'
import { createConnection, type ConnectionDeps } from './connection'
import { createGatewayClient } from './gateway'

// Grok Bot ids are UUIDs. Refusing anything else keeps unexpected text out of request bodies.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

function requireId(id: unknown): string {
  if (typeof id !== 'string' || !ID.test(id)) throw invalid('Unknown bot id')
  return id
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} is required`)
  if (value.length > max) throw invalid(`${label} is too long`)
  return value
}

/** Registers the panel's handlers. Tests pass fakes for the session and the network. */
export function register(orca: OrcaWorkerApi, deps: ConnectionDeps = {}): void {
  const connection = createConnection(deps)
  const client = createGatewayClient({
    ...deps.network,
    getRoute: connection.getRoute,
    refreshRoute: connection.refreshRoute
  })

  const handle = orca.panels.handle as (
    name: string,
    handler: (input: any) => Promise<unknown>
  ) => void

  // Also the panel's Refresh: it re-reads the desktop app, so a newly signed-in account is used.
  handle('status', async () => {
    connection.reset()
    try {
      await connection.getRoute()
      return { ok: true, message: '' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not connect' }
    }
  })

  handle('bots.list', () => client.listBots())

  handle('bots.create', async ({ name, instructions }): Promise<Bot[]> => {
    await client.createBot({
      name: requireText(name, 'Name', 80),
      instructions:
        typeof instructions === 'string' && instructions.trim()
          ? requireText(instructions, 'Instructions', 8000)
          : ''
    })
    return client.listBots()
  })

  handle('bots.update', async ({ id, name, instructions, hidden }): Promise<Bot[]> => {
    if (typeof instructions === 'string' && instructions.length > 8000) {
      throw invalid('Instructions are too long')
    }
    await client.updateBot(requireId(id), {
      name: name === undefined ? undefined : requireText(name, 'Name', 80),
      instructions: typeof instructions === 'string' ? instructions : undefined,
      hidden: typeof hidden === 'boolean' ? hidden : undefined
    })
    return client.listBots()
  })

  handle('bots.delete', async ({ id }): Promise<Bot[]> => {
    await client.deleteBot(requireId(id))
    return client.listBots()
  })

  handle('thread.read', ({ id, limit }) =>
    client.readThread(requireId(id), Number.isInteger(limit) ? limit : 60)
  )

  handle('message.send', async ({ id, text }) => {
    // Never resent here: a send whose outcome is unclear fails with "check before trying again".
    await client.sendMessage(requireId(id), requireText(text, 'Message', 16000))
    return { sent: true }
  })

  orca.log('Bot Deck worker ready')
}

export default function activate(orca: OrcaWorkerApi): void {
  register(orca)
}
