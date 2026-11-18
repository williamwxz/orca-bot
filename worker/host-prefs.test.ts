import { assert, test } from 'orca/testing'
import { defaultHostPrefs, fileHostPrefs } from './host-prefs.ts'

test('host preferences heal corrupt JSON using private atomic temp writes and sanitize failures', () => {
  const file = '/fake/preferences.json'
  const files = new Map<string, string>()
  const temporary: string[] = []
  let failWrite = false
  let failRename = false
  const prefs = fileHostPrefs(file, {
    readFileSync: (path) => {
      if (!files.has(String(path))) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return files.get(String(path)) as never
    },
    mkdirSync: () => undefined,
    writeFileSync: (path, data, options) => {
      if (failWrite) throw new Error('private disk details')
      assert.deepEqual(options, { mode: 0o600, flag: 'wx' })
      assert.notEqual(String(path), file)
      assert.ok(String(path).startsWith(file + '.'))
      temporary.push(String(path))
      files.set(String(path), String(data))
    },
    renameSync: (from, to) => {
      if (failRename) throw new Error('private rename details')
      assert.equal(String(to), file)
      files.set(String(to), files.get(String(from))!)
      files.delete(String(from))
    },
    unlinkSync: (path) => {
      files.delete(String(path))
    }
  })
  assert.equal(prefs.read(), undefined)
  for (const corrupt of ['', '{']) {
    files.set(file, corrupt)
    assert.equal(prefs.read(), undefined)
    prefs.write({ shareTools: true, stopped: true })
    assert.deepEqual(prefs.read(), { shareTools: true, stopped: true })
    assert.deepEqual([...files.keys()], [file])
  }
  assert.equal(new Set(temporary).size, 2)
  prefs.write({ installConsent: true })
  assert.equal(prefs.read()?.stopped, true)
  for (const stage of ['write', 'rename']) {
    failWrite = stage === 'write'
    failRename = stage === 'rename'
    assert.throws(
      () => prefs.write({ shareTools: false }),
      /^Error: Could not save bot permissions on this host\.$/
    )
    assert.equal(prefs.read()?.shareTools, true)
    assert.deepEqual([...files.keys()], [file])
  }
  assert.throws(() => defaultHostPrefs(), /Tests must inject/)
  assert.throws(() => fileHostPrefs(file), /Tests must inject/)
})
