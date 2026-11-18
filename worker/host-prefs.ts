import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Provenance = Record<string, { provider: string; rawName: string; fingerprint: string }>
export type StoredPrefs = {
  connectorKey?: string
  connectors?: Provenance
  shareTools?: boolean
  linkAgents?: boolean
  setupAnswered?: boolean
  installConsent?: boolean
  stopped?: boolean
}

export type HostPrefs = {
  read(): StoredPrefs | undefined
  write(patch: Partial<StoredPrefs>): StoredPrefs
}

function cleanPrefs(raw: unknown): StoredPrefs | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const bag = raw as Record<string, unknown>
  const out: StoredPrefs = {}
  if (typeof bag.connectorKey === 'string' && /^[a-f0-9]{64}$/.test(bag.connectorKey))
    out.connectorKey = bag.connectorKey
  if (typeof bag.shareTools === 'boolean') out.shareTools = bag.shareTools
  if (typeof bag.linkAgents === 'boolean') out.linkAgents = bag.linkAgents
  if (typeof bag.setupAnswered === 'boolean') out.setupAnswered = bag.setupAnswered
  if (typeof bag.stopped === 'boolean') out.stopped = bag.stopped
  if (typeof bag.installConsent === 'boolean') out.installConsent = bag.installConsent
  if (bag.connectors && typeof bag.connectors === 'object' && !Array.isArray(bag.connectors)) {
    out.connectors = {}
    for (const [name, value] of Object.entries(bag.connectors)) {
      const v = value as any
      if (
        /^[a-z][a-z0-9_-]{0,31}$/.test(name) &&
        v &&
        typeof v.provider === 'string' &&
        typeof v.rawName === 'string' &&
        /^[a-f0-9]{64}$/.test(v.fingerprint)
      )
        out.connectors[name] = {
          provider: v.provider,
          rawName: v.rawName,
          fingerprint: v.fingerprint
        }
    }
  }
  return Object.keys(out).length ? out : undefined
}

export function fileHostPrefs(
  file: string,
  injectedIo?: Pick<
    typeof fs,
    'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'unlinkSync'
  >
): HostPrefs {
  if (!injectedIo && process.env.NODE_TEST_CONTEXT)
    throw new Error('Tests must inject host preference dependencies')
  const io = injectedIo ?? fs
  const read = (): StoredPrefs | undefined => {
    try {
      return cleanPrefs(JSON.parse(io.readFileSync(file, 'utf8')))
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return undefined
      throw new Error('Could not read bot permissions on this host.')
    }
  }
  return {
    read,
    write(patch) {
      const next: StoredPrefs = { ...(read() ?? {}) }
      for (const key of [
        'shareTools',
        'linkAgents',
        'setupAnswered',
        'installConsent',
        'stopped'
      ] as const) {
        if (typeof patch[key] === 'boolean') next[key] = patch[key]
      }
      if (patch.connectorKey && /^[a-f0-9]{64}$/.test(patch.connectorKey))
        next.connectorKey = patch.connectorKey
      if (patch.connectors)
        next.connectors = cleanPrefs({ connectors: patch.connectors })?.connectors ?? {}
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        io.mkdirSync(dirname(file), { recursive: true })
        io.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
        io.renameSync(temporary, file)
      } catch {
        try {
          io.unlinkSync(temporary)
        } catch {
          /* Already renamed or never created. */
        }
        throw new Error('Could not save bot permissions on this host.')
      }
      return next
    }
  }
}

export function defaultHostPrefs(): HostPrefs {
  if (process.env.NODE_TEST_CONTEXT)
    throw new Error('Tests must inject host preference dependencies')
  return fileHostPrefs(join(homedir(), '.orca-bot', 'preferences.json'))
}
