import { agents as catalog, agentKeys } from '../shared/agents.ts'
import type { Setup, SetupAnswer } from '../worker/protocol.ts'

export function agentNames(agents: Setup['agents']): string {
  const names = agentKeys.filter((key) => agents[key]).map((key) => catalog[key].label)
  return names.length > 2
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : names.join(' and ')
}

export function createSetup(send: (answer: SetupAnswer) => Promise<unknown>) {
  const state = {
    loaded: false,
    answered: false,
    agents: { claude: false, codex: false } as Setup['agents'],
    shareTools: false,
    linkAgents: false,
    busy: false,
    message: ''
  }
  return {
    state,
    load(setup: Setup) {
      if (!state.loaded) {
        state.shareTools = setup.shareTools ?? false
        state.linkAgents = setup.linkAgents ?? false
      }
      state.loaded = true
      state.answered = setup.answered
      state.agents = setup.agents
    },
    async answer(allow: boolean) {
      if (state.busy || state.answered || !state.loaded) return
      state.busy = true
      state.message = 'Setting up…'
      try {
        await send({
          shareTools: allow && state.shareTools,
          linkAgents: allow && state.linkAgents && !!agentNames(state.agents)
        })
        state.answered = true
        state.message = ''
      } catch {
        state.message = 'Could not finish setup. Please try again.'
      } finally {
        state.busy = false
      }
    }
  }
}
