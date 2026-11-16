// Run: node listing/build.mjs && node listing/render.mjs
// Uses an isolated temporary Chrome profile; never opens an account or app UI.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = mkdtempSync(join(tmpdir(), 'orca-listing-'))
try {
  for (const [name, width, height] of [
    ['icon', 512, 512],
    ['cover', 1600, 1000],
    ['screenshot-bots', 1280, 800],
    ['screenshot-chat', 1280, 800],
    ['screenshot-setup', 1280, 800]
  ]) {
    execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--window-size=${width},${height}`,
        '--virtual-time-budget=1000',
        `--screenshot=${fileURLToPath(new URL('../images/' + name + '.png', import.meta.url))}`,
        new URL(name + '.html', import.meta.url).href
      ],
      { stdio: 'pipe' }
    )
    console.log(name + '.png')
  }
} finally {
  rmSync(profile, { recursive: true, force: true })
}
