import { agents, agentKeys, MCP_ENTRY_NAME } from '../shared/agents.ts'
import { opencodeEntries } from './agent-config.ts'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { join, basename } from 'node:path'
import { childEnvironment } from './child-environment.ts'
import type { EnvironmentDeps } from './child-environment.ts'
import { defaultCliDeps } from './omb-cli.ts'
import { claudeEnvironment, defaultServerDeps, isPluginServer } from './omb-server.ts'

export type Tool = { name: string; source: string }
export type ImportResult = { added: string[]; skipped: { name: string; reason: 'already here' | 'failed' }[] }
export type ImportDeps = EnvironmentDeps & {
  read: (path: string) => string
  exists: (path: string) => boolean
  claudeEnv: () => NodeJS.ProcessEnv
  listCodex: (file: string, env: NodeJS.ProcessEnv) => Promise<unknown>
  owned: (port: number) => Promise<boolean>
  request: (port: number, path: string, method: 'GET' | 'POST' | 'PATCH', body?: object) => Promise<unknown>
}
type Definition = { command: string; args: string[]; env?: Record<string, string> } | { url: string; headers?: Record<string, string> }
type Candidate = Tool & { definition: Definition }
const validName = /^[a-z][a-z0-9_-]{0,31}$/
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is Record<string, string> => object(v) && Object.values(v).every(x => typeof x === 'string')
function nameOf(raw: string): string | undefined {
  const name = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 32)
  return validName.test(name) ? name : undefined
}
function definition(raw: unknown): Definition | undefined {
  if (!object(raw) || raw.enabled === false || raw.disabled === true) return
  if (typeof raw.command === 'string' && raw.command && raw.url === undefined) {
    const args = raw.args ?? []
    if (!Array.isArray(args) || !args.every(x => typeof x === 'string') || (raw.env != null && !strings(raw.env))) return
    if (/^openmausbot(?:\.cmd|\.exe)?$/.test(basename(raw.command)) && args.includes('mcp')) return
    if (raw.cwd) return // OpenMausBot's paste format cannot preserve a working directory.
    return { command: raw.command, args, ...(raw.env ? { env: raw.env } : {}) }
  }
  if (typeof raw.url === 'string' && raw.command === undefined) {
    try { if (!['http:', 'https:'].includes(new URL(raw.url).protocol)) return } catch { return }
    if (raw.headers != null && !strings(raw.headers)) return
    return { url: raw.url, ...(raw.headers ? { headers: raw.headers } : {}) }
  }
}
const identity = (d: Definition) => 'url' in d ? JSON.stringify(d.url) : JSON.stringify([d.command, d.args])
const canonical = (v: any): string => JSON.stringify(v, (_, x) => object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x)
export function defaultImportDeps(): ImportDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject tool import dependencies')
  const cli = defaultCliDeps(), server = defaultServerDeps()
  return {
    ...cli, read: path => fs.readFileSync(path, 'utf8'),
    claudeEnv: () => claudeEnvironment(server, false).env,
    owned: port => isPluginServer(port, server),
    listCodex: (file, env) => new Promise((resolve, reject) => {
      execFile(file, ['mcp', 'list', '--json'], { env, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        try { if (error) throw error; resolve(JSON.parse(stdout)) } catch { reject(new Error('Could not read tools.')) }
      })
    }),
    request: async (port, path, method, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      if (!response.ok) throw new Error('Could not import tools.')
      return response.json()
    }
  }
}
async function candidates(deps: ImportDeps): Promise<Candidate[]> {
  const found: Candidate[] = [], names = new Set<string>(), definitions = new Set<string>()
  const add = (rawName: unknown, raw: unknown, source: string) => {
    if (typeof rawName !== 'string') return
    const name = nameOf(rawName), d = definition(raw)
    if (!name || name === MCP_ENTRY_NAME || !d || names.has(name)) return
    names.add(name)
    const key = canonical(d)
    if (definitions.has(key)) return
    definitions.add(key); found.push({ name, source, definition: d })
  }
  const files: [string, string][] = []
  try { const home = deps.claudeEnv().CLAUDE_CONFIG_DIR; if (home) files.push([join(home, '.claude.json'), 'Claude Code (Orca)']) } catch {}
  files.push([join(deps.home, '.claude.json'), 'Claude Code (system)'])
  if (deps.platform === 'darwin') files.push([join(deps.home, 'Library/Application Support/Claude/claude_desktop_config.json'), 'Claude Desktop'])
  files.push([join(deps.home, '.cursor/mcp.json'), 'Cursor'], [join(deps.home, '.gemini/settings.json'), 'Gemini CLI'])
  for (const [file, source] of files) {
    try { const raw = JSON.parse(deps.read(file)); if (object(raw?.mcpServers)) for (const [name, d] of Object.entries(raw.mcpServers)) add(name, d, source) } catch {}
  }
  try {
    const env = childEnvironment(deps)
    const file = (env.PATH ?? '').split(deps.platform === 'win32' ? ';' : ':').filter(Boolean).map(p => join(p, 'codex')).find(deps.exists)
    const entries = file ? await deps.listCodex(file, env) : []
    if (Array.isArray(entries)) for (const entry of entries) {
      if (!object(entry) || entry.enabled === false || !object(entry.transport)) continue
      const t = entry.transport
      if (t.type === 'stdio') {
        if (t.env_vars?.length || t.cwd) continue
        add(entry.name, t, 'Codex')
      } else if (t.type === 'streamable_http') {
        // Environment/header helpers and OAuth credentials cannot be copied faithfully.
        if (t.bearer_token_env_var || t.http_headers_helper || (object(t.env_http_headers) && Object.keys(t.env_http_headers).length)) continue
        add(entry.name, { url: t.url, headers: t.http_headers ?? {} }, 'Codex')
      }
    }
  } catch {}
  for (const key of agentKeys) {
    const spec = agents[key]
    if (!('config' in spec)) continue
    try {
      const raw = JSON.parse(deps.read(join(deps.home, spec.config)))
      const entries = spec.format === 'opencode' ? opencodeEntries(raw) : raw?.mcpServers
      if (!object(entries)) continue
      for (const [name, entry] of Object.entries(entries)) {
        if (!object(entry) || entry.enabled === false || entry.disabled === true || entry.cwd || /\{(?:env|file):|\$\{[^}]+\}/.test(JSON.stringify(entry))) continue
        if (spec.format === 'standard') add(name, entry, spec.label)
        else if (entry.type === 'local' && Array.isArray(entry.command) && entry.command.length && entry.command.every((v: unknown) => typeof v === 'string')) {
          add(name, { command: entry.command[0], args: entry.command.slice(1), env: entry.environment }, spec.label)
        } else if (entry.type === 'remote') add(name, { url: entry.url, headers: entry.headers }, spec.label)
      }
    } catch {}
  }
  return found
}
export async function findTools(deps: ImportDeps = defaultImportDeps()): Promise<Tool[]> {
  return (await candidates(deps)).map(({ name, source }) => ({ name, source }))
}
export async function importTools(port: number, deps: ImportDeps = defaultImportDeps()): Promise<ImportResult> {
  try {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !await deps.owned(port)) throw new Error()
  } catch { throw new Error('Tools can only be imported into a server Orca Bot started.') }
  let existing: any[]
  try {
    const response = await deps.request(port, '/api/mcp/servers', 'GET')
    if (!object(response) || !Array.isArray(response.servers)) throw new Error()
    existing = response.servers
  } catch { throw new Error('Could not check existing tools.') }
  const result: ImportResult = { added: [], skipped: [] }
  const keys = new Set(existing.flatMap(e => { const d = definition({ ...e, enabled: true }); return d ? [identity(d)] : [] }))
  const taken = new Set(existing.map(e => e?.name))
  for (const candidate of await candidates(deps)) {
    let { name } = candidate
    const key = identity(candidate.definition)
    if (keys.has(key)) { result.skipped.push({ name, reason: 'already here' }); continue }
    for (let i = 2; taken.has(name); i++) name = `${candidate.name.slice(0, 32 - String(i).length - 1)}-${i}`
    try {
      const response = await deps.request(port, '/api/mcp/servers/import', 'POST', { json: JSON.stringify({ mcpServers: { [name]: candidate.definition } }) })
      if (!object(response) || !Array.isArray(response.added) || response.added.length !== 1 || typeof response.added[0] !== 'string' || !validName.test(response.added[0]) || taken.has(response.added[0])) throw new Error()
      name = response.added[0]
      taken.add(name); keys.add(key)
      await deps.request(port, `/api/mcp/servers/${name}`, 'PATCH', { enabled: false })
      result.added.push(name)
    } catch { result.skipped.push({ name, reason: 'failed' }) }
  }
  return result
}
export function importMessage(result: ImportResult): string {
  const failed = result.skipped.filter(s => s.reason === 'failed').length
  return (result.added.length ? `Brought in ${result.added.length} ${result.added.length === 1 ? 'tool' : 'tools'}, switched off. Turn them on per bot in the Bot Dashboard.` : 'Nothing new to bring in.') +
    (failed ? ` ${failed} ${failed === 1 ? 'tool' : 'tools'} failed to import or switch off; check them in the Bot Dashboard.` : '')
}
