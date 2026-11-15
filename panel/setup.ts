import type { Tool, ImportResult } from '../worker/import-tools.ts'
import type { Setup, SetupAnswer } from '../worker/protocol.ts'

export function agentNames(agents: Setup['agents']): string {
  return [agents.claude ? 'Claude' : '', agents.codex ? 'Codex' : ''].filter(Boolean).join(' and ')
}

export function createSetup(send: (answer: SetupAnswer) => Promise<unknown>, bringTools?: () => Promise<ImportResult>) {
  const state = { toolsLoaded: false, tools: [] as Tool[], importTools: true, loaded: false, answered: false, agents: { claude: false, codex: false }, shareTools: true, linkAgents: true, busy: false, message: '' }
  return {
    state,
    loadTools(tools: Tool[]) { state.tools = tools; state.toolsLoaded = true },
    load(setup: Setup) { state.loaded = true; state.answered = setup.answered; state.agents = setup.agents },
    async answer(allow: boolean) {
      if (state.busy || state.answered || !state.loaded) return
      state.busy = true
      state.message = 'Setting up…'
      try {
        await send({ shareTools: allow && state.shareTools, linkAgents: allow && state.linkAgents && !!agentNames(state.agents) })
        state.answered = true
        state.message = ''
        if (allow && state.importTools && state.tools.length && bringTools) {
          try {
            const result = await bringTools()
            if (result.skipped.some(s => s.reason === 'failed')) state.message = 'Some tools could not be imported or switched off; check the Bot Dashboard.'
          } catch { state.message = 'Tools could not be imported or switched off; check the Bot Dashboard.' }
        }
      } catch { state.message = 'Could not finish setup. Please try again.' }
      finally { state.busy = false }
    }
  }
}
