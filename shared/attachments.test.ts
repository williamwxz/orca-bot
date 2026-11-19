import { assert, test } from 'orca/testing'
import { composeMessage, splitAttachments, uploadProblem, validateUpload } from './attachments.ts'

test('messages carry one standalone tag per attachment and read back as names', () => {
  const text = composeMessage('  Look at these  ', [
    { kind: 'image', path: '/data/attachments/a.png', name: 'shot "1".png' },
    { kind: 'file', path: '/data/attachments/b.pdf', name: 'a<b>&\nc.pdf' }
  ])
  assert.equal(
    text,
    'Look at these\n\n<attached-image path="/data/attachments/a.png" name="shot &quot;1&quot;.png" />\n\n' +
      '<attached-file path="/data/attachments/b.pdf" name="a&lt;b&gt;&amp;&#10;c.pdf" />'
  )
  assert.deepEqual(splitAttachments(text), {
    text: 'Look at these',
    attachments: [
      { kind: 'image', name: 'shot "1".png' },
      { kind: 'file', name: 'a<b>&\nc.pdf' }
    ]
  })
  assert.equal(composeMessage('', [{ kind: 'file', path: '/x/y.zip', name: 'y.zip' }]), '<attached-file path="/x/y.zip" name="y.zip" />')
  assert.deepEqual(splitAttachments('<attached-image path="/x/z.png" />').attachments, [{ kind: 'image', name: 'z.png' }])
  // Prose mentioning a tag is not an attachment.
  assert.deepEqual(splitAttachments('see <attached-file path="/x" /> here').attachments, [])
})

test('uploads are checked for name, type, data and size before any request', () => {
  assert.equal(validateUpload({ name: ' a.png ', mime: 'IMAGE/PNG; x=1', data: 'AAAA' }).mime, 'image/png')
  assert.equal(validateUpload({ name: 'a', mime: '', data: 'AAAA' }).mime, 'application/octet-stream')
  for (const bad of [
    { name: '', mime: 'image/png', data: 'AAAA' },
    { name: 'a\nb', mime: 'image/png', data: 'AAAA' },
    { name: 'a', mime: 'not a type', data: 'AAAA' },
    { name: 'a', mime: 'image/png', data: '' },
    { name: 'a', mime: 'image/png', data: '!!!!' }
  ])
    assert.throws(() => validateUpload(bad))
  assert.throws(() => validateUpload({ name: 'a', mime: 'image/png', data: 'AAA' }), /Invalid file data/)
  // Exactly 10 MiB of image passes although its base64 ends in padding; one byte more does not.
  const b64 = (bytes: number) => Buffer.alloc(bytes).toString('base64')
  const limit = 10 * 1024 * 1024
  assert.ok(b64(limit).endsWith('='))
  assert.equal(validateUpload({ name: 'a.png', mime: 'image/png', data: b64(limit) }).name, 'a.png')
  assert.throws(() => validateUpload({ name: 'a.png', mime: 'image/png', data: b64(limit + 1) }), /larger than 10 MB/)
  assert.match(uploadProblem('big.png', 'image/png', 11 * 1024 * 1024)!, /larger than 10 MB/)
  assert.equal(uploadProblem('big.pdf', 'application/pdf', 11 * 1024 * 1024), undefined)
  assert.match(uploadProblem('huge.mov', 'video/quicktime', 26 * 1024 * 1024)!, /larger than 25 MB/)
  assert.match(uploadProblem('empty.txt', 'text/plain', 0)!, /empty/)
})
