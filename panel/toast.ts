export function createToast(root: HTMLElement, options: {
  durationMs?: number
  setTimer?: (callback: () => void, ms: number) => number
  clearTimer?: (timer: number) => void
} = {}) {
  const text = document.createElement('span')
  const close = document.createElement('button')
  close.type = 'button'
  close.title = 'Dismiss'
  close.setAttribute('aria-label', 'Dismiss notification')
  close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>'
  root.replaceChildren(text, close)
  let timer: number | undefined
  function hide() {
    if (timer !== undefined) (options.clearTimer ?? clearTimeout)(timer)
    timer = undefined
    root.hidden = true
    text.textContent = ''
  }
  close.addEventListener('click', hide)
  return { hide, show(message: string) {
    if (!message) return
    hide()
    root.hidden = false
    text.textContent = message
    timer = (options.setTimer ?? ((cb, ms) => window.setTimeout(cb, ms)))(hide, options.durationMs ?? 3000)
  } }
}
