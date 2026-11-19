import { assert, test } from 'orca/testing'
import { uploadAttachment } from './omb-attachments.ts'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function fake(status = 201, body: unknown = { path: '/data/attachments/x' }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

test('images go to the image store and other files to the file store, by raw bytes', async () => {
  const image = fake()
  assert.deepEqual(
    await uploadAttachment({ port: 9, name: 'shot.png', mime: 'image/png', data: 'aGk=' }, image.fetcher, id),
    { kind: 'image', path: '/data/attachments/x', name: 'shot.png' }
  )
  assert.equal(image.calls[0].url, `http://127.0.0.1:9/api/attachments?uploadId=${id}`)
  assert.equal(image.calls[0].init.method, 'POST')
  assert.deepEqual(image.calls[0].init.headers, { 'content-type': 'image/png' })
  assert.equal(Buffer.from(image.calls[0].init.body as Uint8Array).toString(), 'hi')
  const file = fake()
  const saved = await uploadAttachment({ port: 9, name: 'Q3 plan.pdf', mime: 'application/pdf', data: 'aGk=' }, file.fetcher, id)
  assert.equal(saved.kind, 'file')
  assert.equal(file.calls[0].url, `http://127.0.0.1:9/api/files?uploadId=${id}&name=Q3+plan.pdf`)
})

test('upload failures name the file and never pass server text through', async () => {
  await assert.rejects(
    uploadAttachment({ port: 9, name: 'a.mov', mime: 'video/quicktime', data: 'aGk=' }, fake(413).fetcher, id),
    /a\.mov is too large/
  )
  await assert.rejects(
    uploadAttachment({ port: 9, name: 'a.txt', mime: 'text/plain', data: 'aGk=' }, fake(507).fetcher, id),
    /storage is full/
  )
  await assert.rejects(
    uploadAttachment({ port: 9, name: 'a.txt', mime: 'text/plain', data: 'aGk=' }, fake(500, { error: '/secret/path' }).fetcher, id),
    /^Error: Could not upload a\.txt\.$/
  )
  await assert.rejects(
    uploadAttachment({ port: 9, name: 'a.txt', mime: 'text/plain', data: 'aGk=' }, fake(201, {}).fetcher, id),
    /Could not upload a\.txt/
  )
  const offline = (async () => { throw new Error('ECONNREFUSED /secret') }) as unknown as typeof fetch
  await assert.rejects(
    uploadAttachment({ port: 9, name: 'a.txt', mime: 'text/plain', data: 'aGk=' }, offline, id),
    /Could not upload a\.txt\. Check that OpenMausBot is running\./
  )
})
