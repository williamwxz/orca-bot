const safeErrors: Record<string, string> = {
  'serverError.model.accountUpdating': 'The provider is updating. Wait a moment and try again.',
  'serverError.model.botBusy': 'This bot is working. Wait until it finishes, then try again.',
  'serverError.department.duplicate': 'A group with that name already exists.',
  'serverError.department.renameBusy': 'Stop this group’s active work before renaming it.',
  'serverError.department.nameLength': 'Enter a group name between 1 and 60 characters.',
  'serverError.department.nameRule': 'Group names must be 1 to 60 characters without control characters.',
  'serverError.department.notFound': 'This group no longer exists. Refresh the roster.'
}

export class HttpStatusError extends Error {
  status: number
  code?: string
  /** The server's own error text, for classifying a refusal in the worker. Never shown as is. */
  detail?: string
  constructor(status: number, details?: unknown) {
    const body = details && typeof details === 'object' ? details as Record<string, unknown> : {}
    const key = body.errorKey ?? body.code
    const code = typeof key === 'string' && Object.hasOwn(safeErrors, key) ? key : undefined
    super(code ? safeErrors[code] : 'OpenMausBot request failed.')
    this.status = status
    this.code = code
    if (typeof body.error === 'string') this.detail = body.error.slice(0, 500)
  }
}

export type HttpMethod = 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE'

export type HttpDeps = {
  /** `timeoutMs` defaults to 10 seconds; setup steps that download or build pass longer. */
  request: (port: number, path: string, body?: object, method?: HttpMethod, timeoutMs?: number) => Promise<unknown>
  avatar: (port: number, path: string) => Promise<string | undefined>
}

export function defaultHttpDeps(): HttpDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject HTTP dependencies')
  return httpDeps(fetch)
}

export function httpDeps(fetcher: typeof fetch): HttpDeps {
  return {
    request: async (port, path, body, method = body ? 'PATCH' : 'GET', timeoutMs = 10000) => {
      const response = await fetcher(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!response.ok) {
        // Only recognized public error codes reach the UI; raw messages may contain internals.
        const details: unknown = await response.json().catch(() => undefined)
        throw new HttpStatusError(response.status, details)
      }
      const text = await response.text()
      return text ? JSON.parse(text) : {}
    },
    avatar: async (port, path) => {
      if (!/^\/api\/attachments\/[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(path)) return undefined
      const response = await fetcher(`http://127.0.0.1:${port}${path}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      })
      const type = response.headers.get('content-type')?.split(';')[0]
      if (
        !response.ok ||
        !type ||
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)
      )
        return undefined
      const reader = response.body?.getReader()
      if (!reader) return undefined
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          // Base64 adds a third; the entire data URL must stay below 64 KB.
          if (size > 48000) return undefined
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel()
      }
      return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
    }
  }
}
