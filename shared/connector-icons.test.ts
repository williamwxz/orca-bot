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
