import { assert, test } from 'orca/testing'
import { httpDeps } from './omb-http.ts'

test('HTTP requests are fixed loopback routes with bounded time and no redirects', async () => {
  const calls: unknown[] = []
  const deps = httpDeps(async (url, init) => {
    calls.push([url, init?.method, init?.body, init?.redirect, init?.signal instanceof AbortSignal])
    return new Response('{"bots":[]}', { headers: { 'content-type': 'application/json' } })
  })
  assert.deepEqual(await deps.request(18799, '/api/bots?messages=0'), { bots: [] })
  await deps.request(18799, '/api/bots/fake', { sidebarHidden: false })
  assert.deepEqual(calls, [
    ['http://127.0.0.1:18799/api/bots?messages=0', 'GET', undefined, 'error', true],
    ['http://127.0.0.1:18799/api/bots/fake', 'PATCH', '{"sidebarHidden":false}', 'error', true]
  ])
})

test('avatars accept only stored raster paths and keep data URLs below 64 KB', async () => {
  let requests = 0
  let bytes = 20
  let type = 'image/png'
  const deps = httpDeps(async () => {
    requests++
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': type } })
  })
  for (const path of [
    'https://evil.invalid/image.png',
    '/api/attachments/../secret.png',
    '/api/attachments/fake.svg'
  ])
    assert.equal(await deps.avatar(18799, path), undefined)
  assert.equal(requests, 0)
  assert.match((await deps.avatar(18799, '/api/attachments/fake.png'))!, /^data:image\/png;base64,/)
  bytes = 48000
  assert.ok((await deps.avatar(18799, '/api/attachments/fake.png'))!.length < 65536)
  bytes = 48001
  assert.equal(await deps.avatar(18799, '/api/attachments/fake.png'), undefined)
  bytes = 20
  type = 'text/html'
  assert.equal(await deps.avatar(18799, '/api/attachments/fake.png'), undefined)
})
