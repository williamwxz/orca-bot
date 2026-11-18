import { test, assert } from 'orca/testing'
import { listModels } from './omb-models.ts'
import { validateRelayInput, RELAYED } from './relay-frames.ts'

const instance = (instanceId: string, driverKind = instanceId, extra = {}) => ({
  instanceId,
  driverKind,
  displayName: driverKind,
  snapshot: { state: 'available' },
  models: { default: 'gpt-default', options: [{ id: 'provider/gpt-6', label: ' Friendly ' }] },
  ...extra
})
test('models project only safe picker fields, preserve tier order and disambiguate duplicate accounts', async () => {
  const groups = await listModels(123, {
    avatar: async () => undefined,
    request: async (_port, path) => {
      assert.equal(path, '/api/instances')
      return {
        instances: [
          instance('free', 'codex', { snapshot: { state: 'available', freeFallback: true } }),
          instance('custom', 'claudeAgent', {
            access: 'custom',
            snapshot: { state: 'available', authenticated: false }
          }),
          instance('grok', 'grok'),
          instance('gemini', 'geminiAgent'),
          instance('anti', 'antigravityAgent'),
          instance('codex'),
          instance('claude1', 'claudeAgent', {
            token: 'SECRET',
            config: { url: 'https://secret', key: 'SECRET' }
          }),
          instance('claude2', 'claudeAgent')
        ]
      }
    }
  })
  assert.deepEqual(
    groups.groups.map((g) => g.instanceId),
    ['claude1', 'claude2', 'codex', 'gemini', 'anti', 'grok', 'custom', 'free']
  )
  assert.deepEqual(
    groups.groups.slice(0, 2).map((g) => g.label),
    ['claudeAgent (1)', 'claudeAgent (2)']
  )
  assert.deepEqual(groups.groups[0].models, [
    { id: 'gpt-default', label: 'GPT-default' },
    { id: 'provider/gpt-6', label: 'Friendly' }
  ])
  assert.equal(JSON.stringify(groups).includes('SECRET'), false)
  assert.equal(JSON.stringify(groups).includes('https://secret'), false)
  assert.deepEqual(Object.keys(groups.groups[0]), ['instanceId', 'label', 'models'])
})
test('models exclude unavailable, signed out, policy-blocked, disabled, invalid and blocked default options', async () => {
  const result = await listModels(1, {
    avatar: async () => undefined,
    request: async () => ({
      instances: [
        instance('disabled', '', { enabled: false }),
        instance('signedout', '', { snapshot: { state: 'available', authenticated: false } }),
        instance('policy', '', { policy: { reason: 'secret refusal' } }),
        instance('missing', '', { snapshot: { state: 'missing' } }),
        instance('bad/id'),
        instance('ready', 'codex', {
          displayName: '/Users/private/token',
          models: {
            default: 'blocked',
            options: [
              { id: 'blocked', orgBlocked: true },
              { id: 'old', needsCliUpdate: true },
              { id: '' },
              { id: 'ok' },
              { id: 'ok' }
            ]
          }
        })
      ]
    })
  })
  assert.deepEqual(result, {
    groups: [{ instanceId: 'ready', label: 'Codex', models: [{ id: 'ok', label: 'ok' }] }]
  })
  await assert.rejects(
    listModels(1, {
      avatar: async () => undefined,
      request: async () => {
        throw new Error('SECRET')
      }
    }),
    /Could not load models/
  )
})
test('model validation also applies at the relay boundary', () => {
  assert.ok(RELAYED.includes('models.list'))
  validateRelayInput('bots.act', {
    action: 'model',
    instanceId: 'account.a-1',
    model: 'provider/model'
  })
  for (const input of [
    { instanceId: '../private', model: 'ok' },
    { instanceId: 'a', model: '\nsecret' },
    { instanceId: 'a', model: ' ' },
    { instanceId: 'a', model: 'x'.repeat(201) }
  ])
    assert.throws(
      () => validateRelayInput('bots.act', { action: 'model', ...input }),
      /valid provider/
    )
})
