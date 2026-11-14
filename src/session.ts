import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DesktopRoute {
  gatewayUrl: string
  gatewayToken: string
  headers: Record<string, string>
}

export interface DesktopAccount {
  key: string
  accessToken: string
  teamId?: string
}

export interface DesktopSession {
  route?: DesktopRoute
  account?: DesktopAccount
  appVersion?: string
}

export interface SessionDependencies {
  platform?: string
  appDataPath?: string
  readFile?: (path: string, encoding: 'utf8') => Promise<string>
  readKeychainPassword?: () => Promise<string>
  expectedAccountKey?: string
}

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function notSignedIn(): Error {
  return failure('not_signed_in', 'Open the Grok Bot app and sign in, then retry.')
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parse(text: string): Record<string, any> {
  try {
    const value = JSON.parse(text)
    if (record(value)) return value
  } catch { /* Parse errors can contain secret source text. */ }
  throw failure('INVALID_SESSION', 'Grok Bot session data is invalid. Open the app and sign in again.')
}

export function decryptSafeStorage(ciphertextBase64: string, password: string): string {
  const bytes = Buffer.from(ciphertextBase64, 'base64')
  if (bytes.subarray(0, 3).toString('ascii') !== 'v10') {
    throw failure('UNSUPPORTED_PREFIX', 'Grok Bot encrypted data uses an unsupported format.')
  }
  try {
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
    return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    throw failure('DECRYPT_FAILED', 'Could not decrypt Grok Bot session data. Open the app and sign in again.')
  }
}

function keychainPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Grok Bot Safe Storage'],
      { encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(failure('KEYCHAIN_UNAVAILABLE', 'Unlock your keychain and open the Grok Bot app, then retry.'))
        else resolve(stdout.trimEnd())
      })
  })
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = Object.create(null)
  if (record(value)) {
    for (const [name, entry] of Object.entries(value)) {
      if (entry !== null && entry !== undefined && String(entry) !== '') headers[name.toLowerCase()] = String(entry)
    }
  }
  return { ...headers }
}

export async function readDesktopSession(deps: SessionDependencies = {}): Promise<DesktopSession> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    throw failure('unsupported_platform', 'Grok Bot desktop sessions require macOS.')
  }
  const folder = deps.appDataPath ?? join(homedir(), 'Library', 'Application Support', 'Grok Bot')
  const read = deps.readFile ?? readFile
  async function optionalFile(name: string): Promise<string | undefined> {
    try { return await read(join(folder, name), 'utf8') } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as { code?: string })?.code ?? '')) return undefined
      throw failure('SESSION_READ_FAILED', 'Could not read Grok Bot session data. Check app file permissions and retry.')
    }
  }
  let password: Promise<string> | undefined
  async function decrypt(value: unknown): Promise<string> {
    if (typeof value !== 'string' || !value) {
      throw failure('MISSING_ENCRYPTED_PAYLOAD', 'Grok Bot session data is incomplete. Open the app and sign in again.')
    }
    // Read once per load; a later load must observe the current keychain state.
    password ??= Promise.resolve().then(deps.readKeychainPassword ?? keychainPassword).catch(() => {
      throw failure('KEYCHAIN_UNAVAILABLE', 'Unlock your keychain and open the Grok Bot app, then retry.')
    })
    return decryptSafeStorage(value, await password)
  }
  const result: DesktopSession = {}
  const descriptorText = await optionalFile('gateway-descriptor.json')
  if (descriptorText !== undefined) {
    const descriptor = parse(descriptorText)
    let encrypted = descriptor.encrypted
    if (descriptor.version === 2 || descriptor.version === 3) {
      const entries = record(descriptor.entries) ? Object.values(descriptor.entries) : []
      if (!entries.length) throw failure('EMPTY_ENTRIES', 'Grok Bot has no cached route. Open the app and retry.')
      if (entries.length !== 1) throw failure('AMBIGUOUS_ENTRIES', 'Grok Bot has multiple cached routes. Open the app and sign in again.')
      encrypted = record(entries[0]) ? entries[0].encrypted : undefined
    } else if (descriptor.version !== undefined && descriptor.version !== 1) {
      throw failure('UNSUPPORTED_VERSION', 'Update Bot Deck to read this Grok Bot session version.')
    }
    const route = parse(await decrypt(encrypted))
    if (typeof route.baseUrl !== 'string' || !route.baseUrl || typeof route.token !== 'string' || !route.token) {
      throw failure('INCOMPLETE_DESCRIPTOR', 'Grok Bot cached route is incomplete. Open the app and retry.')
    }
    result.route = { gatewayUrl: route.baseUrl.replace(/\/$/, ''), gatewayToken: route.token, headers: normalizeHeaders(route.headers) }
  }
  const secretsText = await optionalFile('sand-secrets.json')
  if (secretsText !== undefined) {
    const secrets = parse(secretsText)
    if (secrets.version !== undefined && secrets.version !== 1) {
      throw failure('UNSUPPORTED_VERSION', 'Update Bot Deck to read this Grok Bot session version.')
    }
    const accounts = typeof secrets['cursor-accounts'] === 'string' ? parse(secrets['cursor-accounts']) : undefined
    const active = accounts?.active
    if (typeof active === 'string' && record(accounts?.accounts) && Object.hasOwn(accounts.accounts, active)) {
      if (deps.expectedAccountKey !== undefined && active !== deps.expectedAccountKey) {
        throw failure('ACCOUNT_CHANGED', 'The Grok Bot account changed. Reconnect and retry.')
      }
      const account = accounts.accounts[active]
      const accessToken = (await decrypt(record(account) ? account['cursor-access-token'] : undefined)).trim()
      if (!accessToken) throw notSignedIn()
      result.account = { key: active, accessToken }
      const team = account['cursor-selected-team-id']
      if (team !== undefined) {
        const teamId = await decrypt(team)
        if (!/^[1-9][0-9]*$/.test(teamId) || !Number.isSafeInteger(Number(teamId))) {
          throw failure('INVALID_TEAM_ID', 'Grok Bot selected team is invalid. Select a team in the app and retry.')
        }
        result.account.teamId = teamId
      }
    }
  }
  if (deps.expectedAccountKey !== undefined && !result.account) {
    throw failure('ACCOUNT_CHANGED', 'The Grok Bot account changed. Reconnect and retry.')
  }
  if (!result.route && !result.account) throw notSignedIn()
  // Info.plist fallback needs an external command; this reader only uses status JSON.
  try {
    const status = await optionalFile('desktop-status.json')
    const version = status === undefined ? undefined : parse(status).appVersion
    if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) result.appVersion = version
  } catch { /* App version is optional, including unreadable or invalid status JSON. */ }
  return result
}
