import { test, assert } from 'orca/testing'
import { detectConnectorIcon } from './connector-icons.ts'

test('connector names take priority over definition hints and aliases match whole tokens', () => {
  assert.equal(detectConnectorIcon('Google Drive', 'work'), 'google-drive')
  assert.equal(detectConnectorIcon('GitHub', 'git', { command: 'docker' }), 'github')
  assert.equal(
    detectConnectorIcon('work', 'work', { args: ['@modelcontextprotocol/server-memory'] }),
    'memory'
  )
  assert.equal(
    detectConnectorIcon('toolbox', 'pacific-nook', { url: 'https://example.com/slack' }),
    'connector'
  )
})

test('short aliases match complete segments', () => {
  for (const name of ['sandbox', 'inbox', 'example', 'my- team-sync', 'pacific-nook'])
    assert.equal(detectConnectorIcon(name, name), 'connector')
  for (const [name, expected] of [
    ['exa', 'search'],
    ['dropbox', 'filesystem'],
    ['box-mcp', 'filesystem'],
    ['memory', 'memory']
  ])
    assert.equal(detectConnectorIcon(name, name), expected)
})
