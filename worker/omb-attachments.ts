import { randomUUID } from 'node:crypto'
import { attachmentKind, validateUpload } from '../shared/attachments.ts'
import type { Attachment } from '../shared/attachments.ts'

/**
 * Saves one file in OpenMausBot's attachment store. The result holds the server's file path and
 * stays in the worker; the panel gets an opaque ID. Failures use fixed messages only.
 */
export async function uploadAttachment(
  input: { port: number; name: string; mime: string; data: string },
  fetcher: typeof fetch = fetch,
  uploadId: string = randomUUID()
): Promise<Attachment> {
  const { name, mime, data } = validateUpload(input)
  const kind = attachmentKind(mime)
  const query = new URLSearchParams({ uploadId, ...(kind === 'file' ? { name } : {}) })
  const route = kind === 'image' ? '/api/attachments' : '/api/files'
  const failed = `Could not upload ${name}.`
  let response: Response
  try {
    response = await fetcher(`http://127.0.0.1:${input.port}${route}?${query}`, {
      method: 'POST',
      headers: { 'content-type': mime },
      body: Buffer.from(data, 'base64'),
      redirect: 'error',
      signal: AbortSignal.timeout(60000)
    })
  } catch {
    throw new Error(`${failed} Check that OpenMausBot is running.`)
  }
  if (response.status === 413) throw new Error(`${name} is too large for OpenMausBot.`)
  if (response.status === 507) throw new Error('OpenMausBot’s attachment storage is full.')
  if (!response.ok) throw new Error(failed)
  let reply: unknown
  try {
    reply = await response.json()
  } catch {
    throw new Error(failed)
  }
  const path = (reply as { path?: unknown } | undefined)?.path
  if (typeof path !== 'string' || !path || /[\u0000-\u001f]/.test(path)) throw new Error(failed)
  return { kind, path, name }
}
