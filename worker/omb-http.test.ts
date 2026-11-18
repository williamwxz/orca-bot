import { assert, test } from 'orca/testing'
import { httpDeps, HttpStatusError } from './omb-http.ts'

test('HTTP requests are fixed loopback routes with bounded time and no redirects', async () => {
  const calls: unknown[] = []
  const deps = httpDeps(async (url, init) => {
    calls.push([url, init?.method, init?.body, init?.redirect, init?.signal instanceof AbortSignal])
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('{"bots":[]}', { headers: { 'content-type': 'application/json' } })
  })
  assert.deepEqual(await deps.request(18799, '/api/bots?messages=0'), { bots: [] })
  await deps.request(18799, '/api/bots/fake', { sidebarHidden: false })
  await deps.request(18799, '/api/sidebar-sections', { name: 'Core', botIds: ['fake'] }, 'POST')
  assert.deepEqual(await deps.request(18799, '/api/bots/fake', undefined, 'DELETE'), {})
  assert.deepEqual(calls, [
    ['http://127.0.0.1:18799/api/bots?messages=0', 'GET', undefined, 'error', true],
    ['http://127.0.0.1:18799/api/bots/fake', 'PATCH', '{"sidebarHidden":false}', 'error', true],
    [
      'http://127.0.0.1:18799/api/sidebar-sections',
      'POST',
      '{"name":"Core","botIds":["fake"]}',
      'error',
      true
    ],
    ['http://127.0.0.1:18799/api/bots/fake', 'DELETE', undefined, 'error', true]
  ])

  const failing = httpDeps(async () => new Response('{"error":"conflict"}', { status: 409 }))
  await assert.rejects(
    failing.request(18799, '/api/sidebar-sections', { name: 'Core', botIds: ['fake'] }, 'POST'),
    (error: unknown) => error instanceof HttpStatusError && error.status === 409
  )
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

test('HTTP failures expose only allowlisted public error codes and safe messages', async () => {
  for (const body of [
    { errorKey: 'serverError.department.duplicate', error: '/private/secret token' },
    { code: 'serverError.department.renameBusy', message: 'SQL internals' },
    { errorKey: 'unknown', error: 'password=secret' },
    null
  ]) {
    const deps = httpDeps(async () => new Response(JSON.stringify(body), { status: 409 }))
    await assert.rejects(deps.request(18799, '/api/sidebar-sections'), (error: unknown) => {
      assert.ok(error instanceof HttpStatusError)
      const failure = error as HttpStatusError
      assert.equal(failure.status, 409)
      assert.doesNotMatch(failure.message, /secret|SQL|password/)
      if (body?.errorKey === 'serverError.department.duplicate') assert.match(failure.message, /already exists/)
      else if (body?.code) assert.match(failure.message, /active work/)
      else assert.equal(failure.code, undefined)
      return true
    })
  }
  const deps = httpDeps(async () => new Response('<html>proxy error</html>', { status: 500 }))
  await assert.rejects(deps.request(18799, '/api/sidebar-sections'), /OpenMausBot request failed/)
})
