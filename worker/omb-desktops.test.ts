import { assert, test } from 'orca/testing'
import { desktopAct, desktopReason, desktopState, desktopStatus, installBrowser, updateDesktopSettings } from './omb-desktops.ts'
import { HttpStatusError } from './omb-http.ts'
import type { HttpDeps } from './omb-http.ts'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const base = { runtime: 'docker', daemonUp: true, image: true, imageMatches: true, managed: true, network: 'loopback', security: 'hardened', persistence: 'durable' }
function fake(config: object = {}, vm: object = base, fail?: (path: string) => Error | undefined) {
  const calls: { path: string; body?: object; method?: string; timeout?: number }[] = []
  const deps: HttpDeps = {
    avatar: async () => undefined,
    request: async (_port, path, body, method, timeout) => {
      calls.push({ path, ...(body ? { body } : {}), ...(method ? { method } : {}), ...(timeout ? { timeout } : {}) })
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
  // A desktop that reported an error will not become ready by waiting.
  assert.equal(desktopState({ ...base, container: 'running', ready: false, desktop_error: 'SECRET trace' }), 'failed')
  assert.equal(desktopReason({ ...base, persistence: 'unsafe' }), 'no-folder')
  assert.equal(desktopReason({ ...base, imageMatches: false, persistence: 'unsafe' }), 'old-image')
  assert.equal(desktopReason({ ...base, managed: false }), 'not-managed')
  assert.equal(desktopReason({ ...base, security: 'unsafe' }), 'unsafe')
  assert.equal(desktopReason(base), undefined)
  assert.equal(desktopState({ ...base, container: 'running', ready: true }), 'running')
})

test('status reads the shared desktop, or the bot\'s own in per-bot mode, and returns no viewer link', async () => {
  const shared = fake({}, { ...base, container: 'stopped' })
  const status = await desktopStatus({ port: 9, botId: id }, shared.deps)
  assert.deepEqual(status, { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'stopped', runtime: 'Docker' })
  const repair = await desktopStatus({ port: 9 }, fake({}, { ...base, container: 'stopped', persistence: 'unsafe' }).deps)
  assert.equal(repair.state, 'repair')
  assert.equal(repair.reason, 'no-folder')
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
  // Long steps get their own deadline instead of the 10-second default.
  assert.deepEqual(prepare.calls.find((c) => c.method === 'POST')!.timeout, 30 * 60_000)
  assert.deepEqual(shared.calls.filter((c) => c.method === 'POST').map((c) => c.timeout), [3 * 60_000, 10 * 60_000])
  // Pool mode: no manual lifecycle step reaches the server, recreate included.
  for (const action of ['create', 'start', 'stop', 'recreate'] as const) {
    const pool = fake({ localVm: { mode: 'pool' } })
    await assert.rejects(desktopAct({ port: 9, action }, pool.deps), /pool desktops by itself/)
    assert.equal(pool.calls.some((c) => c.method === 'POST'), false)
  }
  // Isolation unknown: never guess shared, so a per-bot host's shared desktop is never removed.
  const unknown = fake({}, base, (path) => (path === '/api/config' ? new Error('SECRET') : undefined))
  await assert.rejects(desktopAct({ port: 9, action: 'recreate', botId: id }, unknown.deps), /^Error: Could not check how private desktops are shared on this host\. Nothing was changed/)
  assert.equal(unknown.calls.some((c) => c.method === 'POST'), false)
  const full = fake({ localVm: { mode: 'per-bot', maxInstances: 2 } }, base, (path) =>
    path.endsWith('/run') ? new HttpStatusError(409, { error: 'The per-bot Local VM limit is 2 — delete an unused bot VM or raise the limit in App Settings' }) : undefined)
  await assert.rejects(desktopAct({ port: 9, action: 'create', botId: id }, full.deps), /^Error: This host already has its maximum of 2 per-bot desktops\. Delete one in native OpenMausBot, or raise the maximum/)
  const noRuntime = fake({}, base, (path) => (path.endsWith('/run') ? new HttpStatusError(409, { error: 'Install a supported container runtime first' }) : undefined))
  await assert.rejects(desktopAct({ port: 9, action: 'create' }, noRuntime.deps), /^Error: The container app is not ready/)
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
  const refused = fake({}, base, (path) => (path === '/api/config' ? new HttpStatusError(409, { error: 'stop Local VM turns and setup actions before changing the Local VM isolation mode' }) : undefined))
  await assert.rejects(updateDesktopSettings({ port: 9, mode: 'shared' }, refused.deps), /^Error: Wait until no bot is using a private desktop/)
  const existing = fake({}, base, (path) => (path === '/api/config' ? new HttpStatusError(409, { error: 'delete the 2 per-bot Local VMs before switching to shared mode' }) : undefined))
  await assert.rejects(updateDesktopSettings({ port: 9, mode: 'shared' }, existing.deps), /^Error: Delete the per-bot desktops first, in native OpenMausBot/)
  // Saved, but the read-back fails: say so, without the reply's text.
  let reads = 0
  const unread: HttpDeps = { avatar: async () => undefined, request: async (_p, path, body) => {
    if (path === '/api/config' && !body && ++reads > 0) throw new SyntaxError('Unexpected token SECRET in JSON')
    return {}
  } }
  await assert.rejects(updateDesktopSettings({ port: 9, idleMinutes: 60 }, unread), /^Error: Saved, but the new setting could not be read back/)
  const browser = fake()
  await installBrowser({ port: 9 }, browser.deps)
  assert.deepEqual(browser.calls, [{ path: '/api/browser-engine/install', body: {}, method: 'POST' }])
})
