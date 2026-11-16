export type HttpDeps = {
  request: (port: number, path: string, patch?: object) => Promise<unknown>
  avatar: (port: number, path: string) => Promise<string | undefined>
}

export function defaultHttpDeps(): HttpDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject HTTP dependencies')
  return httpDeps(fetch)
}

export function httpDeps(fetcher: typeof fetch): HttpDeps {
  return {
    request: async (port, path, patch) => {
      const response = await fetcher(`http://127.0.0.1:${port}${path}`, {
        method: patch ? 'PATCH' : 'GET',
        headers: patch ? { 'content-type': 'application/json' } : {},
        body: patch ? JSON.stringify(patch) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(10000)
      })
      if (!response.ok) throw new Error('OpenMausBot request failed.')
      return response.json()
    },
    avatar: async (port, path) => {
      if (!/^\/api\/attachments\/[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(path)) return undefined
      const response = await fetcher(`http://127.0.0.1:${port}${path}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      })
      const type = response.headers.get('content-type')?.split(';')[0]
      if (!response.ok || !type || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type))
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
