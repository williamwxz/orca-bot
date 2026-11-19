import { assert, test } from 'orca/testing'
import { computerStatus } from './omb-computer.ts'
import type { HttpDeps } from './omb-http.ts'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const secret = 'VIEWER_PASSWORD_123'
function fake(replies: Record<string, unknown>) {
  const paths: string[] = []
  const deps: HttpDeps = {
    avatar: async () => undefined,
    request: async (_port, path) => {
      paths.push(path)
      const key = Object.keys(replies).find((k) => path.includes(k))
      if (!key) throw new Error('offline')
      return replies[key]
    }
  }
  return { deps, paths }
}

test('backend status reports only states, never the viewer link, commands or paths the server sends', async () => {
  const { deps, paths } = fake({
    '/computer?threadId=': { surface: 'vm', backend: 'box', configured: false },
    '/api/config': { box: { configured: false }, vps: { configured: false, sshAlias: secret }, browserEngine: { kind: 'unavailable', reason: secret } },
    '/local-computer': { runtime: 'docker', daemonUp: true, image: true, imageMatches: true, managed: true, container: 'stopped', persistence: 'unsafe', ready: false, problem: `missing folder ${secret}`, viewer_url: `http://127.0.0.1:6080/#password=${secret}`, commands: { run: secret }, workspace_path: `/Users/${secret}` }
  })
  const status = await computerStatus({ port: 9, botId: id, threadId: 'thread-1' }, deps)
  assert.deepEqual(status, {
    now: 'vm', cloud: 'setup', browser: 'setup', vm: 'repair',
    desktop: { mode: 'shared', maxInstances: 2, idleMinutes: 480, state: 'repair', reason: 'no-folder', runtime: 'Docker' }
  })
  assert.equal(JSON.stringify(status).includes(secret), false)
  assert.deepEqual(paths, [`/api/bots/${id}/computer?threadId=thread-1`, '/api/config', `/api/bots/${id}/local-computer`])
})

test('backend status maps ready, stopped and missing runtime, and survives failed reads', async () => {
  const state = async (vm: object, config: object = {}) =>
    computerStatus({ port: 9, botId: id }, fake({ '/local-computer': vm, '/api/config': config }).deps)
  const ready = { runtime: 'podman', daemonUp: true, image: true, imageMatches: true, managed: true, container: 'running', ready: true }
  const full = await state(ready, { vps: { configured: true }, browserEngine: { kind: 'engine', installing: true }, localVm: { mode: 'per-bot', maxInstances: 3, idleTimeoutMinutes: 60 } })
  assert.deepEqual(full, {
    cloud: 'ready', browser: 'ready', browserInstalling: true, vm: 'ready',
    desktop: { mode: 'per-bot', maxInstances: 3, idleMinutes: 60, state: 'running', runtime: 'Podman' }
  })
  assert.equal((await state({ ...ready, container: 'stopped', ready: false })).vm, 'stopped')
  assert.equal((await state({ runtime: 'docker', daemonUp: false })).vm, 'setup')
  // No thread: nothing is asked about "right now". Unknown surfaces are dropped.
  assert.equal((await state(ready)).now, undefined)
  assert.deepEqual(await computerStatus({ port: 9, botId: id, threadId: 't' }, fake({ '/computer?threadId=': { surface: 'moon' } }).deps), {})
  assert.deepEqual(await computerStatus({ port: 9, botId: id, threadId: '../x' }, fake({}).deps), {})
  await assert.rejects(computerStatus({ port: 9, botId: 'nope' }, fake({}).deps), /Invalid bot ID/)
})
