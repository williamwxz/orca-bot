import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { basename } from 'node:path'
import { assert, test } from 'orca/testing'
import { decryptSafeStorage, readDesktopSession } from './session'

const PASSWORD = 'fixture-password-only'
const TOKEN = 'fixture-access-secret'
const GATEWAY_TOKEN = 'fixture-gateway-secret'
function encrypt(text: string): string {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(PASSWORD, 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, 32))
  return Buffer.concat([Buffer.from('v10'), cipher.update(text), cipher.final()]).toString('base64')
}
const payload = () => encrypt(JSON.stringify({ baseUrl: 'https://gateway.example.invalid/', token: GATEWAY_TOKEN,
  headers: { 'X-Example': 42, Empty: '', Null: null, False: false } }))
function secrets(active: unknown = 'chosen', team?: string) {
  return { version: 1, 'cursor-accounts': JSON.stringify({ active, accounts: {
    other: { 'cursor-access-token': encrypt('other-fixture-token') },
    chosen: { 'cursor-access-token': encrypt(`  ${TOKEN} \n`), ...(team === undefined ? {} : { 'cursor-selected-team-id': encrypt(team) }) }
  } }) }
}
function fixture(files: Record<string, unknown> = {}) {
  return { platform: 'darwin', appDataPath: '/invented-session',
    readFile: async (path: string) => {
      const name = basename(path)
      if (!Object.hasOwn(files, name)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
      return typeof files[name] === 'string' ? files[name] as string : JSON.stringify(files[name])
    }, readKeychainPassword: async () => PASSWORD }
}
async function rejects(operation: () => unknown, code: string) {
  await assert.rejects(async () => operation(), (error: any) => {
    assert.ok(error instanceof Error)
    assert.equal(error.code, code)
    for (const secret of [PASSWORD, TOKEN, GATEWAY_TOKEN]) assert.equal(error.message.includes(secret), false)
    return true
  })
}

test('Safe Storage round trip and unsupported prefix', async () => {
  assert.equal(decryptSafeStorage(encrypt(TOKEN), PASSWORD), TOKEN)
  await rejects(() => decryptSafeStorage(Buffer.from(`v11${PASSWORD}${TOKEN}${GATEWAY_TOKEN}`).toString('base64'), PASSWORD), 'UNSUPPORTED_PREFIX')
  await rejects(() => decryptSafeStorage(encrypt(TOKEN), 'wrong-fixture-password'), 'DECRYPT_FAILED')
})

test('descriptor versions and normalized headers', async () => {
  for (const version of [undefined, 1, 2, 3]) {
    const descriptor = version === 2 || version === 3 ? { version, entries: { invented: { encrypted: payload() } } } : { version, encrypted: payload() }
    const session = await readDesktopSession(fixture({ 'gateway-descriptor.json': descriptor }))
    assert.deepEqual(session.route, { gatewayUrl: 'https://gateway.example.invalid', gatewayToken: GATEWAY_TOKEN,
      headers: { 'x-example': '42', false: 'false' } })
    assert.equal(session.account, undefined)
  }
})

test('descriptor errors are explicit and contain no secrets', async () => {
  const cases: [unknown, string][] = [
    [{ version: 3, entries: {} }, 'EMPTY_ENTRIES'],
    [{ version: 3, entries: { a: {}, b: {} } }, 'AMBIGUOUS_ENTRIES'],
    [{ version: 9 }, 'UNSUPPORTED_VERSION'],
    [{ version: 1 }, 'MISSING_ENCRYPTED_PAYLOAD'],
    [{ encrypted: encrypt(JSON.stringify({ baseUrl: PASSWORD, headers: { secret: TOKEN }, extra: GATEWAY_TOKEN })) }, 'INCOMPLETE_DESCRIPTOR'],
    [{ encrypted: encrypt(`invalid ${PASSWORD} ${TOKEN} ${GATEWAY_TOKEN}`) }, 'INVALID_SESSION'],
    [`invalid ${PASSWORD} ${TOKEN} ${GATEWAY_TOKEN}`, 'INVALID_SESSION']
  ]
  for (const [descriptor, code] of cases) {
    await rejects(() => readDesktopSession(fixture({ 'gateway-descriptor.json': descriptor, 'sand-secrets.json': secrets() })), code)
  }
})

test('uses only the active account and validates expected identity', async () => {
  const deps = fixture({ 'sand-secrets.json': secrets('chosen', '42') })
  assert.deepEqual((await readDesktopSession(deps)).account, { key: 'chosen', accessToken: TOKEN, teamId: '42' })
  await rejects(() => readDesktopSession({ ...deps, expectedAccountKey: 'other' }), 'ACCOUNT_CHANGED')
  for (const active of ['missing', '__proto__', null]) {
    await rejects(() => readDesktopSession(fixture({ 'sand-secrets.json': secrets(active) })), 'not_signed_in')
  }
})

test('rejects invalid team ids without trimming', async () => {
  for (const team of ['0', '01', ' 42', '42 ', '-1', '9007199254740992', PASSWORD + TOKEN + GATEWAY_TOKEN]) {
    await rejects(() => readDesktopSession(fixture({ 'sand-secrets.json': secrets('chosen', team) })), 'INVALID_TEAM_ID')
  }
})

test('validates account format, version and empty tokens', async () => {
  await rejects(() => readDesktopSession(fixture({ 'sand-secrets.json': { ...secrets(), version: 2 } })), 'UNSUPPORTED_VERSION')
  for (const token of ['', '   ']) {
    const accounts = { active: 'chosen', accounts: { chosen: { 'cursor-access-token': token ? encrypt(token) : '' } } }
    await rejects(() => readDesktopSession(fixture({ 'sand-secrets.json': { 'cursor-accounts': JSON.stringify(accounts) } })), token ? 'not_signed_in' : 'MISSING_ENCRYPTED_PAYLOAD')
  }
})

test('app version is optional and validated', async () => {
  for (const status of [undefined, {}, { appVersion: 'invalid' }, { appVersion: 123 }, 'broken JSON']) {
    const files: Record<string, unknown> = { 'sand-secrets.json': secrets() }
    if (status !== undefined) files['desktop-status.json'] = status
    assert.equal((await readDesktopSession(fixture(files))).appVersion, undefined)
  }
  assert.equal((await readDesktopSession(fixture({ 'sand-secrets.json': secrets(), 'desktop-status.json': { appVersion: '1.2.3-beta.4' } }))).appVersion, '1.2.3-beta.4')
})

test('missing folder prompts sign-in and unsupported platforms touch nothing', async () => {
  await rejects(() => readDesktopSession(fixture()), 'not_signed_in')
  await assert.rejects(readDesktopSession(fixture()), /Open the Grok Bot app and sign in/)
  await rejects(() => readDesktopSession({ platform: 'linux', readFile: async () => { assert.fail('file read'); },
    readKeychainPassword: async () => { assert.fail('keychain read'); } }), 'unsupported_platform')
})

test('file and keychain failures never expose underlying errors', async () => {
  const unsafe = () => { throw new Error(PASSWORD + TOKEN + GATEWAY_TOKEN) }
  await rejects(() => readDesktopSession({ ...fixture(), readFile: async () => unsafe() }), 'SESSION_READ_FAILED')
  await rejects(() => readDesktopSession({ ...fixture({ 'gateway-descriptor.json': { encrypted: payload() } }), readKeychainPassword: async () => unsafe() }), 'KEYCHAIN_UNAVAILABLE')
})

test('loads route and account with one password read per session', async () => {
  let calls = 0
  const deps = fixture({ 'gateway-descriptor.json': { encrypted: payload() }, 'sand-secrets.json': secrets('chosen', '42') })
  const session = await readDesktopSession({ ...deps, readKeychainPassword: async () => { calls++; return PASSWORD } })
  assert.ok(session.route)
  assert.ok(session.account)
  assert.equal(calls, 1)
  await rejects(() => readDesktopSession({ ...deps, readKeychainPassword: () => { throw new Error(PASSWORD + TOKEN + GATEWAY_TOKEN) } }), 'KEYCHAIN_UNAVAILABLE')
})
