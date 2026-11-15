const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
// Never fall back to legacy entries when a V2 servers key is present but malformed.
export function opencodeEntries(raw: unknown): Record<string, any> | undefined {
  if (!object(raw)) return
  if (raw.mcp === undefined) return {}
  if (!object(raw.mcp)) return
  if (Object.hasOwn(raw.mcp, 'servers')) return object(raw.mcp.servers) ? raw.mcp.servers : undefined
  return raw.mcp
}

type ConfigIO = {
  statSync: (path: string) => { mode: number }
  writeFileSync: (path: string, value: string, options: { flag: string; mode: number }) => void
  chmodSync: (path: string, mode: number) => void
  renameSync: (from: string, to: string) => void
  unlinkSync: (path: string) => void
}
export function replaceConfigAtomically(path: string, value: string, temp: string, io: ConfigIO): void {
  const mode = io.statSync(path).mode & 0o7777
  let created = false
  try {
    io.writeFileSync(temp, value, { flag: 'wx', mode })
    created = true
    io.chmodSync(temp, mode)
    io.renameSync(temp, path)
  } finally { if (created) try { io.unlinkSync(temp) } catch {} }
}
