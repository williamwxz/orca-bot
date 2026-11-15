import { assert, test } from 'orca/testing'
import { parseModels, availableModels, defaultModel, modelLabel } from './models.ts'
import { avatarSvg, visibleBot, addableMausBot, connectRef } from './appearance.ts'
const instance = (id: string, state = 'available') => ({ instanceId: id, displayName: id.toUpperCase(), snapshot: { state }, models: { default: 'two', options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] } })
test('only available instances offered, Claude then Codex, with actual default preselected', () => {
  const groups = parseModels({ instances: [instance('grok'), instance('unavailable', 'unavailable'), instance('codex'), instance('claude')] })
  assert.deepEqual(availableModels(groups).map((group) => group.instanceId), ['claude', 'codex', 'grok'])
  assert.equal(defaultModel(groups), 'claude/two')
  assert.equal(defaultModel(groups.filter((group) => group.instanceId !== 'claude')), 'codex/two')
  assert.equal(defaultModel([]), '')
  assert.equal(modelLabel(groups, 'claude/two'), 'Two')
  assert.equal(modelLabel(groups, 'missing'), 'Unknown model')
})
test('avatars are stable original SVG with no injected identifiers', () => {
  assert.equal(avatarSvg('bot-a'), avatarSvg('bot-a'))
  assert.notEqual(avatarSvg('bot-a'), avatarSvg('bot-b'))
  assert.doesNotMatch(avatarSvg('<script>evil</script>'), /script|evil/)
})
test('visibility is explicit and hidden default becomes an add row', () => {
  assert.equal(visibleBot({}), true)
  assert.equal(visibleBot({ sidebarHidden: true }), false)
  assert.equal(visibleBot({ hidden: true }), false)
  assert.equal(addableMausBot({ sidebarHidden: true, defaultBot: {} }), true)
  assert.equal(addableMausBot({ sidebarHidden: true }), false)
  assert.equal(addableMausBot({ sidebarHidden: true, defaultBot: { person: 'other' } }), false)
})
test('pairing detection only accepts the exact Connect button reference', () => {
  assert.equal(connectRef('button "Connect" [ref=e11]'), 'e11')
  assert.equal(connectRef('button "Connect apps" [ref=e11]'), undefined)
  assert.equal(connectRef('text "Connect" [ref=e11]'), undefined)
})
