import { join } from 'node:path'

export type EnvironmentDeps = {
  home: string
  platform: string
  env: NodeJS.ProcessEnv
  userInfo: () => { username: string; shell: string | null }
}

// Orca workers may lack the account variables Claude needs for keychain login.
// Share this environment across server, npm/node checks and CLI children.
export function childEnvironment(deps: EnvironmentDeps): NodeJS.ProcessEnv {
  const env = { ...deps.env }
  if (env.USER === undefined || env.LOGNAME === undefined || env.SHELL === undefined) {
    const account = deps.userInfo()
    env.USER ??= account.username
    env.LOGNAME ??= account.username
    if (env.SHELL === undefined && account.shell !== null) env.SHELL = account.shell
  }
  if (env.LANG === undefined && env.LC_ALL === undefined) env.LANG = 'en_US.UTF-8'
  const separator = deps.platform === 'win32' ? ';' : ':'
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(deps.home, '.local/bin'),
    join(deps.home, '.volta/bin')
  ]
  env.PATH = [env.PATH ?? '', ...extra].join(separator)
  return env
}
