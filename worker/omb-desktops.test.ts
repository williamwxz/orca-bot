import { assert, test } from 'orca/testing'
import { desktopAct, desktopState, desktopStatus, installBrowser, updateDesktopSettings } from './omb-desktops.ts'
import { HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const base = { runtime: 'docker', daemonUp: true, image: true, imageMatches: true, managed: true, network: 'loopback', security: 'hardened', persistence: 'durable' }
function fake(config: object = {}, vm: object = base, fail?: (path: string) => Error | undefined) {
  const calls: { path: string; body?: object; method?: string }[] = []
  const deps: HttpDeps = {
    avatar: async () => undefined,
    request: async (_port, path, body, method) => {
      calls.push({ path, ...(body ? { body } : {}), ...(method ? { method } : {}) })
      const problem = fail?.(path)
      if (problem) throw problem
      if (path === '/api/config') return config
      return { ...vm, viewer_url: 'http://127.0.0.1:6080/#password=SECRET', commands: { run: 'SECRET' } }
    }
  }
  return { deps, calls }
}

test('desktop states follow OpenMausBot setup steps in order', () => {
  assert.equal(desktopState({}), 'no-runtime')
  assert.equal(desktopState({ runtime: 'docker', daemonUp: false }), 'runtime-stopped')
  assert.equal(desktopState({ runtime: 'docker', daemonUp: true, image: false }), 'not-prepared')
  assert.equal(desktopState({ ...base, container: 'missing' }), 'not-created')
  assert.equal(desktopState({ ...base, container: 'missing', create_supported: false }), 'unsupported')
  for (const unsafe of [{ imageMatches: false }, { managed: false }, { network: 'unsafe' }, { security: 'unsafe' }, { persistence: 'unsafe' }])
    assert.equal(desktopState({ ...base, container: 'stopped', ...unsafe }), 'repair')
  assert.equal(desktopState({ ...base, container: 'stopped' }), 'stopped')
  assert.equal(desktopState({ ...base, container: 'running', ready: false }), 'starting')
  assert.equal(desktopState({ ...base, container: 'running', ready: true }), 'running')
})

test('status reads the shared desktop, or the bot\'s own in per-bot mode, and returns no viewer link', async () => {
  const shared = fake({}, { ...base, container: 'stopped' })
  const status = await desktopStatus({ port: 9, botId: id }, shared.deps)
  assert.deepEqual(status, { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'stopped', runtime: 'Docker' })
  assert.equal(JSON.stringify(status).includes('SECRET'), false)
  assert.equal(shared.calls[1].path, '/api/local-computer')
  const perBot = fake({ localVm: { mode: 'per-bot' } }, { ...base, container: 'missing' })
  assert.equal((await desktopStatus({ port: 9, botId: id }, perBot.deps)).state, 'not-created')
  assert.equal(perBot.calls[1].path, `/api/bots/${id}/local-computer`)
  await assert.rejects(desktopStatus({ port: 9, botId: 'nope' }, perBot.deps), /Invalid bot ID/)
  await assert.rejects(desktopStatus({ port: 9 }, fake({}, base, () => new Error('SECRET path')).deps), /^Error: Could not check the private desktop/)
})

test('setup steps call OpenMausBot\'s own routes; recreate removes then creates; refusals use fixed words', async () => {
  const shared = fake()
  await desktopAct({ port: 9, action: 'recreate' }, shared.deps)
  assert.deepEqual(shared.calls.filter((c) => c.method === 'POST').map((c) => c.path), ['/api/local-computer/remove', '/api/local-computer/run'])
  assert.deepEqual(shared.calls.find((c) => c.method === 'POST')!.body, {})
  const prepare = fake({ localVm: { mode: 'per-bot' } })
  await desktopAct({ port: 9, action: 'prepare', botId: id }, prepare.deps)
  assert.deepEqual(prepare.calls.filter((c) => c.method === 'POST').map((c) => c.path), ['/api/local-computer/pull'])
  const perBot = fake({ localVm: { mode: 'per-bot' } })
  await desktopAct({ port: 9, action: 'start', botId: id }, perBot.deps)
  assert.deepEqual(perBot.calls.filter((c) => c.method === 'POST').map((c) => c.path), [`/api/bots/${id}/local-computer/start`])
  await assert.rejects(desktopAct({ port: 9, action: 'start' }, fake({ localVm: { mode: 'per-bot' } }).deps), /Choose a bot/)
  await assert.rejects(desktopAct({ port: 9, action: 'create' }, fake({ localVm: { mode: 'pool' } }).deps), /start by themselves/)
  await assert.rejects(desktopAct({ port: 9, action: 'explode' as any }, fake().deps), /Unknown desktop step/)
  const busy = fake({}, base, (path) => (path.endsWith('/stop') ? new HttpStatusError(409, { error: 'SECRET' }) : undefined))
  await assert.rejects(desktopAct({ port: 9, action: 'stop' }, busy.deps), /^Error: A bot is using the private desktop/)
  const broken = fake({}, base, (path) => (path.endsWith('/pull') ? new Error('SECRET') : undefined))
  await assert.rejects(desktopAct({ port: 9, action: 'prepare' }, broken.deps), /^Error: Could not prepare the private desktop/)
})

test('desktop settings are bounded as OpenMausBot bounds them, and the browser installs on request', async () => {
  const { deps, calls } = fake({ localVm: { mode: 'per-bot', maxInstances: 3, idleTimeoutMinutes: 30 } })
  assert.deepEqual(await updateDesktopSettings({ port: 9, mode: 'per-bot', maxInstances: 3, idleMinutes: 30 }, deps), { mode: 'per-bot', maxInstances: 3, idleMinutes: 30 })
  assert.deepEqual(calls[0], { path: '/api/config', body: { localVm: { mode: 'per-bot', maxInstances: 3, idleTimeoutMinutes: 30 } }, method: 'PATCH' })
  for (const bad of [{ mode: 'pool' }, { maxInstances: 9 }, { maxInstances: 0 }, { idleMinutes: 4 }, { idleMinutes: 1441 }, { idleMinutes: 2.5 }, {}])
    await assert.rejects(updateDesktopSettings({ port: 9, ...(bad as any) }, deps))
  const refused = fake({}, base, (path) => (path === '/api/config' ? new HttpStatusError(409) : undefined))
  await assert.rejects(updateDesktopSettings({ port: 9, mode: 'shared' }, refused.deps), /Stop the bots using a private desktop/)
  const browser = fake()
  await installBrowser({ port: 9 }, browser.deps)
  assert.deepEqual(browser.calls, [{ path: '/api/browser-engine/install', body: {}, method: 'POST' }])
})
