import assert from 'node:assert/strict'
import test from 'node:test'
import { registerPairedHost } from './paired-host.ts'

test('the last host chosen wins, even when an earlier check answers after it', async () => {
  const handlers = new Map<string, (input: any) => any>()
  const stored = new Map<string, unknown>()
  let answer!: () => void
  const slow = new Promise<void>((resolve) => (answer = resolve))
  const orca = {
    panels: { handle: (name: string, fn: (input: any) => any) => (handlers.set(name, fn), { dispose() {} }) },
    commands: { register: () => ({ dispose() {} }) },
    storage: { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => void stored.set(key, value) }
  } as any
  let calls = 0
  registerPairedHost(orca, () => {}, {
    call: async () => {
      // The first check (for the server) is slow; later ones answer at once.
      if (++calls === 1) await slow
      return { environments: [{ id: 'server', name: 'Mac mini' }] }
    },
    link: () => ({ terminals: async () => [], close: async () => {} }) as any
  })
  const toServer = handlers.get('hosts.select')!({ id: 'server' })
  const toLocal = await handlers.get('hosts.select')!({ id: 'local' })
  assert.equal(toLocal.selected, 'local')
  answer()
  await toServer
  assert.equal(stored.get('botHost'), 'local')
  assert.equal((await handlers.get('hosts.get')!({})).selected, 'local')
})
