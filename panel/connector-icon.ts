import { detectConnectorIcon, type ConnectorIcon } from '../shared/connector-icons.ts'
import type { Connector } from '../worker/mcp-connectors.ts'

// Monochrome brand paths from Simple Icons. All artwork is bundled locally.
const ICONS: Record<ConnectorIcon, string> = {
  linear:
    '<svg viewBox="0 0 24 24"><path fill="#727bfa" d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/></svg>',
  github:
    '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
  gitlab:
    '<svg viewBox="0 0 24 24"><path fill="#fc6d26" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/></svg>',
  notion:
    '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/></svg>',
  atlassian:
    '<svg viewBox="0 0 24 24"><path fill="#2684ff" d="M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z"/></svg>',
  stripe:
    '<svg viewBox="0 0 24 24"><path fill="#7462ff" d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"/></svg>',
  sentry:
    '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z"/></svg>',
  cloudflare:
    '<svg viewBox="0 0 24 24"><path fill="#f48120" d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727"/></svg>',
  supabase:
    '<svg viewBox="0 0 24 24"><path fill="#39bc87" d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"/></svg>',
  'google-docs':
    '<svg viewBox="0 0 24 24"><path fill="#4285f4" d="M14.727 6.727H14V0H4.91c-.905 0-1.637.732-1.637 1.636v20.728c0 .904.732 1.636 1.636 1.636h14.182c.904 0 1.636-.732 1.636-1.636V6.727h-6zm-.545 10.455H7.09v-1.364h7.09v1.364zm2.727-3.273H7.091v-1.364h9.818v1.364zm0-3.273H7.091V9.273h9.818v1.363zM14.727 6h6l-6-6v6z"/></svg>',
  'google-sheets':
    '<svg viewBox="0 0 24 24"><path fill="#0f9d58" d="M11.318 12.545H7.91v-1.909h3.41v1.91zM14.728 0v6h6l-6-6zm1.363 10.636h-3.41v1.91h3.41v-1.91zm0 3.273h-3.41v1.91h3.41v-1.91zM20.727 6.5v15.864c0 .904-.732 1.636-1.636 1.636H4.909a1.636 1.636 0 0 1-1.636-1.636V1.636C3.273.732 4.005 0 4.909 0h9.318v6.5h6.5zm-3.273 2.773H6.545v7.909h10.91v-7.91zm-6.136 4.636H7.91v1.91h3.41v-1.91z"/></svg>',
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
