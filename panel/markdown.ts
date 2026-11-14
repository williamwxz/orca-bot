// A small Markdown-to-DOM renderer for bot messages. It builds nodes directly and never sets
// innerHTML, so message text cannot inject markup.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>)]+)/g

function inline(parent: HTMLElement, text: string): void {
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) parent.append(text.slice(last, index))
    const token = match[0]
    if (match[1]) {
      const code = document.createElement('code')
      code.textContent = token.slice(1, -1)
      parent.append(code)
    } else if (match[2]) {
      const strong = document.createElement('strong')
      strong.textContent = token.slice(2, -2)
      parent.append(strong)
    } else {
      const split = match[3] ? token.indexOf('](') : -1
      const href = match[3] ? token.slice(split + 2, -1) : token.replace(/[.,;:!?]+$/, '')
      const link = document.createElement('a')
      link.href = href
      link.dataset.external = href
      link.textContent = match[3] ? token.slice(1, split) : href
      parent.append(link)
      if (!match[3] && href.length < token.length) parent.append(token.slice(href.length))
    }
    last = index + token.length
  }
  if (last < text.length) parent.append(text.slice(last))
}

export function renderMarkdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let list: HTMLElement | null = null
  let paragraph: string[] = []

  const flush = () => {
    if (!paragraph.length) return
    const p = document.createElement('p')
    paragraph.forEach((line, index) => {
      if (index) p.append(document.createElement('br'))
      inline(p, line)
    })
    out.append(p)
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      flush()
      list = null
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith('```'); i++) body.push(lines[i])
      const pre = document.createElement('pre')
      pre.textContent = body.join('\n')
      out.append(pre)
      continue
    }

    const bullet = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      const tag = bullet[1] ? 'OL' : 'UL'
      if (!list || list.tagName !== tag) {
        list = document.createElement(tag.toLowerCase())
        out.append(list)
      }
      const item = document.createElement('li')
      inline(item, bullet[2])
      list.append(item)
      continue
    }

    list = null
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const h = document.createElement('h4')
      inline(h, heading[2])
      out.append(h)
    } else if (!line.trim()) {
      flush()
    } else {
      paragraph.push(line)
    }
  }
  flush()
  return out
}
