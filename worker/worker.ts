import type { OrcaWorkerApi } from 'orca/worker'
import { createHermes } from './hermes.ts'
import type { Hermes } from './hermes.ts'
import { HermesError } from './hermes-gateway.ts'
import { registerPairedHost } from './paired-host.ts'
import './protocol.ts'

/** Only wording written in this plugin reaches the panel; anything else becomes one fixed line. */
function shown(error: unknown): Error {
  if (error instanceof HermesError) return new Error(error.message)
  if (error instanceof Error && /^[A-Z][^\n]{0,200}[.!?]$/.test(error.message) && !/[/\\]|https?:|wss?:/.test(error.message)) return error
  return new Error('Hermes could not do that. Try again.')
}

/**
 * The plugin's whole job: list the Hermes bots on the bot host, show each one's Bot Chat, and send
 * to it. Models, skills, memory, schedules and channels are managed in Hermes itself.
 */
export function register(orca: OrcaWorkerApi, hermes: Hermes = createHermes()): void {
  const guard = <I, O>(run: (input: I) => Promise<O>) => async (input: I) => {
    try {
      return await run(input)
    } catch (error) {
      throw shown(error)
    }
  }
  orca.panels.handle('status', () => hermes.status())
  orca.panels.handle('bots.list', guard(() => hermes.listBots()))
  orca.panels.handle('thread.read', guard((input: { botId: string; older?: string; limit?: number }) => hermes.readThread(input ?? ({} as never))))
  orca.panels.handle('message.send', guard((input: { botId: string; text: string }) => hermes.send(input ?? ({} as never))))
}

export default function activate(orca: OrcaWorkerApi): void {
  registerPairedHost(orca, (api) => register(api))
}
