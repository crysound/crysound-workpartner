import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Preview } from '../lib/preview.js'

function rig(options = {}) {
  const calls = []
  let now = 0
  const lark = {
    async updateCardElement() { return true },
    async createStreamingCard() { return options.streaming ? 'card' : undefined },
    async sendMessage(...args) { calls.push(['send', ...args]); return options.noMessage ? undefined : 'message' },
    async streamCardContent(...args) { calls.push(['stream', ...args]); return true },
    async settleStreamingCard(...args) { calls.push(['settle', ...args]); return options.settleOk ?? true },
    async patchCard(...args) { calls.push(['patch', ...args]); return options.patchOk ?? true },
    async updatePreview(...args) { calls.push(['update', ...args]); return 'ok' },
  }
  const preview = new Preview(lark, { chatId: 'chat', messageId: 'origin', threadId: 'thread' }, () => now)
  return { preview, calls, clock(value) { now = value } }
}

for (const streaming of [false, true]) test(`final body survives completion, streaming=${streaming}`, async () => {
  const h = rig({ streaming })
  h.preview.start()
  h.clock(18100)
  const body = '# Heading\n```js\nconst x = 1;\n```\n  '
  const result = await h.preview.finish('', body)
  assert.deepEqual(result, { delivered: true, overflow: false, elapsedMs: 18100 })
  const last = h.calls.at(-1)
  const card = last.at(-1)
  for (const element of card.body.elements) delete element.element_id
  assert.equal(card.body.elements[0].content, body)
  assert.deepEqual(card.body.elements, [{ tag: 'markdown', content: body }])
  assert.equal(h.calls.filter(c => c[0] === 'send').length, 1)
  if (streaming) assert.equal(h.calls.find(c => c[0] === 'stream')[3], body)
})

for (const body of ['a'.repeat(8100), '\\'.repeat(7999), '😀'.repeat(4500)]) test(`oversized card keeps a prefix and signals separate delivery (${body.codePointAt(0)})`, async () => {
  const h = rig()
  const result = await h.preview.finish('', body)
  assert.equal(result.overflow, true)
  assert.equal(result.delivered, true)
  const card = h.calls.at(-1).at(-1)
  const prefix = card.body.elements[0].content.replace(/\n\n全文见下条$/, '')
  assert.ok(body.startsWith(prefix))
  assert.match(card.body.elements[0].content, /全文见下条$/)
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(card))) < 30000)
  assert.doesNotMatch(prefix, /[\uD800-\uDBFF]$/)
})

for (const options of [{ streaming: true, settleOk: false, patchOk: false }, { noMessage: true }]) {
  test(`delivery failure is reported for fallback: ${JSON.stringify(options)}`, async () => {
    const h = rig(options)
    const result = await h.preview.finish('', 'answer')
    assert.equal(result.delivered, false)
    if (options.streaming) assert.equal(h.calls.at(-1)[0], 'patch')
  })
}

test('finishing drains the same in-flight create once and freezes elapsed time', async () => {
  const calls = []
  let release, now = 0
  const lark = {
    createStreamingCard() { return new Promise(resolve => { release = resolve }) },
    async sendMessage() { calls.push('send'); return 'message' },
    async patchCard() { calls.push('patch'); return true },
  }
  const preview = new Preview(lark, { chatId: 'chat' }, () => now)
  preview.start(); now = 1200
  const first = preview.finish('', 'answer')
  assert.equal(first, preview.finish('已停止', 'other'))
  assert.deepEqual(calls, [])
  now = 61000; release(undefined)
  assert.deepEqual(await first, { delivered: true, overflow: false, elapsedMs: 1200 })
  assert.deepEqual(calls, ['send', 'patch'])
})

test('a clipped code fence closes before the full-answer pointer', async () => {
  const h = rig()
  await h.preview.finish('', '```js\n' + 'const x = 1;\n'.repeat(800))
  const text = h.calls.at(-1).at(-1).body.elements[0].content
  assert.match(text, /\n```\n\n全文见下条$/)
})

for (const streaming of [false, true]) test(`abnormal status has no elapsed time, streaming=${streaming}`, async () => {
  const h = rig({ streaming })
  h.clock(18100)
  await h.preview.finish('已停止', 'partial answer')
  const card = h.calls.at(-1).at(-1)
  for (const element of card.body.elements) delete element.element_id
  assert.deepEqual(card.body.elements, [
    { tag: 'markdown', content: 'partial answer' },
    { tag: 'markdown', content: '已停止', text_size: 'notation' },
  ])
})
