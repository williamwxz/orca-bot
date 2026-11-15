import type { Requests } from '../src/protocol.ts'

type FrameApi = {
  plugin: {
    request(name: 'status', input: Requests['status']['input']): Promise<Requests['status']['output']>
  }
}
const frame = (globalThis as unknown as { orca: FrameApi }).orca
const message = document.getElementById('message') as HTMLParagraphElement
const retry = document.getElementById('retry') as HTMLButtonElement
let timer: ReturnType<typeof setTimeout> | undefined

async function refresh(explicitRetry = false): Promise<void> {
  clearTimeout(timer)
  retry.disabled = true
  try {
    const status = await frame.plugin.request('status', { retry: explicitRetry })
    message.textContent = status.state === 'running'
      ? `Running OpenMausBot ${status.version} on port ${status.port}. ${status.message}`
      : status.message
    retry.hidden = status.state === 'running' || status.state === 'starting'
    if (status.state === 'starting') timer = setTimeout(() => void refresh(), 2000)
  } catch {
    message.textContent = 'Could not read status. Please retry.'
    retry.hidden = false
  } finally {
    retry.disabled = false
  }
}

retry.addEventListener('click', () => void refresh(true))
window.addEventListener('pagehide', () => clearTimeout(timer))
void refresh()
