import { join } from 'node:path'
import type { CliDeps } from './omb-cli.ts'
import { cliOptions } from './omb-cli.ts'

export function orcaBinary(deps: CliDeps): string {
  if (deps.env.ORCA_CLI_COMMAND) {
    if (deps.exists(deps.env.ORCA_CLI_COMMAND)) return deps.env.ORCA_CLI_COMMAND
    throw new Error('The configured Orca CLI is unavailable.')
  }
  if (deps.env.ORCA_DEV_REPO_ROOT) {
    for (const relative of ['config/scripts/development/launch/orca-dev.mjs', 'config/scripts/orca-dev.mjs']) {
      const file = join(deps.env.ORCA_DEV_REPO_ROOT, relative)
      if (deps.exists(file)) return file
    }
    throw new Error('Build the Orca dev CLI before opening Bot Team for Orca.')
  }
  const mac = '/Applications/Orca.app/Contents/Resources/bin/orca'
  if (deps.platform === 'darwin' && deps.exists(mac)) return mac
  for (const folder of (deps.env.PATH ?? '').split(deps.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const file = join(folder, deps.platform === 'win32' ? 'orca.exe' : 'orca')
    if (deps.exists(file)) return file
  }
  throw new Error('Orca CLI was not found.')
}

export async function callOrca(args: string[], deps: CliDeps): Promise<any> {
  const options = cliOptions(deps, 20000)
  // Always select the target explicitly, never inherit a terminal's routing.
  delete options.env.ORCA_ENVIRONMENT
  delete options.env.ORCA_PAIRING_CODE
  delete options.env.ORCA_REMOTE_PAIRING
  let output: string
  // Orca's output can contain a pairing URL, so its errors are never shown.
  try { output = await deps.execFile(orcaBinary(deps), args, options) }
  catch { throw new Error('Could not reach the selected Orca server. Check its connection in Orca.') }
  try {
    const value = JSON.parse(output)
    if (value?.ok !== true) throw new Error()
    return value.result
  } catch { throw new Error('Orca did not return a valid response.') }
}
