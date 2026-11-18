const patterns = [
  ['linear', /(?:^|[^a-z0-9])(?:linear)(?=$|[^a-z0-9])/i],
  ['github', /(?:^|[^a-z0-9])(?:github)(?=$|[^a-z0-9])/i],
  ['gitlab', /(?:^|[^a-z0-9])(?:gitlab)(?=$|[^a-z0-9])/i],
  ['notion', /(?:^|[^a-z0-9])(?:notion)(?=$|[^a-z0-9])/i],
  ['atlassian', /(?:^|[^a-z0-9])(?:atlassian|jira|confluence)(?=$|[^a-z0-9])/i],
  ['stripe', /(?:^|[^a-z0-9])(?:stripe)(?=$|[^a-z0-9])/i],
  ['sentry', /(?:^|[^a-z0-9])(?:sentry)(?=$|[^a-z0-9])/i],
  ['cloudflare', /(?:^|[^a-z0-9])(?:cloudflare)(?=$|[^a-z0-9])/i],
  ['supabase', /(?:^|[^a-z0-9])(?:supabase)(?=$|[^a-z0-9])/i],
  ['google-docs', /(?:^|[^a-z0-9])(?:google[ _-]?docs|googledocs|gdocs)(?=$|[^a-z0-9])/i],
  ['google-sheets', /(?:^|[^a-z0-9])(?:google[ _-]?sheets|googlesheets|gsheets)(?=$|[^a-z0-9])/i],
  ['google-drive', /(?:^|[^a-z0-9])(?:google[ _-]?drive|googledrive|gdrive)(?=$|[^a-z0-9])/i],
  ['gmail', /(?:^|[^a-z0-9])(?:gmail)(?=$|[^a-z0-9])/i],
  [
    'google-calendar',
    /(?:^|[^a-z0-9])(?:google[ _-]?calendar|googlecalendar|gcal)(?=$|[^a-z0-9])/i
  ],
  [
    'microsoft',
    /(?:^|[^a-z0-9])(?:microsoft|365|office365|microsoft365|outlook|teams|onedrive)(?=$|[^a-z0-9])/i
  ],
  ['figma', /(?:^|[^a-z0-9])(?:figma)(?=$|[^a-z0-9])/i],
  ['slack', /(?:^|[^a-z0-9])(?:slack)(?=$|[^a-z0-9])/i],
  ['canva', /(?:^|[^a-z0-9])(?:canva)(?=$|[^a-z0-9])/i],
  ['memory', /(?:^|[^a-z0-9])(?:memory)(?=$|[^a-z0-9])/i],
  [
    'database',
    /(?:^|[^a-z0-9])(?:database|postgres|postgresql|mysql|sqlite|redis|mongodb|sql|prisma|neon)(?=$|[^a-z0-9])/i
  ],
  ['filesystem', /(?:^|[^a-z0-9])(?:filesystem|files|fs|dropbox|box|s3)(?=$|[^a-z0-9])/i],
  [
    'browser',
    /(?:^|[^a-z0-9])(?:browser|playwright|puppeteer|chrome|devtools|firecrawl|fetch)(?=$|[^a-z0-9])/i
  ],
  ['search', /(?:^|[^a-z0-9])(?:search|brave|exa|tavily|perplexity)(?=$|[^a-z0-9])/i],
  ['git', /(?:^|[^a-z0-9])(?:git|bitbucket)(?=$|[^a-z0-9])/i],
  ['terminal', /(?:^|[^a-z0-9])(?:terminal|shell|bash|docker|k8s)(?=$|[^a-z0-9])/i],
  ['mail', /(?:^|[^a-z0-9])(?:mail|email)(?=$|[^a-z0-9])/i],
  ['calendar', /(?:^|[^a-z0-9])(?:calendar)(?=$|[^a-z0-9])/i]
] as const
export type ConnectorIcon = (typeof patterns)[number][0] | 'connector'

export function detectConnectorIcon(
  rawName: string,
  name: string,
  definition?: Record<string, unknown>
): ConnectorIcon {
  const hints = [rawName, name]
  if (typeof definition?.url === 'string') {
    try {
      hints.push(new URL(definition.url).hostname)
    } catch {
      /* Invalid endpoint has no hostname hint. */
    }
  }
  if (typeof definition?.command === 'string') hints.push(definition.command)
  if (Array.isArray(definition?.args))
    hints.push(...definition.args.filter((arg): arg is string => typeof arg === 'string'))
  for (const hint of hints) {
    const match = patterns.find(([, pattern]) => pattern.test(hint))
    if (match) return match[0]
  }
  return 'connector'
}
