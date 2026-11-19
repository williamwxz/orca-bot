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
export type ImportDeps = EnvironmentDeps & {
  read: (path: string) => string
  exists: (path: string) => boolean
  /** Folder names in a directory; used to find Claude's synced plugins. */
  list?: (dir: string) => string[]
  claudeEnv: () => NodeJS.ProcessEnv
  listCodex: (file: string, env: NodeJS.ProcessEnv) => Promise<unknown>
  owned: (port: number) => Promise<boolean>
  request: (
    port: number,
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: object
  ) => Promise<unknown>
}
type Definition =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> }
export type Candidate = Tool & { rawName: string; definition: Definition }
const validName = /^[a-z][a-z0-9_-]{0,31}$/
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is Record<string, string> =>
  object(v) && Object.values(v).every((x) => typeof x === 'string')
export function nameOf(raw: string): string | undefined {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  const name = /^[a-z]/.test(slug)
    ? slug
    : slug
      ? `mcp-${slug}`.slice(0, 32).replace(/-+$/, '')
      : ''
  return name ? (reservedNames.has(name) ? `mcp-${name}`.slice(0, 32) : name) : undefined
}
export function definition(raw: unknown): Definition | undefined {
  if (!object(raw) || raw.enabled === false || raw.disabled === true) return
  if (typeof raw.command === 'string' && raw.command && raw.url === undefined) {
    const args = raw.args ?? []
    if (
      !Array.isArray(args) ||
      !args.every((x) => typeof x === 'string') ||
      (raw.env != null && !strings(raw.env))
    )
      return
    if (/^openmausbot(?:\.cmd|\.exe)?$/.test(basename(raw.command)) && args.includes('mcp')) return
    if (raw.cwd) return // OpenMausBot's paste format cannot preserve a working directory.
    return { command: raw.command, args, ...(raw.env ? { env: raw.env } : {}) }
  }
  if (typeof raw.url === 'string' && raw.command === undefined) {
    try {
      if (!['http:', 'https:'].includes(new URL(raw.url).protocol)) return
    } catch {
      return
    }
    if (raw.headers != null && !strings(raw.headers)) return
    return { url: raw.url, ...(raw.headers ? { headers: raw.headers } : {}) }
  }
}
export const identity = (d: Definition) =>
  'url' in d ? JSON.stringify(d.url) : JSON.stringify([d.command, d.args])
export const canonical = (v: any): string =>
  JSON.stringify(v, (_, x) =>
    object(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]])
        )
      : x
  )
export const reservedNames = new Set([
  'ogb',
  'computer',
  'agents',
  'composio',
  'data',
  'browser',
  'email',
  'device',
  'phone',
  'dweb',
  'openmausbot_connectors',
  'openmausbot_phone'
])
export function uniqueName(base: string, provider: string, taken: Set<string>): string {
  const suffix = '-' + (nameOf(provider) ?? 'connector')
  const stem = nameOf(base.slice(0, 32 - suffix.length) + suffix)!
  let name = stem
  for (let n = 2; taken.has(name) || reservedNames.has(name); n++) {
    const end = `-${n}`
    name = nameOf(stem.slice(0, 32 - end.length) + end)!
  }
  return name
}
export function defaultImportDeps(): ImportDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject tool import dependencies')
  const cli = defaultCliDeps(),
    server = defaultServerDeps()
  return {
    ...cli,
    read: (path) => fs.readFileSync(path, 'utf8'),
    list: (dir) => fs.readdirSync(dir),
    claudeEnv: () => claudeEnvironment(server, false).env,
    owned: (port) => isPluginServer(port, server),
    listCodex: (file, env) =>
      new Promise((resolve, reject) => {
        execFile(
          file,
          ['mcp', 'list', '--json'],
          { env, timeout: 10000, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            try {
              if (error) throw error
              resolve(JSON.parse(stdout))
            } catch {
              reject(new Error('Could not read tools.'))
            }
          }
        )
      }),
    request: async (port, path, method, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      })
      if (!response.ok) throw new Error(requestFailure(response.status, path, method))
      if (response.status === 204) return {}
      return response.json()
    }
  }
}
/** Plugin folders whose MCP servers Claude Code loads: synced (account) plugins and enabled installed ones. */
function claudePluginDirs(deps: ImportDeps, configDir: string): string[] {
  const dirs: string[] = []
  const synced = join(configDir, 'plugins/synced')
  try {
    for (const org of deps.list?.(synced) ?? []) {
      try {
        const manifest = JSON.parse(deps.read(join(synced, org, 'manifest.json')))
        const folders = new Set(deps.list?.(join(synced, org)) ?? [])
        for (const plugin of Array.isArray(manifest?.plugins) ? manifest.plugins : []) {
          if (!object(plugin) || typeof plugin.name !== 'string' || /[\\/]|^\.\.?$/.test(plugin.name)) continue
          // The manifest's generation names the live folder; older generations linger until cleanup.
          const live = `${plugin.name}~g${plugin.generation}`
          const folder = folders.has(live) ? live : plugin.name
          if (folders.has(folder)) dirs.push(join(synced, org, folder))
        }
      } catch {}
    }
  } catch {}
  try {
    const enabled = JSON.parse(deps.read(join(configDir, 'settings.json')))?.enabledPlugins
    const installed = JSON.parse(deps.read(join(configDir, 'plugins/installed_plugins.json')))?.plugins
    if (object(enabled) && object(installed))
      for (const [key, entries] of Object.entries(installed))
        if (enabled[key] === true && Array.isArray(entries))
          for (const entry of entries)
            if (object(entry) && typeof entry.installPath === 'string') dirs.push(entry.installPath)
  } catch {}
  return dirs
}
function pluginServers(deps: ImportDeps, dir: string): Record<string, unknown> | undefined {
  let source: unknown
  try {
    source = JSON.parse(deps.read(join(dir, '.claude-plugin/plugin.json')))?.mcpServers
  } catch {}
  if (typeof source === 'string') {
    const path = join(dir, source)
    if (!path.startsWith(dir + '/')) return
    try {
      source = JSON.parse(deps.read(path))
    } catch {
      return
    }
  } else if (source === undefined) {
    try {
      source = JSON.parse(deps.read(join(dir, '.mcp.json')))
    } catch {
      return
    }
  }
  if (!object(source)) return
  return object(source.mcpServers) ? source.mcpServers : source
}

export async function candidates(deps: ImportDeps): Promise<Candidate[]> {
  const found: Candidate[] = [],
    names = new Set<string>(),
    definitions = new Set<string>()
  const add = (rawName: unknown, raw: unknown, source: string) => {
    if (typeof rawName !== 'string') return
    let name = nameOf(rawName)
    const d = definition(raw)
    if (!name || name === MCP_ENTRY_NAME || !d) return
    const key = canonical(d)
    if (definitions.has(key)) return
    definitions.add(key)
    const provider = source.startsWith('Claude Code') ? 'Claude Code' : source
    if (names.has(name) || reservedNames.has(name)) name = uniqueName(name, provider, names)
    names.add(name)
    found.push({ name, source, rawName, definition: d })
  }
  const files: [string, string][] = []
  try {
    const home = deps.claudeEnv().CLAUDE_CONFIG_DIR
    if (home) files.push([join(home, '.claude.json'), 'Claude Code (Orca)'])
  } catch {}
  files.push([join(deps.home, '.claude.json'), 'Claude Code (system)'])
  if (deps.platform === 'darwin')
    files.push([
      join(deps.home, 'Library/Application Support/Claude/claude_desktop_config.json'),
      'Claude Desktop'
    ])
  files.push(
    [join(deps.home, '.cursor/mcp.json'), 'Cursor'],
    [join(deps.home, '.gemini/settings.json'), 'Gemini CLI']
  )
  for (const [file, source] of files) {
    try {
      const raw = JSON.parse(deps.read(file))
      if (object(raw?.mcpServers))
        for (const [name, d] of Object.entries(raw.mcpServers)) add(name, d, source)
    } catch {}
  }
  const configDirs: string[] = []
  try {
    const home = deps.claudeEnv().CLAUDE_CONFIG_DIR
    if (home) configDirs.push(home)
  } catch {}
  configDirs.push(join(deps.home, '.claude'))
  const pluginDirs = new Set<string>()
  for (const configDir of configDirs)
    for (const dir of claudePluginDirs(deps, configDir)) {
      if (pluginDirs.has(dir)) continue
      pluginDirs.add(dir)
      const servers = pluginServers(deps, dir)
      if (servers)
        for (const [name, entry] of Object.entries(servers))
          // ${CLAUDE_PLUGIN_ROOT} and ${ENV} values only resolve inside Claude Code.
          if (!JSON.stringify(entry).includes('${')) add(name, entry, 'Claude plugins')
    }
  try {
    const env = childEnvironment(deps)
    const file = (env.PATH ?? '')
      .split(deps.platform === 'win32' ? ';' : ':')
      .filter(Boolean)
      .map((p) => join(p, 'codex'))
      .find(deps.exists)
    const entries = file ? await deps.listCodex(file, env) : []
    if (Array.isArray(entries))
      for (const entry of entries) {
        if (!object(entry) || entry.enabled === false || !object(entry.transport)) continue
        const t = entry.transport
        if (t.type === 'stdio') {
          if (t.env_vars?.length || t.cwd) continue
          add(entry.name, t, 'Codex')
        } else if (t.type === 'streamable_http') {
          // Environment/header helpers and OAuth credentials cannot be copied faithfully.
          if (
            t.bearer_token_env_var ||
            t.http_headers_helper ||
            (object(t.env_http_headers) && Object.keys(t.env_http_headers).length)
          )
            continue
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
        if (
          !object(entry) ||
          entry.enabled === false ||
          entry.disabled === true ||
          entry.cwd ||
          /\{(?:env|file):|\$\{[^}]+\}/.test(JSON.stringify(entry))
        )
          continue
        if (spec.format === 'standard') add(name, entry, spec.label)
        else if (
          entry.type === 'local' &&
          Array.isArray(entry.command) &&
          entry.command.length &&
          entry.command.every((v: unknown) => typeof v === 'string')
        ) {
          add(
            name,
            { command: entry.command[0], args: entry.command.slice(1), env: entry.environment },
            spec.label
          )
        } else if (entry.type === 'remote')
          add(name, { url: entry.url, headers: entry.headers }, spec.label)
      }
    } catch {}
  }
  return found
}
export function requestFailure(status: number, path: string, method: string): string {
  if (status === 409)
    return method === 'PATCH' && path.startsWith('/api/bots/')
      ? 'A bot is currently working. Retry once all bots are idle.'
      : 'The connector conflicts with the current server configuration. Refresh and try again.'
  return 'Could not update MCP connectors. Refresh and retry.'
}
