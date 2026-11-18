export const TESTED_OPENMAUSBOT_VERSION = '0.1.169'

export function compareVersions(a: string, b: string): number | undefined {
  const leftPrefix = a.match(/^\d+(?:\.\d+)*/)?.[0]
  const rightPrefix = b.match(/^\d+(?:\.\d+)*/)?.[0]
  if (!leftPrefix || !rightPrefix) return undefined
  const left = leftPrefix.split('.').map(Number)
  const right = rightPrefix.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export const INSTALL_NOTICE =
  `Install openmausbot@${TESTED_OPENMAUSBOT_VERSION} from npm ` +
  '(about 75 MB) into ~/.orca-bot. This also allows verified updates when bots are idle.'
