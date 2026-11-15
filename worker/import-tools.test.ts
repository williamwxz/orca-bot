import { test, assert } from 'orca/testing'
import { defaultImportDeps, findTools, importTools, importMessage } from './import-tools.ts'
import type { ImportDeps } from './import-tools.ts'
const token = 'SECRET_FAKE_TOKEN_789'
function fake(files: Record<string, unknown> = {}) {
  const calls: { path: string; method: string; body?: any }[] = []
  const deps: ImportDeps = {
    home: '/home', platform: 'darwin', env: { PATH: '/bin' }, userInfo: () => ({ username: 'test', shell: '/bin/sh' }),
    read: path => { if (!(path in files)) throw new Error(token); return JSON.stringify(files[path]) }, exists: path => path === '/bin/codex',
    claudeEnv: () => ({ CLAUDE_CONFIG_DIR: '/orca' }), listCodex: async () => [], owned: async () => true,
    request: async (_port, path, method, body) => {
      calls.push({ path, method, body })
      if (method === 'GET') return { servers: [] }
      if (method === 'POST') return { added: Object.keys(JSON.parse((body as any).json).mcpServers) }
      return { servers: [] }
    }
  }
  return { deps, calls }
}
const source = (mcpServers: object) => ({ mcpServers })
test('import defaults forbid live effects in tests', () => { assert.throws(defaultImportDeps, /inject/) })
test('sources merge in priority order, normalize names, exclude own and disabled entries, and return only public metadata', async () => {
  const { deps } = fake({
    '/orca/.claude.json': source({ 'Shared Name': { command: 'first', env: { TOKEN: token } }, 'orca-bot': { command: 'x' }, loop: { command: '/bin/openmausbot', args: ['mcp'] }, off: { url: 'https://off', disabled: true } }),
    '/home/.claude.json': source({ 'Shared Name': { command: 'second' }, duplicate: { env: { TOKEN: token }, command: 'first' }, system: { url: 'https://system' } }),
    '/home/Library/Application Support/Claude/claude_desktop_config.json': source({ desktop: { url: 'https://desktop' } }),
    '/home/.cursor/mcp.json': source({ cursor: { command: 'cursor-tool' } }),
    '/home/.gemini/settings.json': source({ gemini: { command: 'gemini-tool' }, '123': { command: 'ignored' } })
  })
  deps.listCodex = async () => [{ name: 'codex', transport: { type: 'stdio', command: 'codex-tool', args: [token], env: { KEY: token }, env_vars: [], cwd: null } }, { name: 'off', enabled: false, transport: { type: 'stdio', command: 'off' } }, { name: 'unknown', transport: { type: 'other', command: 'x' } }, { name: 'remote', transport: { type: 'streamable_http', url: `https://host/${token}`, http_headers: { auth: token } } }, { name: 'unmapped', transport: { type: 'streamable_http', url: 'https://host', bearer_token_env_var: 'AUTH' } }]
  const tools = await findTools(deps)
  assert.deepEqual(tools.map(t => t.name), ['shared-name', 'system', 'desktop', 'cursor', 'gemini', 'codex', 'remote'])
  assert.deepEqual(tools.map(t => t.source), ['Claude Code (Orca)', 'Claude Code (system)', 'Claude Desktop', 'Cursor', 'Gemini CLI', 'Codex', 'Codex'])
  assert.equal(JSON.stringify(tools).includes(token), false)
  deps.platform = 'linux'
  assert.equal((await findTools(deps)).some(t => t.name === 'desktop'), false)
})
test('missing, malformed and unreadable sources and CLI output are silent', async () => {
  const { deps } = fake()
  deps.read = () => '{'
  deps.listCodex = async () => { throw new Error(token) }
  assert.deepEqual(await findTools(deps), [])
})
test('existing disabled servers dedupe by command/args or URL, and collision suffixes stay bounded', async () => {
  const { deps, calls } = fake({ '/orca/.claude.json': source({ one: { command: 'same', args: [token] }, two: { url: `https://host/${token}`, headers: { auth: token } }, collision: { command: 'new' } }) })
  const request = deps.request
  deps.request = async (port, path, method, body) => method === 'GET' ? { servers: [{ name: 'old', command: 'same', args: [token], enabled: false }, { name: 'old-remote', url: `https://host/${token}`, enabled: false }, { name: 'collision', command: 'other' }] } : request(port, path, method, body)
  assert.deepEqual(await importTools(1234, deps), { added: ['collision-2'], skipped: [{ name: 'one', reason: 'already here' }, { name: 'two', reason: 'already here' }] })
  assert.deepEqual(calls.map(c => [c.method, c.path]), [['POST', '/api/mcp/servers/import'], ['PATCH', '/api/mcp/servers/collision-2']])
})
test('one POST per tool, switch off returned name, isolate POST and PATCH failures without exposing tokens', async () => {
  const { deps, calls } = fake({ '/orca/.claude.json': source({ bad: { command: 'bad', args: [token] }, on: { command: 'on', env: { TOKEN: token } }, good: { url: `https://host/${token}`, headers: { auth: token } } }) })
  const request = deps.request
  deps.request = async (port, path, method, body) => {
    const response = await request(port, path, method, body)
    if (method === 'POST') {
      const name = Object.keys(JSON.parse((body as any).json).mcpServers)[0]
      if (name === 'bad') throw new Error(token)
      if (name === 'good') return { added: ['good-2'], error: token }
    }
    if (path.endsWith('/on')) throw new Error(token)
    return response
  }
  const result = await importTools(1234, deps)
  assert.deepEqual(result, { added: ['good-2'], skipped: [{ name: 'bad', reason: 'failed' }, { name: 'on', reason: 'failed' }] })
  assert.equal(calls.filter(c => c.method === 'POST').length, 3)
  assert.deepEqual(calls.filter(c => c.method === 'PATCH').map(c => [c.path, c.body]), [['/api/mcp/servers/on', { enabled: false }], ['/api/mcp/servers/good-2', { enabled: false }]])
  assert.equal(JSON.stringify(result).includes(token), false)
  assert.match(importMessage(result), /failed to import or switch off/)
})
test('unowned servers refuse before reading sources or requesting, and errors are generic', async () => {
  const { deps, calls } = fake()
  deps.owned = async () => false
  deps.read = () => { throw new Error('should not read') }
  await assert.rejects(importTools(1234, deps), /server Orca Bot started/)
  assert.equal(calls.length, 0)
  deps.owned = async () => { throw new Error(token) }
  await assert.rejects(importTools(1234, deps), error => !String(error).includes(token))
  deps.owned = async () => true
  deps.request = async () => { throw new Error(token) }
  await assert.rejects(importTools(1234, deps), /Could not check existing tools/)
})
