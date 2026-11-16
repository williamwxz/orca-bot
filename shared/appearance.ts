export function avatarSvg(id: string): string {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  const hue = hash % 360
  const shape =
    hash % 2
      ? '<rect x="6" y="7" width="28" height="26" rx="10"/>'
      : '<path d="M20 4 35 13 33 29 20 36 7 29 5 13Z"/>'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" aria-hidden="true"><g fill="hsl(${hue} 58% 60%)">${shape}</g><g class="avatar-eyes" fill="hsl(${hue} 40% 16%)"><circle cx="15" cy="19" r="2"/><circle cx="25" cy="19" r="2"/></g><path d="M16 26h8" stroke="hsl(${hue} 40% 16%)" stroke-width="2" stroke-linecap="round"/></svg>`
}

export function visibleBot(bot: {
  hidden?: unknown
  sidebarHidden?: unknown
  defaultBot?: { person?: unknown }
}): boolean {
  // Match the local UI, excluding person-owned defaults whose browser identity is unknown.
  return !bot.hidden && !bot.sidebarHidden && !bot.defaultBot?.person
}

export function addableMausBot(bot: {
  hidden?: unknown
  sidebarHidden?: unknown
  defaultBot?: { person?: unknown }
}): boolean {
  return !bot.hidden && bot.sidebarHidden === true && !!bot.defaultBot && !bot.defaultBot.person
}

// The pairing page's Connect button, enabled or not (it is disabled until a code is filled in).
export function pairingScreen(snapshot: string): boolean {
  return /button "Connect" \[[^\]\n]*\bref=e\d+\]/.test(snapshot)
}

// The Connect button's reference, only while it can be pressed.
export function connectRef(snapshot: string): string | undefined {
  const match = /button "Connect" \[([^\]\n]*)\]/.exec(snapshot)
  if (!match || /\bdisabled\b/.test(match[1])) return undefined
  return /\bref=(e\d+)\b/.exec(match[1])?.[1]
}
