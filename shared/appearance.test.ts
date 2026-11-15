import { assert, test } from 'orca/testing'
import { avatarSvg, visibleBot, addableMausBot, connectRef } from './appearance.ts'
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
