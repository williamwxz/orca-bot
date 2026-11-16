// Agent differences live here; discovery, linking and import use this table.
export const MCP_ENTRY_NAME = 'orca-bot'
export const agents = {
  claude: {
    label: 'Claude',
    program: 'claude',
    environment: 'claude',
    check: 'none',
    add: (port: number, bin: string) => [
      'mcp',
      'add',
      '--scope',
      'user',
      MCP_ENTRY_NAME,
      '-e',
      `OMB_PORT=${port}`,
      '--',
      bin,
      'mcp'
    ],
    remove: ['mcp', 'remove', '--scope', 'user', MCP_ENTRY_NAME]
  },
  codex: {
    label: 'Codex',
    program: 'codex',
    environment: 'child',
    check: 'codex',
    add: (port: number, bin: string) => [
      'mcp',
      'add',
      MCP_ENTRY_NAME,
      '--env',
      `OMB_PORT=${port}`,
      '--',
      bin,
      'mcp'
    ],
    remove: ['mcp', 'remove', MCP_ENTRY_NAME]
  },
  opencode: {
    label: 'opencode',
    program: 'opencode',
    environment: 'child',
    check: 'config',
    add: (port: number, bin: string) => [
      'mcp',
      'add',
      '--global',
      '--env',
      `OMB_PORT=${port}`,
      MCP_ENTRY_NAME,
      '--',
      bin,
      'mcp'
    ],
    remove: null,
    config: '.config/opencode/opencode.json',
    format: 'opencode'
  },
  antigravity: {
    label: 'Antigravity',
    program: 'agy',
    environment: 'child',
    check: 'list',
    add: (port: number, bin: string) => ['mcp', 'add', '-e', `OMB_PORT=${port}`, MCP_ENTRY_NAME, bin, 'mcp'],
    remove: ['mcp', 'remove', MCP_ENTRY_NAME],
    config: '.gemini/config/mcp_config.json',
    format: 'standard'
  }
} as const
export type Agent = keyof typeof agents
export type FoundAgents = Partial<Record<Agent, boolean>>
export const agentKeys = Object.keys(agents) as Agent[]
export function linkError(message: string): boolean {
  return (
    agentKeys.some((key) => message === `Could not add Bot Team for Orca to ${agents[key].label}.`) ||
    message === `Remove ${MCP_ENTRY_NAME} from opencode by hand.`
  )
}
