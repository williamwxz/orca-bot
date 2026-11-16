import { assert, test } from 'orca/testing'
import { childEnvironment } from './child-environment.ts'
import { cliOptions } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'

function fake(env: NodeJS.ProcessEnv = {}): CliDeps {
  return {
    home: '/fake',
    platform: 'darwin',
    env,
    userInfo: () => ({ username: 'fake-user', shell: '/fake/shell' }),
    exists: () => false,
    sleep: async () => {},
    execFile: async () => ''
  }
}

test('child environment fills account and locale values without mutating parent', () => {
  const deps = fake()
  const env = childEnvironment(deps)
  assert.equal(env.USER, 'fake-user')
  assert.equal(env.LOGNAME, 'fake-user')
  assert.equal(env.SHELL, '/fake/shell')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.deepEqual(deps.env, {})
  assert.deepEqual(cliOptions(deps).env, env)
})

test('present account values and either locale are preserved, including empty strings', () => {
  for (const value of ['existing', '']) {
    const deps = fake({ USER: value, LOGNAME: value, SHELL: value, LANG: value })
    deps.userInfo = () => {
      throw new Error('No lookup needed')
    }
    const env = childEnvironment(deps)
    for (const key of ['USER', 'LOGNAME', 'SHELL', 'LANG']) assert.equal(env[key], value)
    const withLocale = childEnvironment(fake({ LC_ALL: value }))
    assert.equal(withLocale.LC_ALL, value)
    assert.equal(withLocale.LANG, undefined)
  }
  const env = childEnvironment(fake({ USER: 'custom-user', SHELL: 'custom-shell' }))
  assert.equal(env.USER, 'custom-user')
  assert.equal(env.SHELL, 'custom-shell')
  assert.equal(env.LOGNAME, 'fake-user')
})

test('platforms without an account shell do not invent one', () => {
  const deps = fake()
  deps.userInfo = () => ({ username: 'fake-user', shell: null })
  assert.equal(childEnvironment(deps).SHELL, undefined)
})
