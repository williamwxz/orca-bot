import { test, assert } from 'orca/testing'
import { candidates, nameOf, uniqueName, requestFailure } from './import-tools.ts'
import type { ImportDeps } from './import-tools.ts'
import { createConnectors } from './mcp-connectors.ts'
import type { StoredPrefs } from './host-prefs.ts'
import { fileHostPrefs } from './host-prefs.ts'
import { RELAYED, pack, unpack } from './relay-frames.ts'

const secret = 'FAKE_SECRET_DO_NOT_EXPOSE'
function fixture() {
  let saved: StoredPrefs = {}
  const servers: any[] = [{ name: 'old', enabled: true, command: 'old', args: [] }]
  const bots: any[] = [
    { id: 'a', name: 'Work', chiefOfStaff: true },
    { id: 'b', name: 'Personal', mcpServers: [] },
    { id: 'hidden', name: 'Hidden', hidden: true }
  ]
  const calls: { path: string; method: string; body?: any }[] = []
  const files: Record<string, any> = {
    '/home/Library/Application Support/Claude/claude_desktop_config.json': {
      mcpServers: { gmail: { command: 'mail', args: [], env: { TOKEN: secret } } }
    },
    '/home/.cursor/mcp.json': {
      mcpServers: {
        gmail: { command: 'mail', args: [], env: { TOKEN: 'OTHER_ACCOUNT' } },
        calendar: { url: 'https://calendar', headers: { Authorization: secret } }
      }
    }
  }
  let defaults = {
    profile: { title: 'Keep title' },
    memory: { 'MEMORY.md': 'keep' },
    skills: [],
    routines: []
  } as any
  const deps: ImportDeps = {
    home: '/home',
    platform: 'darwin',
    env: { PATH: '/bin' },
    userInfo: () => ({ username: 'test', shell: '/bin/sh' }),
    read: (path) => JSON.stringify(files[path]),
    exists: () => false,
    claudeEnv: () => ({}),
    listCodex: async () => [],
    owned: async () => true,
    request: async (_port, path, method, body: any) => {
      calls.push({ path, method, body })
      if (path === '/api/bot-defaults') return { defaults: structuredClone(defaults) }
      if (path === '/api/config') {
        defaults = structuredClone(body.newBotDefaults)
        return {}
      }
      if (method === 'GET') return structuredClone(path.includes('/bots') ? { bots } : { servers })
      if (path.startsWith('/api/bots/')) {
        Object.assign(
          bots.find((b) => b.id === decodeURIComponent(path.split('/').at(-1)!)),
          body
        )
        return {}
      }
      if (method === 'POST') {
        const imported = JSON.parse(body.json).mcpServers
        const names = Object.keys(imported)
        servers.push(...names.map((name) => ({ name, ...imported[name], enabled: false })))
        return { added: names }
      }
      const name = path.split('/').at(-1)
      const index = servers.findIndex((s) => s.name === name)
      if (index < 0) throw new Error(secret)
      if (method === 'DELETE') servers.splice(index, 1)
      else Object.assign(servers[index], body)
      return {}
    }
  }
  const prefs = {
    read: () => saved,
    write: (patch: Partial<StoredPrefs>) => (saved = { ...saved, ...patch })
  }
  const service = createConnectors(deps, prefs)
  const act = async (port: number, input: any) => {
    const state = await service.list(port)
    const expected =
      input.action === 'group'
        ? {
            targets: state.connectors
              .filter((c) => c.provider === input.provider && !c.bot)
              .map(({ name, fingerprint }) => ({ name, fingerprint }))
          }
        : { fingerprint: state.connectors.find((c) => c.name === input.name)?.fingerprint }
    return service.act(port, { ...input, ...expected })
  }
  return { deps, prefs, servers, bots, calls, files, service, act, defaults: () => defaults }
}

test('discovery keeps same-name accounts with different env/headers, dedupes only full canonical definitions and avoids reserved names', async () => {
  const f = fixture()
  f.files['/home/.gemini/settings.json'] = {
    mcpServers: {
      gmail: { env: { TOKEN: secret }, command: 'mail', args: [] },
      calendar: { url: 'https://calendar', headers: { Authorization: 'SECOND' } },
      email: { command: 'reserved' }
    }
  }
  const found = await candidates(f.deps)
  assert.deepEqual(
    found.map((c) => c.name),
    ['gmail', 'gmail-cursor', 'calendar', 'calendar-gemini-cli', 'mcp-email']
  )
  for (const c of found) {
    assert.match(c.name, /^[a-z][a-z0-9_-]{0,31}$/)
  }
})

test('enable materializes all bots including hidden bots, preserves old access and clears stale explicit grants', async () => {
  const f = fixture()
  f.bots[1].mcpServers = ['gmail']
  const result = await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  assert.deepEqual(
    f.bots.map((b) => b.mcpServers),
    [['old'], [], ['old']]
  )
  assert.deepEqual(result.connectors.find((c) => c.name === 'gmail')?.bots, [])
  assert.equal(result.bots.length, 2)
  assert.match(result.bots[0].name, /Chief of Staff/)
  const on = f.calls.findIndex((c) => c.method === 'PATCH' && c.body.enabled === true)
  assert.ok(
    f.calls
      .filter((c) => c.path.startsWith('/api/bots/') && c.method === 'PATCH')
      .every((c) => f.calls.indexOf(c) < on)
  )
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(f.prefs.read()).includes(secret), false)
  assert.deepEqual(Object.keys(f.prefs.read().connectors!.gmail).sort(), [
    'fingerprint',
    'provider',
    'rawName'
  ])
})

test('provider enable/disable, explicit assignments and remove preserve other providers and clean provenance', async () => {
  const f = fixture()
  let result = await f.act(1234, { action: 'group', provider: 'Cursor', enabled: true })
  assert.equal(result.connectors.filter((c) => c.provider === 'Cursor' && c.enabled).length, 2)
  assert.equal(result.connectors.find((c) => c.name === 'gmail')?.present, false)
  await f.act(1234, { action: 'assign', name: 'gmail-cursor', bots: ['a'] })
  await f.act(1234, { action: 'assign', name: 'calendar', bots: ['b'] })
  assert.deepEqual(f.bots[0].mcpServers, ['old', 'gmail-cursor'])
  assert.deepEqual(f.bots[1].mcpServers, ['calendar'])
  result = await f.act(1234, { action: 'group', provider: 'Cursor', enabled: false })
  assert.equal(result.connectors.filter((c) => c.provider === 'Cursor' && c.enabled).length, 0)
  assert.equal(f.servers.find((s) => s.name === 'old').enabled, true)
  await f.act(1234, { action: 'remove', name: 'gmail-cursor' })
  assert.equal(
    f.servers.some((s) => s.name === 'gmail-cursor'),
    false
  )
  assert.equal('gmail-cursor' in f.prefs.read().connectors!, false)
  assert.equal(
    f.bots.some((b) => b.mcpServers.includes('gmail-cursor')),
    false
  )
})

test('busy 409 during materialization stops before import or enabling; partial success grants no new access', async () => {
  const f = fixture()
  const request = f.deps.request
  f.deps.request = async (port, path, method, body) => {
    if (path === '/api/bots/hidden' && method === 'PATCH')
      throw new Error('A bot is currently working. Retry once all bots are idle.')
    return request(port, path, method, body)
  }
  await assert.rejects(
    f.act(1234, { action: 'group', provider: 'Cursor', enabled: true }),
    /currently working/
  )
  assert.deepEqual(f.bots[0].mcpServers, ['old'])
  assert.equal(
    f.calls.some((c) => c.method === 'POST'),
    false
  )
  assert.equal(
    f.servers.some((s) => s.name === 'gmail-cursor'),
    false
  )
})

test('assignment materializes unrestricted bots and handles partial busy failures without granting unchecked bots', async () => {
  const f = fixture()
  f.servers.push({ name: 'custom', enabled: true, url: 'https://custom' })
  const request = f.deps.request
  f.deps.request = async (port, path, method, body) => {
    if (path === '/api/bots/b' && method === 'PATCH')
      throw new Error('A bot is currently working. Retry once all bots are idle.')
    return request(port, path, method, body)
  }
  await assert.rejects(
    f.act(1234, { action: 'assign', name: 'custom', bots: ['b'] }),
    /currently working/
  )
  assert.deepEqual(f.bots[0].mcpServers, ['old'])
  assert.deepEqual(f.bots[1].mcpServers, [])
})

test('recorded fingerprints distinguish redacted accounts; missing or changed source appears under OpenMausBot', async () => {
  const f = fixture()
  await f.act(1234, { action: 'group', provider: 'Cursor', enabled: true })
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  f.servers.forEach((s) => {
    delete s.env
    delete s.headers
  })
  let rows = (await f.service.list(1234)).connectors
  assert.equal(rows.find((c) => c.name === 'gmail-cursor')?.provider, 'Cursor')
  assert.equal(rows.find((c) => c.name === 'gmail')?.provider, 'Claude Desktop')
  f.files['/home/.cursor/mcp.json'].mcpServers.gmail.env.TOKEN = 'CHANGED'
  rows = (await f.service.list(1234)).connectors
  assert.equal(rows.find((c) => c.name === 'gmail-cursor')?.provider, 'OpenMausBot')
  assert.equal(rows.filter((c) => c.provider === 'Cursor' && !c.present).length, 1)
})

test('limits, invalid selections, ownership and dependency failures fail closed without secret exposure', async () => {
  const f = fixture()
  f.bots[0].mcpServers = Array.from({ length: 20 }, (_, n) => `server-${n}`)
  await assert.rejects(
    f.act(1234, { action: 'assign', name: 'old', bots: ['a'] }),
    /20 connector limit/
  )
  assert.equal(
    f.calls.some((c) => c.method !== 'GET'),
    false
  )
  await assert.rejects(f.act(1234, { action: 'assign', name: 'old', bots: ['unknown'] }))
  f.deps.owned = async () => false
  await assert.rejects(f.service.list(1234), /started by this plugin/)
  f.deps.owned = async () => {
    throw new Error(secret)
  }
  await assert.rejects(f.service.list(1234), (error) => !String(error).includes(secret))
})

test('failed deletion leaves connector off; failed provenance write never enables imported connector', async () => {
  for (const failure of ['delete', 'prefs']) {
    const f = fixture()
    const request = f.deps.request
    if (failure === 'delete') {
      f.deps.request = async (p, path, method, body) => {
        if (method === 'DELETE') throw new Error(secret)
        return request(p, path, method, body)
      }
      await assert.rejects(f.act(1234, { action: 'remove', name: 'old' }))
      assert.equal(f.servers[0].enabled, false)
    } else {
      await f.service.list(1234) // Initialize the identity key before testing the provenance write failure.
      f.prefs.write = () => {
        throw new Error(secret)
      }
      await assert.rejects(f.act(1234, { action: 'toggle', name: 'gmail', enabled: true }))
      assert.equal(
        f.servers.some((s) => s.name === 'gmail'),
        false
      )
    }
  }
})

test('host preferences whitelist provenance fields and strip injected credentials on disk and readback', () => {
  const files = new Map<string, string>()
  const prefs = fileHostPrefs('/prefs', {
    readFileSync: (path) => {
      if (!files.has(String(path))) throw Object.assign(new Error(), { code: 'ENOENT' })
      return files.get(String(path)) as never
    },
    writeFileSync: (path, data) => {
      files.set(String(path), String(data))
    },
    mkdirSync: () => undefined,
    renameSync: (from, to) => {
      files.set(String(to), files.get(String(from))!)
      files.delete(String(from))
    },
    unlinkSync: (path) => {
      files.delete(String(path))
    }
  })
  prefs.write({
    connectors: {
      mail: {
        provider: 'Cursor',
        rawName: 'mail',
        fingerprint: 'a'.repeat(64),
        env: { TOKEN: secret },
        headers: { auth: secret }
      }
    }
  } as any)
  assert.equal(files.get('/prefs')!.includes(secret), false)
  assert.deepEqual(prefs.read()?.connectors?.mail, {
    provider: 'Cursor',
    rawName: 'mail',
    fingerprint: 'a'.repeat(64)
  })
})

test('relay allowlist carries identical public connector requests and responses without definitions', async () => {
  const f = fixture()
  assert.ok(RELAYED.includes('mcp.list'))
  assert.ok(RELAYED.includes('mcp.act'))
  const action = { action: 'toggle', name: 'gmail', enabled: true } as const
  const result = await f.act(1234, unpack(pack(action)))
  assert.deepEqual(unpack(pack(result)), result)
  const wire = JSON.stringify(result)
  for (const value of [secret, 'OTHER_ACCOUNT', 'https://calendar', 'headers', 'env'])
    assert.equal(wire.includes(value), false)
})

test('new-bot defaults preserve the entire template and new unrestricted bots are reconciled on list and background polls', async () => {
  const f = fixture()
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  assert.deepEqual(f.defaults(), {
    profile: { title: 'Keep title', mcpServers: [] },
    memory: { 'MEMORY.md': 'keep' },
    skills: [],
    routines: []
  })
  f.bots.push({ id: 'later', name: 'Later' })
  await f.service.list(1234)
  assert.deepEqual(f.bots.at(-1).mcpServers, ['old'])
  f.bots.push({ id: 'background', name: 'Background' })
  await f.service.reconcile(1234)
  assert.deepEqual(f.bots.at(-1).mcpServers, ['old'])
  const before = f.calls.filter((c) => c.path === '/api/config').length
  await f.service.reconcile(1234)
  assert.equal(f.calls.filter((c) => c.path === '/api/config').length, before)
})

test('post-enable race materializes new bots and rolls back enabled connector if the bot PATCH fails', async () => {
  for (const fail of [false, true]) {
    const f = fixture()
    const request = f.deps.request
    f.deps.request = async (port, path, method, body: any) => {
      if (fail && path === '/api/bots/raced' && method === 'PATCH')
        throw new Error('A bot is currently working. Retry once all bots are idle.')
      const reply = await request(port, path, method, body)
      if (path === '/api/mcp/servers/gmail' && body?.enabled === true)
        f.bots.push({ id: 'raced', name: 'Raced' })
      return reply
    }
    if (fail) {
      await assert.rejects(
        f.act(1234, { action: 'toggle', name: 'gmail', enabled: true }),
        /currently working/
      )
      assert.equal(f.servers.find((s) => s.name === 'gmail').enabled, false)
    } else {
      await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
      assert.deepEqual(f.bots.at(-1).mcpServers, ['old'])
    }
  }
})

test('default restriction failure aborts enabling and failed later reconciliation revokes managed connectors', async () => {
  const f = fixture()
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  f.bots.push({ id: 'new', name: 'New' })
  const request = f.deps.request
  f.deps.request = async (port, path, method, body) => {
    if (path === '/api/bots/new') throw new Error('private failure')
    return request(port, path, method, body)
  }
  await assert.rejects(f.service.reconcile(1234))
  assert.equal(f.servers.find((s) => s.name === 'gmail').enabled, false)
  f.deps.request = async (port, path, method, body) => {
    if (path === '/api/bot-defaults') throw new Error('private failure')
    return request(port, path, method, body)
  }
  await assert.rejects(f.act(1234, { action: 'toggle', name: 'gmail-cursor', enabled: true }))
  assert.equal(
    f.servers.some((s) => s.name === 'gmail-cursor'),
    false
  )
})

test('stale account and group tokens reject config changes before credential import', async () => {
  for (const group of [false, true]) {
    const f = fixture()
    const rows = (await f.service.list(1234)).connectors
    const selected = rows.find((c) => c.name === 'gmail')!
    const input = group
      ? {
          action: 'group' as const,
          provider: 'Cursor',
          enabled: true,
          targets: rows
            .filter((c) => c.provider === 'Cursor')
            .map(({ name, fingerprint }) => ({ name, fingerprint }))
        }
      : {
          action: 'toggle' as const,
          name: selected.name,
          fingerprint: selected.fingerprint,
          enabled: true
        }
    delete f.files['/home/Library/Application Support/Claude/claude_desktop_config.json']
    await assert.rejects(f.service.act(1234, input), /Connector list changed/)
    assert.equal(
      f.calls.some((c) => c.method === 'POST'),
      false
    )
  }
})

test('HMAC identity is stable per host, covers account/provider/raw name, and never exposes its key', async () => {
  const f = fixture(),
    other = fixture()
  const a = await f.service.list(1234),
    b = await other.service.list(1234)
  assert.deepEqual(a, await f.service.list(1234))
  assert.notEqual(a.connectors[1].fingerprint, b.connectors[1].fingerprint)
  assert.match(f.prefs.read().connectorKey!, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(a).includes(f.prefs.read().connectorKey!), false)
  f.files[
    '/home/Library/Application Support/Claude/claude_desktop_config.json'
  ].mcpServers.gmail.env.TOKEN = 'CHANGED'
  assert.notEqual(
    (await f.service.list(1234)).connectors[1].fingerprint,
    a.connectors[1].fingerprint
  )
})

test('normalization matches OpenMausBot punctuation, truncation, numeric prefixes and reserved-name rules', async () => {
  assert.equal(nameOf('gmail (work)'), 'gmail-work')
  assert.equal(nameOf('gmail--work-'), 'gmail--work')
  assert.equal(nameOf('123'), 'mcp-123')
  assert.equal(nameOf('email'), 'mcp-email')
  assert.equal(nameOf('a'.repeat(31) + ' - tail'), 'a'.repeat(31))
  assert.equal(nameOf('---'), undefined)
  const used = new Set(['mail-cursor', 'mail-cursor-2'])
  assert.equal(uniqueName('mail', 'Cursor', used), 'mail-cursor-3')
  const f = fixture()
  f.files['/home/.cursor/mcp.json'].mcpServers['gmail (work)'] = { command: 'punctuation' }
  await f.act(1234, { action: 'toggle', name: 'gmail-work', enabled: true })
  assert.ok(f.prefs.read().connectors!['gmail-work'])
})

test('unexpected import name is tracked under returned name; malformed import replies roll back the new server', async () => {
  for (const malformed of [false, true]) {
    const f = fixture()
    const request = f.deps.request
    f.deps.request = async (port, path, method, body) => {
      const reply = await request(port, path, method, body)
      if (method === 'POST') {
        if (malformed) return { added: [] }
        f.servers.at(-1).name = 'returned-name'
        return { added: ['returned-name'] }
      }
      return reply
    }
    if (malformed) {
      await assert.rejects(f.act(1234, { action: 'toggle', name: 'gmail', enabled: true }))
      assert.equal(
        f.servers.some((s) => s.name === 'gmail'),
        false
      )
    } else {
      await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
      assert.ok(f.prefs.read().connectors!['returned-name'])
      assert.equal(f.servers.find((s) => s.name === 'returned-name').enabled, true)
    }
  }
})

test('pinned servers count only their owner, are excluded from group changes and do not consume other bots limits', async () => {
  const f = fixture()
  for (let i = 0; i < 22; i++)
    f.servers.push({
      name: `pinned-${i}`,
      enabled: true,
      bot: 'not-visible',
      command: `pinned-${i}`
    })
  const rows = (await f.service.list(1234)).connectors
  assert.deepEqual(rows.find((c) => c.name === 'pinned-0')?.bots, [])
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  assert.deepEqual(f.bots[0].mcpServers, ['old'])
  await f.act(1234, { action: 'group', provider: 'OpenMausBot', enabled: false })
  assert.equal(f.servers.find((s) => s.name === 'pinned-0').enabled, true)
  await assert.rejects(f.act(1234, { action: 'assign', name: 'pinned-0', bots: ['a'] }))
})

test('assign preserves hidden and person-owned bots explicit access but off connectors reject assignment', async () => {
  const f = fixture()
  f.bots[2].mcpServers = ['old']
  f.bots.push({
    id: 'person',
    name: 'Person',
    defaultBot: { person: 'someone' },
    mcpServers: ['old']
  })
  await f.act(1234, { action: 'assign', name: 'old', bots: ['b'] })
  assert.deepEqual(
    f.bots.map((b) => b.mcpServers),
    [[], ['old'], ['old'], ['old']]
  )
  await f.act(1234, { action: 'toggle', name: 'old', enabled: false })
  await assert.rejects(f.act(1234, { action: 'assign', name: 'old', bots: ['a'] }))
})

test('an action scans local configuration only once and HTTP conflicts distinguish busy bots from import conflicts', async () => {
  const f = fixture()
  let scans = 0
  f.deps.exists = () => true
  f.deps.listCodex = async () => {
    scans++
    return []
  }
  const row = (await f.service.list(1234)).connectors.find((c) => c.name === 'gmail')!
  scans = 0
  await f.service.act(1234, {
    action: 'toggle',
    name: row.name,
    fingerprint: row.fingerprint,
    enabled: true
  })
  assert.equal(scans, 1)
  assert.match(requestFailure(409, '/api/bots/a', 'PATCH'), /currently working/)
  assert.match(requestFailure(409, '/api/mcp/servers/import', 'POST'), /conflicts/)
  assert.match(requestFailure(409, '/api/mcp/servers/mail', 'PATCH'), /conflicts/)
  assert.doesNotMatch(requestFailure(500, '/api/bots/a', 'PATCH'), /currently working/)
})

test('explicit defaults retain unrelated connectors while dropping stale grants for the newly enabled connector', async () => {
  const f = fixture()
  f.defaults().profile.mcpServers = ['old', 'gmail']
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  assert.deepEqual(f.defaults().profile.mcpServers, ['old'])
})

test('stable background polls use cached defaults with no lifecycle lock or writes', async () => {
  const f = fixture()
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  f.calls.length = 0
  let locks = 0
  const write = async (op: () => Promise<void>) => {
    locks++
    await op()
  }
  await f.service.reconcile(1234, write)
  assert.equal(locks, 0)
  assert.deepEqual(
    f.calls.map((c) => [c.method, c.path]),
    [
      ['GET', '/api/mcp/servers'],
      ['GET', '/api/bots?messages=0']
    ]
  )
  f.servers.find((s) => s.name === 'gmail').enabled = false
  f.calls.length = 0
  await f.service.reconcile(1234, write)
  assert.equal(locks, 0)
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['/api/mcp/servers']
  )
})

test('background defaults cache resets on restart/port change and read hiccups never disable healthy connectors', async () => {
  const f = fixture()
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  const request = f.deps.request
  let fail = true
  f.deps.request = async (port, path, method, body) => {
    if (fail && path === '/api/bot-defaults') throw new Error('temporary read failure')
    return request(port, path, method, body)
  }
  f.service.reset()
  f.calls.length = 0
  let locks = 0
  const write = async (op: () => Promise<void>) => {
    locks++
    await op()
  }
  await assert.rejects(f.service.reconcile(1234, write))
  assert.equal(f.servers.find((s) => s.name === 'gmail').enabled, true)
  assert.equal(locks, 0)
  assert.ok(f.calls.every((c) => c.method === 'GET'))
  fail = false
  await f.service.reconcile(1234, write)
  assert.equal(locks, 0)
  f.calls.length = 0
  await f.service.reconcile(4321, write)
  assert.ok(f.calls.some((c) => c.path === '/api/bot-defaults'))
  f.service.reset()
  delete f.defaults().profile.mcpServers
  await f.service.reconcile(4321, write)
  assert.equal(locks, 1)
  assert.deepEqual(f.defaults().profile.mcpServers, [])
})

test('background revocation requires a confirmed still-unrestricted bot after a failed PATCH', async () => {
  for (const outcome of ['confirmed', 'read-failure', 'ambiguous-success']) {
    const f = fixture()
    await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
    f.bots.push({ id: 'late', name: 'Late' })
    const request = f.deps.request
    let failed = false
    f.deps.request = async (port, path, method, body) => {
      if (path === '/api/bots/late' && method === 'PATCH') {
        if (outcome === 'ambiguous-success') await request(port, path, method, body)
        failed = true
        throw new Error('temporary response failure')
      }
      if (failed && outcome === 'read-failure' && path === '/api/bots?messages=0')
        throw new Error('temporary read failure')
      return request(port, path, method, body)
    }
    let locks = 0
    await assert.rejects(
      f.service.reconcile(1234, async (op) => {
        locks++
        await op()
      })
    )
    assert.equal(locks, 1)
    assert.equal(f.servers.find((s) => s.name === 'gmail').enabled, outcome !== 'confirmed')
  }
})

test('a newly unrestricted bot invalidates cached defaults and repairs externally reset defaults', async () => {
  const f = fixture()
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  delete f.defaults().profile.mcpServers
  f.bots.push({ id: 'late-defaults', name: 'Late defaults' })
  await f.service.reconcile(1234)
  assert.deepEqual(f.bots.at(-1).mcpServers, ['old'])
  assert.deepEqual(f.defaults().profile.mcpServers, [])
})

test('list reuses protected defaults and never disables connectors on a transient defaults read failure', async () => {
  const f = fixture()
  await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
  assert.ok(f.bots.every((b) => Array.isArray(b.mcpServers)))
  const request = f.deps.request
  let failOnce = true
  f.deps.request = async (port, path, method, body) => {
    if (path === '/api/bot-defaults' && failOnce) {
      failOnce = false
      throw new Error('transient defaults read failure')
    }
    return request(port, path, method, body)
  }
  f.calls.length = 0
  const cached = await f.service.list(1234)
  assert.equal(cached.connectors.find((c) => c.name === 'gmail')!.enabled, true)
  assert.equal(failOnce, true)
  assert.ok(f.calls.every((c) => c.method === 'GET'))
  // A restarted service must read defaults, but a failed GET is never evidence of wider bot access.
  f.service.reset()
  await assert.rejects(f.service.list(1234))
  assert.equal(failOnce, false)
  assert.equal(f.servers.find((s) => s.name === 'gmail').enabled, true)
  assert.ok(f.calls.every((c) => c.method === 'GET'))
  assert.equal(
    (await f.service.list(1234)).connectors.find((c) => c.name === 'gmail')!.enabled,
    true
  )
})

test('list only revokes managed connectors after a failed bot patch and confirmed unrestricted bot', async () => {
  for (const outcome of ['confirmed', 'read-failure', 'ambiguous-success']) {
    const f = fixture()
    await f.act(1234, { action: 'toggle', name: 'gmail', enabled: true })
    f.bots.push({ id: 'late-list', name: 'Late' })
    const request = f.deps.request
    let failed = false
    f.deps.request = async (port, path, method, body) => {
      if (path === '/api/bots/late-list' && method === 'PATCH') {
        if (outcome === 'ambiguous-success') await request(port, path, method, body)
        failed = true
        throw new Error('response failed')
      }
      if (failed && outcome === 'read-failure' && path === '/api/bots?messages=0')
        throw new Error('read failed')
      return request(port, path, method, body)
    }
    await assert.rejects(f.service.list(1234))
    assert.equal(f.servers.find((s) => s.name === 'gmail').enabled, outcome !== 'confirmed')
  }
})
