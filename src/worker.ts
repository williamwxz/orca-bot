import type { OrcaWorkerApi } from 'orca/worker'
import type { Status } from './protocol.ts'
import { ensureServer, stopServer, ServerError, defaultServerDeps } from './omb-server.ts'
import type { ServerResult, StopResult } from './omb-server.ts'
import { TESTED_OPENMAUSBOT_VERSION, compareVersions } from '../shared/omb-version.ts'

export type WorkerDeps = {
  ensureServer: () => Promise<ServerResult>
  stopServer: () => Promise<StopResult>
}

function defaults(): WorkerDeps {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('Tests must inject worker dependencies')
  const deps = defaultServerDeps()
  return { ensureServer: () => ensureServer(deps), stopServer: () => stopServer(deps) }
}

export function versionMessage(version: string): string {
  const tested = TESTED_OPENMAUSBOT_VERSION
  const comparison = compareVersions(version, tested)
  if (comparison > 0) return `OpenMausBot ${version} is newer than the version Bot Deck was tested with (${tested}). It should work; tell us if something looks wrong.`
  if (comparison < 0) return `OpenMausBot ${version} is older than Bot Deck expects (${tested}). Update OpenMausBot.`
  return 'OpenMausBot is ready.'
}

export function register(orca: OrcaWorkerApi, deps: WorkerDeps = defaults()): void {
  let status: Status | undefined
  let pending: Promise<void> | undefined
  let stopped = false
  orca.panels.handle('status', (input: { retry?: boolean } = {}): Status => {
    if (input.retry && !pending) {
      status = undefined
      stopped = false
    }
    if (!status && !pending && !stopped) {
      status = { state: 'starting', message: 'Starting OpenMausBot… The first start downloads about 75 MB and can take a minute.', testedVersion: TESTED_OPENMAUSBOT_VERSION }
      pending = Promise.resolve().then(() => deps.ensureServer()).then((server) => {
        status = { state: 'running', message: versionMessage(server.version), port: server.port, version: server.version, testedVersion: TESTED_OPENMAUSBOT_VERSION }
      }).catch((error: unknown) => {
        status = {
          state: error instanceof ServerError ? error.state : 'start_failed',
          message: error instanceof ServerError ? error.message : 'Could not start OpenMausBot. Press Retry to try again.',
          testedVersion: TESTED_OPENMAUSBOT_VERSION
        }
      }).finally(() => { pending = undefined })
    }
    return status!
  })
  const stop = async (): Promise<StopResult> => {
    // Wait for our own startup so a stop command cannot leave it running afterwards.
    await pending
    const result = await deps.stopServer()
    if (result.stopped) {
      stopped = true
      status = { state: 'start_failed', message: 'OpenMausBot was stopped. Press Retry to start it again.', testedVersion: TESTED_OPENMAUSBOT_VERSION }
    }
    return result
  }
  orca.panels.handle('server.stop', stop)
  orca.commands.register('botdeck.stopServer', stop)
}

export default function activate(orca: OrcaWorkerApi): void {
  register(orca)
}
