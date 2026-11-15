import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { register } from './worker.ts'

test('status explains that OpenMausBot support is not built yet', async () => {
  const worker = await mountWorker(
    { default: (orca) => register(orca, {}) },
    { host: mockHost() }
  )
  try {
    assert.deepEqual(await worker.request('status', {}), {
      ok: false,
      message: 'OpenMausBot support is not built yet.'
    })
  } finally {
    await worker.deactivate()
  }
})
