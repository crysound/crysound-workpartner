import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Preview } from '../lib/preview.js'
const tick = () => new Promise(resolve => setImmediate(resolve))

function rig(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let now = 0, bodyId, progressId
  const calls = []
  const lark = {
    async createStreamingCard(body, progress) { bodyId = body; progressId = progress; calls.push(['create', body, progress]); return 'card' },
    async sendMessage() { return 'message' },
    async streamCardContent(card, id, content, seq) { calls.push(['stream', id, content, seq]); return true },
    async updateCardElement(card, id, element, seq) { calls.push(['element', id, element, seq]); return true },
    async settleStreamingCard(card, seq, value) { calls.push(['settle', value, seq]); return true },
    async patchCard() { throw Error('unexpected fallback') },
  }
  const preview = new Preview(lark, { chatId: 'chat' }, () => now)
  t.after(() => preview.finish())
  return { preview, calls, get bodyId() { return bodyId }, get progressId() { return progressId },
    async advance(ms) { now += ms; t.mock.timers.tick(ms); await tick() } }
}

test('progress and heartbeat use element updates; body streams retain prefixes across tool rounds', async t => {
  const h = rig(t), p = h.preview
  p.start(); await tick()
  await h.advance(1000)
  assert.match(h.calls.find(c => c[0] === 'element')[2].content, /已 1 秒/)
  assert.equal(h.calls.filter(c => c[0] === 'stream').length, 0)
  p.delta('检查'); await h.advance(200)
  p.delta('资料'); p.line('搜索资料'); await h.advance(200)
  p.settled('检查资料', true); await h.advance(200)
  p.delta('最终'); await h.advance(200)
  for (let i = 0; i < 8; i++) { p.line('工具步骤 ' + i); p.delta('回答'); await h.advance(200) }
  const previous = new Map()
  for (const [kind, id, text] of h.calls) if (kind === 'stream') {
    assert.ok(text.startsWith(previous.get(id) ?? ''))
    assert.doesNotMatch(text, /工具步骤|搜索资料|思考中|已执行/)
    previous.set(id, text)
  }
  assert.equal(previous.size, 2)
  const last = h.calls.filter(c => c[0] === 'stream').at(-1)
  await p.finish()
  const final = h.calls.at(-1)[1]
  assert.equal(final.body.elements[0].content, last[2])
  assert.equal(final.body.elements[0].element_id, last[1])
  assert.equal(final.body.elements[1].tag, 'collapsible_panel')
  assert.equal(final.body.elements[1].expanded, false)
  assert.equal(final.body.elements[1].element_id, h.progressId)
  assert.equal(final.body.elements[1].header.title.content, '过程（9 步）')
  const count = h.calls.length
  await h.advance(3000)
  assert.equal(h.calls.length, count, 'finish cancels both pacing and heartbeat')
})

test('oversized streamed answer freezes a stable prefix including the final frame', async t => {
  const h = rig(t), p = h.preview
  p.start(); await tick()
  for (let i = 0; i < 9; i++) { p.delta('\\😀中文'.repeat(300)); await h.advance(200) }
  let previous = ''
  for (const call of h.calls.filter(c => c[0] === 'stream')) {
    assert.ok(call[2].startsWith(previous))
    previous = call[2]
  }
  const result = await p.finish()
  assert.equal(result.overflow, true)
  const final = h.calls.at(-1)[1]
  assert.equal(final.body.elements[0].content, previous)
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(final))) < 30000)
})

test('progress refusal closes streaming and falls back without losing the answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let now = 0
  const calls = []
  const lark = {
    async createStreamingCard() { return 'card' },
    async sendMessage() { return 'message' },
    async streamCardContent() { return true },
    async updateCardElement() { return false },
    async settleStreamingCard(card, seq, value) { calls.push(['close', seq, value]); return true },
    async updatePreview(id, value) { calls.push(['update', value]); return 'ok' },
    async patchCard(id, value) { calls.push(['final', value]); return true },
  }
  const p = new Preview(lark, { chatId: 'chat' }, () => now)
  t.after(() => p.finish())
  p.start(); await tick()
  p.delta('answer'); now = 200; t.mock.timers.tick(200); await tick()
  assert.deepEqual(calls.map(c => c[0]), ['close', 'update'])
  assert.equal((await p.finish('', 'answer')).delivered, true)
  assert.equal(calls.at(-1)[1].body.elements[0].content, 'answer')
})
