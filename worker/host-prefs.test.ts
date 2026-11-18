import { assert, test } from 'orca/testing'
import { defaultHostPrefs, fileHostPrefs } from './host-prefs.ts'

test('host preferences merge explicit booleans and sanitize disk failures with injected storage', () => {
  let content: string | undefined
  let failWrite = false
  const prefs = fileHostPrefs('/fake/preferences.json', {
    readFileSync: () => {
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return content as never
    },
    mkdirSync: () => undefined,
    writeFileSync: (_file, data, options) => {
      if (failWrite) throw new Error('private disk details')
      assert.deepEqual(options, { mode: 0o600 })
      content = String(data)
    }
  })
  assert.equal(prefs.read(), undefined)
  prefs.write({ shareTools: true, linkAgents: false })
  prefs.write({ installConsent: true })
  assert.deepEqual(prefs.read(), { shareTools: true, linkAgents: false, installConsent: true })
  failWrite = true
  assert.throws(
    () => prefs.write({ shareTools: false }),
    /^Error: Could not save bot permissions on this host\.$/
  )
  assert.equal(prefs.read()?.shareTools, true)
  content = 'invalid private contents'
  assert.throws(() => prefs.read(), /^Error: Could not read bot permissions on this host\.$/)
  assert.throws(() => defaultHostPrefs(), /Tests must inject/)
  assert.throws(() => fileHostPrefs('/fake/preferences.json'), /Tests must inject/)
})
