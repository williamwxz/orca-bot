import { test, assert } from 'orca/testing'
import { defaultImportDeps, candidates } from './import-tools.ts'
import type { ImportDeps } from './import-tools.ts'
const findTools = async (deps: ImportDeps) =>
  (await candidates(deps)).map(({ name, source }) => ({ name, source }))
const token = 'SECRET_FAKE_TOKEN_789'
function fake(files: Record<string, unknown> = {}) {
  const calls: { path: string; method: string; body?: any }[] = []
  const deps: ImportDeps = {
    home: '/home',
    platform: 'darwin',
    env: { PATH: '/bin' },
    userInfo: () => ({ username: 'test', shell: '/bin/sh' }),
    read: (path) => {
      if (!(path in files)) throw new Error(token)
      return JSON.stringify(files[path])
    },
    exists: (path) => path === '/bin/codex',
    claudeEnv: () => ({ CLAUDE_CONFIG_DIR: '/orca' }),
    listCodex: async () => [],
    owned: async () => true,
    request: async (_port, path, method, body) => {
      calls.push({ path, method, body })
      if (method === 'GET') return { servers: [] }
      if (method === 'POST')
        return { added: Object.keys(JSON.parse((body as any).json).mcpServers) }
      return { servers: [] }
    }
  }
  return { deps, calls }
}
const source = (mcpServers: object) => ({ mcpServers })
test('import defaults forbid live effects in tests', () => {
  assert.throws(defaultImportDeps, /inject/)
})
test('sources merge in priority order, normalize names, exclude own and disabled entries, and return only public metadata', async () => {
  const { deps } = fake({
    '/orca/.claude.json': source({
      'Shared Name': { command: 'first', env: { TOKEN: token } },
      'orca-bot': { command: 'x' },
      loop: { command: '/bin/openmausbot', args: ['mcp'] },
      off: { url: 'https://off', disabled: true }
    }),
    '/home/.claude.json': source({
      'Shared Name': { command: 'second' },
      duplicate: { env: { TOKEN: token }, command: 'first' },
      system: { url: 'https://system' }
    }),
    '/home/Library/Application Support/Claude/claude_desktop_config.json': source({
      desktop: { url: 'https://desktop' }
    }),
    '/home/.cursor/mcp.json': source({ cursor: { command: 'cursor-tool' } }),
    '/home/.gemini/settings.json': source({
      gemini: { command: 'gemini-tool' },
      '123': { command: 'ignored' }
    })
  })
  deps.listCodex = async () => [
    {
      name: 'codex',
      transport: {
        type: 'stdio',
        command: 'codex-tool',
        args: [token],
        env: { KEY: token },
        env_vars: [],
        cwd: null
      }
    },
    { name: 'off', enabled: false, transport: { type: 'stdio', command: 'off' } },
    { name: 'unknown', transport: { type: 'other', command: 'x' } },
    {
      name: 'remote',
      transport: {
        type: 'streamable_http',
        url: `https://host/${token}`,
        http_headers: { auth: token }
      }
    },
    {
      name: 'unmapped',
      transport: { type: 'streamable_http', url: 'https://host', bearer_token_env_var: 'AUTH' }
    }
  ]
  const tools = await findTools(deps)
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      'shared-name',
      'shared-name-claude-code',
      'system',
      'desktop',
      'cursor',
      'mcp-123',
      'gemini',
      'codex',
      'remote'
    ]
  )
  assert.deepEqual(
    tools.map((t) => t.source),
    [
      'Claude Code (Orca)',
      'Claude Code (system)',
      'Claude Code (system)',
      'Claude Desktop',
      'Cursor',
      'Gemini CLI',
      'Gemini CLI',
      'Codex',
      'Codex'
    ]
  )
  assert.equal(JSON.stringify(tools).includes(token), false)
  deps.platform = 'linux'
  assert.equal(
    (await findTools(deps)).some((t) => t.name === 'desktop'),
    false
  )
})
test('missing, malformed and unreadable sources and CLI output are silent', async () => {
  const { deps } = fake()
  deps.read = () => '{'
  deps.listCodex = async () => {
    throw new Error(token)
  }
  assert.deepEqual(await findTools(deps), [])
})
test('opencode V2 and legacy plus Antigravity import in order without exposing definitions', async () => {
  for (const v2 of [true, false]) {
    const entries = {
      local: { type: 'local', command: ['tool', 'arg'], environment: { TOKEN: token } },
      remote: { type: 'remote', url: 'https://fake', headers: { auth: token } },
      disabled: { type: 'local', command: ['disabled'], disabled: true },
      off: { type: 'local', command: ['off'], enabled: false },
      cwd: { type: 'local', command: ['cwd'], cwd: '/tmp' },
      indirect: { type: 'local', command: ['indirect'], environment: { KEY: '{env:KEY}' } },
      own: { type: 'local', command: ['/bin/openmausbot', 'mcp'] },
      'orca-bot': { type: 'remote', url: 'https://own' },
      invalid: { type: 'local', command: [123] },
      '123': { type: 'local', command: ['invalid-name'] }
    }
    const { deps, calls } = fake({
      '/home/.config/opencode/opencode.json': {
        mcp: v2 ? { servers: entries, ignored: { type: 'local', command: ['ignored'] } } : entries
      },
      '/home/.gemini/config/mcp_config.json': source({
        agy: { command: 'agy-tool', args: [token], env: { TOKEN: token } },
        agyremote: { url: 'https://agy', headers: { auth: token } },
        agyoff: { command: 'off', disabled: true },
        agyindirect: { command: '${TOOL}' },
        'orca-bot': { command: 'own' },
        agyloop: { command: 'openmausbot', args: ['mcp'] }
      })
    })
    deps.listCodex = async () => [
      { name: 'codex', transport: { type: 'stdio', command: 'codex-tool' } }
    ]
    const tools = await findTools(deps)
    assert.deepEqual(
      tools.map((t) => [t.name, t.source]),
      [
        ['codex', 'Codex'],
        ['mcp-123', 'opencode'],
        ['local', 'opencode'],
        ['remote', 'opencode'],
        ['agy', 'Antigravity'],
        ['agyremote', 'Antigravity']
      ]
    )
    assert.equal(JSON.stringify(tools).includes(token), false)
  }
})
test('new import sources reject malformed V2 and unknown Antigravity shapes', async () => {
  const { deps } = fake({
    '/home/.config/opencode/opencode.json': {
      mcp: { servers: null, legacy: { type: 'local', command: ['ignored'] } }
    },
    '/home/.gemini/config/mcp_config.json': { servers: { ignored: { command: 'ignored' } } }
  })
  assert.deepEqual(await findTools(deps), [])
})
test('Claude plugins contribute MCP servers from the live synced generation and enabled installs only', async () => {
  const org = '/orca/plugins/synced/org'
  const { deps } = fake({
    [`${org}/manifest.json`]: {
      plugins: [
        { name: 'design', generation: 3 },
        { name: 'solo', generation: 1 },
        { name: 'gone', generation: 2 },
        { name: '../escape', generation: 1 }
      ]
    },
    [`${org}/design~g3/.mcp.json`]: source({
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      rooted: { command: '${CLAUDE_PLUGIN_ROOT}/bin/tool' },
      blank: { type: 'http', url: '' }
    }),
    [`${org}/design/.mcp.json`]: source({ stale: { url: 'https://stale' } }),
    [`${org}/solo/.claude-plugin/plugin.json`]: { mcpServers: './agents/claude/.mcp.json' },
    [`${org}/solo/agents/claude/.mcp.json`]: source({
      supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp', headers: { 'X-Source-Name': 'claude' } }
    }),
    '/home/.claude/settings.json': { enabledPlugins: { 'on@market': true, 'off@market': false } },
    '/home/.claude/plugins/installed_plugins.json': {
      plugins: {
        'on@market': [{ installPath: '/home/.claude/plugins/cache/on' }],
        'off@market': [{ installPath: '/home/.claude/plugins/cache/off' }]
      }
    },
    '/home/.claude/plugins/cache/on/.claude-plugin/plugin.json': {
      mcpServers: { inline: { command: 'inline-tool' }, escape: '../../outside' }
    },
    '/home/.claude/plugins/cache/off/.mcp.json': source({ off: { command: 'off-tool' } })
  })
  deps.list = (dir) => {
    if (dir === '/orca/plugins/synced') return ['org']
    if (dir === org) return ['manifest.json', 'design', 'design~g3', 'solo', 'gone']
    throw new Error('missing')
  }
  assert.deepEqual(await findTools(deps), [
    { name: 'linear', source: 'Claude plugins' },
    { name: 'supabase', source: 'Claude plugins' },
    { name: 'inline', source: 'Claude plugins' }
  ])
  delete deps.list
  assert.deepEqual(
    (await findTools(deps)).map((t) => t.name),
    ['inline']
  )
  // A plugin file that is a link to somewhere outside its folder is not read.
  deps.realpath = (path) =>
    path === '/home/.claude/plugins/cache/on/.claude-plugin/plugin.json' ? '/etc/elsewhere/plugin.json' : path
  assert.deepEqual(await findTools(deps), [])
  // A plugin folder that is itself a link works, and the file read is the resolved path that was
  // checked: a link swapped after the check cannot redirect the read.
  const reads: string[] = []
  const read = deps.read
  deps.read = (path) => {
    reads.push(path)
    return read(path.replace('/real/on', '/home/.claude/plugins/cache/on'))
  }
  let lookups = 0
  deps.realpath = (path) => {
    if (path.endsWith('/on/.claude-plugin/plugin.json') && ++lookups > 1) return '/etc/swapped/plugin.json'
    return path.replace('/home/.claude/plugins/cache/on', '/real/on')
  }
  assert.deepEqual((await findTools(deps)).map((t) => t.name), ['inline'])
  assert.equal(lookups, 1)
  assert.ok(reads.includes('/real/on/.claude-plugin/plugin.json'))
  assert.equal(reads.some((path) => path.startsWith('/etc/')), false)
})
