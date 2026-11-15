import type { Requests } from '../src/protocol.ts'

type FrameApi = {
  plugin: {
    request(name: 'status', input: Requests['status']['input']): Promise<Requests['status']['output']>
  }
}
const frame = (globalThis as unknown as { orca: FrameApi }).orca
const message = document.getElementById('message') as HTMLParagraphElement
const retry = document.getElementById('retry') as HTMLButtonElement

async function refresh(): Promise<void> {
  retry.disabled = true
  try {
    const status = await frame.plugin.request('status', {})
    message.textContent = status.message
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Could not read status. Please retry.'
  } finally {
    retry.disabled = false
  }
}

retry.addEventListener('click', () => void refresh())
void refresh()
