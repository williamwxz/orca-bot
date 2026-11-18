import { detectConnectorIcon, type ConnectorIcon } from '../shared/connector-icons.ts'
import type { Connector } from '../worker/mcp-connectors.ts'

// Hand-drawn geometric connector marks, bundled as static inline SVGs.
const ICONS: Record<ConnectorIcon, string> = {
  linear:
    '<svg viewBox="0 0 24 24"><path fill="#817af7" d="M2 11a10 10 0 1 1 11 11zM2 14l8 8a10 10 0 0 1-8-8z"/></svg>',
  github:
    '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 9 4 3l5 3q3-1 6 0l5-3v6q2 3 0 6-2 3-6 3l1 4H9l1-4q-4 0-6-3-2-3 0-6z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M10 20q-4 1-6-3"/></svg>',
  gitlab:
    '<svg viewBox="0 0 24 24"><path fill="#f18530" d="M2 12l3-10 4 8h6l4-8 3 10-10 10z"/><path fill="#df4629" d="M8 10h8l-4 12z"/></svg>',
  notion:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M3 4l14-2 4 3v15L7 22l-4-4zM3 4l4 3 14-2M7 7v15"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M10 18V10l7 8V9"/></svg>',
  atlassian:
    '<svg viewBox="0 0 24 24"><path fill="#3388fc" d="M2 21l6-13 6 13z"/><path fill="#1750ac" d="M10 5l2-4 11 20h-7z"/></svg>',
  stripe:
    '<svg viewBox="0 0 24 24"><path fill="#7364ec" d="M18 4v5q-7-4-8-1-1 1 4 3 7 2 4 8-3 5-13 2v-5q7 4 9 1 1-1-4-3-7-2-5-7 3-6 13-3z"/></svg>',
  sentry:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M3 20h5q0-5-4-7l2-3q7 4 7 10h4q0-9-9-14l3-4 11 18h-2"/></svg>',
  cloudflare:
    '<svg viewBox="0 0 24 24"><path fill="#f28b24" d="M2 17q0-5 5-5 0-8 7-7 6 1 6 8h-5l-2 4z"/><path fill="#f9b549" d="M15 17l2-3q5-3 6 3z"/></svg>',
  supabase:
    '<svg viewBox="0 0 24 24"><path fill="#32be80" d="M13 1 2 14h10z"/><path fill="#299e74" d="M12 10h10L11 23z"/></svg>',
  'google-docs':
    '<svg viewBox="0 0 24 24"><path fill="#4584ee" d="M4 2h11l5 5v15H4z"/><path fill="#ffffff80" d="M14 2v6h6z"/><path fill="none" stroke="white" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M8 12h8m-8 3h8m-8 3h5"/></svg>',
  'google-sheets':
    '<svg viewBox="0 0 24 24"><path fill="#168754" d="M4 2h11l5 5v15H4z"/><path fill="#ffffff80" d="M14 2v6h6z"/><path fill="none" stroke="white" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" d="M7 11h10v7H7zM7 14.5h10M12 11v7"/></svg>',
  'google-drive':
    '<svg viewBox="0 0 24 24"><path fill="#0f9d58" d="M8 2h7L7 17H1z"/><path fill="#fbbc04" d="M8 2h8l8 14h-8z"/><path fill="#4285f4" d="M5 22l-4-6h23l-4 6z"/></svg>',
  gmail:
    '<svg viewBox="0 0 24 24"><path fill="#4285f4" d="M1 5h4v15H1z"/><path fill="#34a853" d="M19 5h4v15h-4z"/><path fill="#ea4335" d="M1 4h3l8 6 8-6h3v5l-11 8L1 9z"/></svg>',
  'google-calendar':
    '<svg viewBox="0 0 24 24"><path fill="#4285f4" d="M2 2h20v5H7v15H2z"/><path fill="#fbbc04" d="M17 7h5v10l-5 5z"/><path fill="#34a853" d="M7 17h15l-5 5H7z"/><path fill="#4285f4" d="M8 8h4v7H8v-1h3v-2H9v-1h2V9H8zm6 1 2-1v7h-1v-5l-1 1z"/></svg>',
  microsoft:
    '<svg viewBox="0 0 24 24"><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M13 1h10v10H13z"/><path fill="#05a6f0" d="M1 13h10v10H1z"/><path fill="#ffba08" d="M13 13h10v10H13z"/></svg>',
  figma:
    '<svg viewBox="0 0 24 24"><path fill="#f24e1e" d="M12 0v8H8a4 4 0 010-8z"/><path fill="#ff7262" d="M12 0h4a4 4 0 010 8h-4z"/><path fill="#a259ff" d="M12 8v8H8a4 4 0 010-8z"/><path fill="#1abcfe" d="M16 8a4 4 0 100 8 4 4 0 000-8z"/><path fill="#0acf83" d="M12 16v4a4 4 0 11-4-4z"/></svg>',
  slack:
    '<svg viewBox="0 0 24 24"><g fill="#36c5f0" transform="rotate(0 12 12)"><rect x="2" y="7" width="9" height="4" rx="2"/><rect x="7" y="2" width="4" height="4" rx="2"/></g><g fill="#2eb67d" transform="rotate(90 12 12)"><rect x="2" y="7" width="9" height="4" rx="2"/><rect x="7" y="2" width="4" height="4" rx="2"/></g><g fill="#ecb22e" transform="rotate(180 12 12)"><rect x="2" y="7" width="9" height="4" rx="2"/><rect x="7" y="2" width="4" height="4" rx="2"/></g><g fill="#e01e5a" transform="rotate(270 12 12)"><rect x="2" y="7" width="9" height="4" rx="2"/><rect x="7" y="2" width="4" height="4" rx="2"/></g></svg>',
  canva:
    '<svg viewBox="0 0 24 24"><path fill="#09b8c7" d="M12 1a11 11 0 100 22 11 11 0 000-22z"/><path fill="none" stroke="white" stroke-width="2" stroke-linecap="round" d="M15 8c1-5-7-2-8 5s7 7 10 1"/></svg>',
  memory:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M12 19c-2 3-6 2-6-1-4 0-5-5-2-7-2-3 0-6 3-6 1-4 5-3 5 0v14c2 3 6 2 6-1 4 0 5-5 2-7 2-3 0-6-3-6-1-4-5-3-5 0M7 9l2 2-2 2m10-4-2 2 2 2"/></svg>',
  database:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M3 6a9 3 0 1018 0 9 3 0 10-18 0v12a9 3 0 0018 0V6M3 12a9 3 0 0018 0"/></svg>',
  filesystem:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M2 6h7l2 3h11l-2 11H2z"/></svg>',
  browser:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M3 4h18v16H3zM3 9h18M6 6.5h1"/></svg>',
  search:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M15 15l6 6M18 10a8 8 0 11-16 0 8 8 0 0116 0"/></svg>',
  git: '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M7 6v12m0-3c0-5 10-2 10-9M7 2a2 2 0 100 4 2 2 0 000-4m10 0a2 2 0 100 4 2 2 0 000-4M7 18a2 2 0 100 4 2 2 0 000-4"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M2 4h20v16H2zM6 9l3 3-3 3m6 0h5"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M2 5h20v14H2zM2 6l10 8L22 6"/></svg>',
  calendar:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M3 5h18v16H3zM7 2v5m10-5v5M3 10h18"/></svg>',
  connector:
    '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M8 9h11v3a5.5 5.5 0 01-11 0zM11 9V4m5 5V4m-3 13v2c0 3-6 3-6 0"/></svg>'
}

export function connectorIcon(row: Connector, compact = false) {
  const candidate = row.icon ?? detectConnectorIcon(row.rawName, row.name)
  const id = Object.hasOwn(ICONS, candidate) ? candidate : 'connector'
  const el = document.createElement('span')
  el.className = compact ? 'mcp-icon compact' : 'mcp-icon'
  if (id === 'connector') {
    let hash = 0
    for (const char of row.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    el.className += ` mcp-icon-hue-${hash % 6}`
  }
  el.setAttribute('aria-hidden', 'true')
  el.dataset.icon = id
  el.innerHTML = ICONS[id]
  return el
}
