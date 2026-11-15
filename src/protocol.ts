export type Status = {
  state: 'running' | 'starting' | 'needs_node' | 'install_failed' | 'start_failed'
  message: string
  port?: number
  version?: string
  testedVersion: string
}

export type Requests = {
  status: { input: { retry?: boolean }; output: Status }
  'server.stop': { input: Record<string, never>; output: { stopped: boolean; message: string } }
}
