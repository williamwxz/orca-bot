import { assert, test } from 'orca/testing'
import { readThread, sendMessage, newSendId } from './omb-chat.ts'
import { CliFailure } from './omb-cli.ts'
import type { CliDeps } from './omb-cli.ts'
const botId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const sendId = 'fake-send-id-000001'
function fake() {
  const calls: string[][] = []
  const inputs: (string | undefined)[] = []
  const deps: CliDeps = { userInfo: () => ({ username: 'fake-user', shell: '/fake/shell' }), home: '/fake', env: {}, platform: 'darwin', exists: () => true, sleep: async () => {}, execFile: async (_file, args, _options, input) => { calls.push(args); inputs.push(input); return JSON.stringify({ messages: [], hasMore: true }) } }
  return { deps, calls, inputs }
}
test('read and send use exact arguments and bounded defaults', async () => {
  const { deps, calls, inputs } = fake()
  assert.equal((await readThread({ port: 8799, botId }, deps)).hasMore, true)
  assert.deepEqual(await sendMessage({ port: 8799, botId, text: 'hello\nworld', sendId }, deps), { sendId })
  assert.deepEqual(calls, [
    ['messages', '--bot', botId, '--limit', '20', '--port', '8799', '--json'],
    ['send', '--bot', botId, '-', '--send-id', sendId, '--port', '8799', '--json']
  ])
  assert.deepEqual(inputs, [undefined, 'hello\nworld'])
  assert.equal(calls.flat().includes('hello\nworld'), false)
  await readThread({ port: 18799, botId, limit: 8 }, deps)
  assert.deepEqual(calls[2], ['messages', '--bot', botId, '--limit', '8', '--port', '18799', '--json'])
  assert.match(newSendId(), /^[a-zA-Z0-9_-]{16,80}$/)
  assert.notEqual(newSendId(), newSendId())
})
test('send exit 3 succeeds; JSON failures and stderr are sanitized without retry', async () => {
  const { deps } = fake()
  let calls = 0
  deps.execFile = async () => { calls++; throw new CliFailure(3, '{"waiting":true}') }
  assert.deepEqual(await sendMessage({ port: 8799, botId, text: 'Hi', sendId }, deps), { sendId })
  assert.equal(calls, 1)
  deps.execFile = async () => { throw new CliFailure(1, '{"error":{"code":"BOT_NOT_FOUND","message":"SECRET"}}') }
  await assert.rejects(readThread({ port: 8799, botId }, deps), /no longer available/)
  deps.execFile = async () => '{"ok":false,"error":"SECRET"}'
  await assert.rejects(sendMessage({ port: 8799, botId, text: 'Hi', sendId }, deps), /Could not confirm sending/)
  deps.execFile = async () => { throw new Error('stderr SECRET') }
  await assert.rejects(readThread({ port: 8799, botId }, deps), /Could not read messages/)
})
test('bad bot ids, message lengths and limits never execute', async () => {
  const { deps, calls } = fake()
  await assert.rejects(readThread({ port: 8799, botId: 'bad' }, deps), /Invalid bot ID/)
  await assert.rejects(readThread({ port: 8799, botId, limit: 21 }, deps), /limit/)
  await assert.rejects(sendMessage({ port: 8799, botId, text: 'x'.repeat(16001), sendId }, deps), /16,000/)
  assert.equal(calls.length, 0)
})
