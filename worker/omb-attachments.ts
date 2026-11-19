import { randomUUID } from 'node:crypto'
import { attachmentKind, validateUpload } from '../shared/attachments.ts'
import type { Attachment } from '../shared/attachments.ts'

/** Saves one file in OpenMausBot's attachment store; the message then refers to it by path. */
export async function uploadAttachment(
  input: { port: number; name: string; mime: string; data: string },
  fetcher: typeof fetch = fetch,
  uploadId: string = randomUUID()
): Promise<Attachment> {
  const { name, mime, data } = validateUpload(input)
  const kind = attachmentKind(mime)
  const query = new URLSearchParams({ uploadId, ...(kind === 'file' ? { name } : {}) })
  const route = kind === 'image' ? '/api/attachments' : '/api/files'
  let reply: unknown
  try {
    const response = await fetcher(`http://127.0.0.1:${input.port}${route}?${query}`, {
      method: 'POST',
      headers: { 'content-type': mime },
      body: Buffer.from(data, 'base64'),
      redirect: 'error',
      signal: AbortSignal.timeout(60000)
    })
    if (response.status === 413) throw new Error(`${name} is too large for OpenMausBot.`)
    if (response.status === 507) throw new Error('OpenMausBot’s attachment storage is full.')
    if (!response.ok) throw new Error(`Could not upload ${name}.`)
    reply = await response.json()
  } catch (error) {
    if (error instanceof Error && error.message.includes(name)) throw error
    if (error instanceof Error && error.message.includes('storage')) throw error
    throw new Error(`Could not upload ${name}. Check that OpenMausBot is running.`)
  }
  const path = (reply as { path?: unknown } | undefined)?.path
  if (typeof path !== 'string' || !path || /[\u0000-\u001f]/.test(path))
    throw new Error(`Could not upload ${name}.`)
  return { kind, path, name }
}
