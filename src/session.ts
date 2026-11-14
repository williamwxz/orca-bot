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

export type SessionErrorCode =
  | 'not_signed_in'
  | 'unsupported_platform'
  | 'invalid_session'
  | 'unsupported_prefix'
  | 'decrypt_failed'
  | 'keychain_unavailable'
  | 'session_read_failed'
  | 'missing_encrypted_payload'
  | 'ambiguous_entries'
  | 'unsupported_version'
  | 'incomplete_descriptor'
  | 'account_changed'
  | 'invalid_team_id'

function failure(code: SessionErrorCode, message: string): Error & { code: SessionErrorCode } {
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
  throw failure('invalid_session', 'Grok Bot session data is invalid. Open the app and sign in again.')
}

export function decryptSafeStorage(ciphertextBase64: string, password: string): string {
  const bytes = Buffer.from(ciphertextBase64, 'base64')
  if (bytes.subarray(0, 3).toString('ascii') !== 'v10') {
    throw failure('unsupported_prefix', 'Grok Bot encrypted data uses an unsupported format.')
  }
  try {
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
    return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    throw failure('decrypt_failed', 'Could not decrypt Grok Bot session data. Open the app and sign in again.')
  }
}

function keychainPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Grok Bot Safe Storage'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) {
          const message = error.killed
            ? 'Answer the keychain prompt and retry.'
            : 'Unlock your keychain and open the Grok Bot app, then retry.'
          reject(failure('keychain_unavailable', message))
        } else {
          resolve(stdout.trimEnd())
        }
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

type OptionalFile = (name: string) => Promise<string | undefined>
type Decrypt = (value: unknown) => Promise<string>

async function readRoute(optionalFile: OptionalFile, decrypt: Decrypt): Promise<DesktopRoute | undefined> {
  const descriptorText = await optionalFile('gateway-descriptor.json')
  if (descriptorText !== undefined) {
    const descriptor = parse(descriptorText)
    let encrypted = descriptor.encrypted
    if (descriptor.version === 2 || descriptor.version === 3) {
      const entries = record(descriptor.entries) ? Object.values(descriptor.entries) : []
      // Unlike gbot, an empty cache permits account-based route refresh.
      if (!entries.length) return undefined
      if (entries.length !== 1) {
        throw failure('ambiguous_entries', 'Grok Bot has multiple cached routes. Open the app and sign in again.')
      }
      encrypted = record(entries[0]) ? entries[0].encrypted : undefined
    } else if (descriptor.version !== undefined && descriptor.version !== 1) {
      throw failure('unsupported_version', 'Update Bot Deck to read this Grok Bot session version.')
    }
    const route = parse(await decrypt(encrypted))
    if (typeof route.baseUrl !== 'string' || !route.baseUrl || typeof route.token !== 'string' || !route.token) {
      throw failure('incomplete_descriptor', 'Grok Bot cached route is incomplete. Open the app and retry.')
    }
    return {
      gatewayUrl: route.baseUrl.replace(/\/$/, ''),
      gatewayToken: route.token,
      headers: normalizeHeaders(route.headers)
    }
  }
}

async function readAccount(
  optionalFile: OptionalFile,
  decrypt: Decrypt,
  expectedAccountKey?: string
): Promise<DesktopAccount | undefined> {
  const secretsText = await optionalFile('sand-secrets.json')
  if (secretsText !== undefined) {
    const secrets = parse(secretsText)
    if (secrets.version !== undefined && secrets.version !== 1) {
      throw failure('unsupported_version', 'Update Bot Deck to read this Grok Bot session version.')
    }
    const accounts = typeof secrets['cursor-accounts'] === 'string'
      ? parse(secrets['cursor-accounts'])
      : undefined
    const active = accounts?.active
    if (typeof active === 'string' && record(accounts?.accounts) && Object.hasOwn(accounts.accounts, active)) {
      if (expectedAccountKey !== undefined && active !== expectedAccountKey) {
        throw failure('account_changed', 'The Grok Bot account changed. Reconnect and retry.')
      }
      const account = accounts.accounts[active]
      const encryptedToken = record(account) ? account['cursor-access-token'] : undefined
      const accessToken = (await decrypt(encryptedToken)).trim()
      if (!accessToken) throw notSignedIn()
      const result: DesktopAccount = { key: active, accessToken }
      const team = account['cursor-selected-team-id']
      if (team != null) {
        const teamId = await decrypt(team)
        if (!/^[1-9][0-9]*$/.test(teamId) || !Number.isSafeInteger(Number(teamId))) {
          throw failure('invalid_team_id', 'Grok Bot selected team is invalid. Select a team in the app and retry.')
        }
        result.teamId = teamId
      }
      return result
    }
  }
}

async function readAppVersion(optionalFile: OptionalFile): Promise<string | undefined> {
  // Info.plist fallback needs an external command; this reader only uses status JSON.
  try {
    const status = await optionalFile('desktop-status.json')
    const version = status === undefined ? undefined : parse(status).appVersion
    if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
      return version
    }
  } catch { /* App version is optional, including unreadable or invalid status JSON. */ }
}

export async function readDesktopSession(deps: SessionDependencies = {}): Promise<DesktopSession> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    throw failure('unsupported_platform', 'Grok Bot desktop sessions require macOS.')
  }
  const folder = deps.appDataPath ?? join(homedir(), 'Library', 'Application Support', 'Grok Bot')
  const read = deps.readFile ?? readFile
  async function optionalFile(name: string): Promise<string | undefined> {
    try {
      return await read(join(folder, name), 'utf8')
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as { code?: string })?.code ?? '')) return undefined
      throw failure('session_read_failed', 'Could not read Grok Bot session data. Check app file permissions and retry.')
    }
  }
  let password: Promise<string> | undefined
  async function decrypt(value: unknown): Promise<string> {
    if (typeof value !== 'string' || !value) {
      throw failure('missing_encrypted_payload', 'Grok Bot session data is incomplete. Open the app and sign in again.')
    }
    // Read once per load; a later load must observe the current keychain state.
    password ??= deps.readKeychainPassword
      ? Promise.resolve().then(deps.readKeychainPassword).catch(() => {
        throw failure('keychain_unavailable', 'Unlock your keychain and open the Grok Bot app, then retry.')
      })
      : keychainPassword()
    return decryptSafeStorage(value, await password)
  }
  const route = await readRoute(optionalFile, decrypt)
  const account = await readAccount(optionalFile, decrypt, deps.expectedAccountKey)
  if (deps.expectedAccountKey !== undefined && !account) {
    throw failure('account_changed', 'The Grok Bot account changed. Reconnect and retry.')
  }
  if (!route && !account) throw notSignedIn()
  const result: DesktopSession = {}
  if (route) result.route = route
  if (account) result.account = account
  const appVersion = await readAppVersion(optionalFile)
  if (appVersion) result.appVersion = appVersion
  return result
}
