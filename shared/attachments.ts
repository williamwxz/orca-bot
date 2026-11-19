// Files and photos sent with a chat message. OpenMausBot stores each upload and reads it back from a
// standalone <attached-image|attached-file path="…" name="…" /> line in the message text.

/** Worker-only: where OpenMausBot stored an upload. The path never crosses to the panel. */
export type Attachment = { kind: 'image' | 'file'; path: string; name: string }
/** What the panel knows about an upload: an opaque ID the worker resolves when the message is sent. */
export type Uploaded = { id: string; kind: Attachment['kind']; name: string }
/** An attachment as shown in a message: no path. */
export type SentFile = { kind: Attachment['kind']; name: string }
export type Upload = { name: string; mime: string; data: string }

/** OpenMausBot reads these image types natively; anything else is sent as a file. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** OpenMausBot's own image limit. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** Lower than OpenMausBot's 100 MB: the bytes cross the panel bridge as base64. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024
/** OpenMausBot gives a model at most ten images per turn. */
export const MAX_ATTACHMENTS = 10

export const attachmentKind = (mime: string): Attachment['kind'] =>
  IMAGE_MIMES.includes(mime) ? 'image' : 'file'

export function uploadProblem(name: string, mime: string, bytes: number): string | undefined {
  const limit = attachmentKind(mime) === 'image' ? IMAGE_MAX_BYTES : FILE_MAX_BYTES
  if (bytes <= 0) return `${name} is empty.`
  if (bytes > limit) return `${name} is larger than ${limit / 1024 / 1024} MB.`
}

export function validateUpload(value: unknown): Upload {
  const input = value as Partial<Upload> | undefined
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  const mime = typeof input?.mime === 'string' ? input.mime.split(';')[0].trim().toLowerCase() : ''
  const data = typeof input?.data === 'string' ? input.data : ''
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid file name.')
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) && mime !== '') throw new Error('Invalid file type.')
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error('Invalid file data.')
  // Padding is not data: an exact-limit file ends in "=" or "==".
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const problem = uploadProblem(name, mime, (data.length / 4) * 3 - padding)
  if (problem) throw new Error(problem)
  return { name, mime: mime || 'application/octet-stream', data }
}

const encode = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
const decode = (value: string) =>
  value.replace(/&(quot|lt|gt|amp);|&#(9|10|13);/g, (_, named: string, code: string) =>
    code ? String.fromCharCode(Number(code)) : { quot: '"', lt: '<', gt: '>', amp: '&' }[named]!
  )

/** Text, then one tag per attachment. Blank lines keep each tag its own block, as the server requires. */
export function composeMessage(text: string, attachments: Attachment[]): string {
  const tags = attachments.map(
    (a) => `<attached-${a.kind} path="${encode(a.path)}" name="${encode(a.name)}" />`
  )
  return [text.trim(), ...tags].filter(Boolean).join('\n\n')
}

const TAG = /^<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/

/** Splits attachment tag lines out of a message, so chat shows a file's name instead of raw markup. */
export function splitAttachments(text: string): { text: string; attachments: SentFile[] } {
  const attachments: SentFile[] = []
  const lines = text.split('\n').filter((line) => {
    const match = TAG.exec(line.trim())
    if (!match) return true
    const path = decode(match[2])
    attachments.push({
      kind: match[1] === 'image' ? 'image' : 'file',
      name: match[3] ? decode(match[3]) : (path.split(/[\\/]/).at(-1) ?? path)
    })
    return false
  })
  return { text: lines.join('\n').trim(), attachments }
}
