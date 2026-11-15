import type { OrcaWorkerApi } from 'orca/worker'
import type { Status } from './protocol.ts'

export type WorkerDeps = Record<string, never>

// Future server/process dependencies belong in deps. Code run under the Node test
// runner must be given fakes; tests must never use real process or account defaults.
export function register(orca: OrcaWorkerApi, _deps: WorkerDeps = {}): void {
  orca.panels.handle('status', (): Status => ({
    ok: false,
    message: 'OpenMausBot support is not built yet.'
  }))
}

export default function activate(orca: OrcaWorkerApi): void {
  register(orca)
}
