import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Preview, TurnOutput, PROGRESS_INTERVAL_MS } from '../lib/preview.js'
const tick = () => new Promise(resolve => setImmediate(resolve))

function rig(t, progressIntervalMs = PROGRESS_INTERVAL_MS) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let now = 0, bodyId, progressId
  const calls = []
  const lark = {
    async createStreamingCard(body, progress, initial) { bodyId = body; progressId = progress; calls.push(['create', body, progress, initial]); return 'card' },
    async sendMessage() { return 'message' },
    async streamCardContent(card, id, content, seq) { calls.push(['stream', id, content, seq]); return true },
    async updateCardElement(card, id, element, seq) { calls.push(['element', id, element, seq, now]); return true },
    async settleStreamingCard(card, seq, value) { calls.push(['settle', value, seq]); return true },
    async patchCard() { throw Error('unexpected fallback') },
  }
  const preview = new Preview(lark, { chatId: 'chat' }, () => now, 200, '', progressIntervalMs)
  t.after(() => preview.finish())
  return { preview, lark, calls, get bodyId() { return bodyId }, get progressId() { return progressId },
    async advance(ms) { now += ms; t.mock.timers.tick(ms); await tick() } }
}

test('progress and heartbeat use element updates; body streams retain prefixes across tool rounds', async t => {
  const h = rig(t), p = h.preview
  p.start(); await tick()
  await h.advance(PROGRESS_INTERVAL_MS)
  assert.equal(h.calls.find(c => c[0] === 'element')[2].content, '思考中..')
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
  p.line('搜索网页', true); now = PROGRESS_INTERVAL_MS; t.mock.timers.tick(PROGRESS_INTERVAL_MS); await tick()
  assert.deepEqual(calls.map(c => c[0]), ['close', 'update'])
  assert.equal((await p.finish('', 'answer')).delivered, true)
  assert.equal(calls.at(-1)[1].body.elements[0].content, 'answer')
})


test('tool progress cycles dots without arguments; body output stops idle animation', async t => {
  const h = rig(t), p = h.preview, output = new TurnOutput(p)
  p.start(); await tick()
  assert.equal(h.calls[0][3], '思考中.')
  output.tool('t', '搜索网页')
  await h.advance(PROGRESS_INTERVAL_MS - 1)
  assert.equal(h.calls.filter(c => c[0] === 'element').length, 0)
  await h.advance(1)
  await h.advance(PROGRESS_INTERVAL_MS)
  await h.advance(PROGRESS_INTERVAL_MS)
  assert.deepEqual(h.calls.filter(c => c[0] === 'element').map(c => c[2].content), [
    '搜索网页..\n已执行 1 步', '搜索网页...\n已执行 1 步', '搜索网页.\n已执行 1 步',
  ])
  p.delta('正文'); await h.advance(200)
  assert.equal(h.calls.filter(c => c[0] === 'stream').at(-1)[2], '正文')
  await h.advance(PROGRESS_INTERVAL_MS)
  const count = h.calls.length
  for (let i = 0; i < 6; i++) await h.advance(PROGRESS_INTERVAL_MS)
  assert.equal(h.calls.length, count, 'body output leaves no animation traffic')
  p.settled('正文', true); await h.advance(200)
  await h.advance(PROGRESS_INTERVAL_MS)
  assert.match(h.calls.filter(c => c[0] === 'element').at(-1)[2].content, /^思考中\.+/)
})

test('rapid tool and body events obey progress pacing without delaying body frames', async t => {
  const h = rig(t), p = h.preview
  p.start(); await tick()
  p.line('step 0', true); await tick()
  for (let i = 0; i < 60; i++) {
    p.line(`step ${i}`, true); p.delta('字')
    await h.advance(100)
  }
  const frames = h.calls.filter(c => c[0] === 'element' && c[1] === h.progressId)
  let previous = 0
  for (const frame of frames) {
    assert.ok(frame[4] - previous >= PROGRESS_INTERVAL_MS)
    previous = frame[4]
  }
  assert.ok(frames.length > 0 && frames.length <= 4)
  assert.ok(h.calls.filter(c => c[0] === 'stream').length >= 25, 'a pending progress timer cannot block body deltas')
  assert.ok(h.calls.filter(c => c[0] === 'stream').every(c => !/思考中|step|已执行|\.\.\./.test(c[2])))
})

for (const status of ['', '出错了', '已停止']) test(`terminal status ${status || 'completed'} drains timers and ignores new events`, async t => {
  const h = rig(t), p = h.preview
  p.start(); await tick()
  p.line('执行命令', true)
  await h.advance(PROGRESS_INTERVAL_MS)
  await p.finish(status, '最终正文')
  const final = h.calls.at(-1)[1]
  assert.equal(final.body.elements[1].tag, 'collapsible_panel')
  assert.equal(final.body.elements[1].element_id, h.progressId)
  const count = h.calls.length
  p.line('late', true); p.delta('late'); p.settled('late', true); p.start()
  for (let i = 0; i < 5; i++) await h.advance(PROGRESS_INTERVAL_MS)
  assert.equal(h.calls.length, count)
})

test('finish during a body request prevents a queued animation before final settlement', async t => {
  const h = rig(t), p = h.preview
  let release
  h.lark.streamCardContent = async (...args) => {
    h.calls.push(['stream', args[1], args[2], args[3]])
    await new Promise(resolve => { release = resolve })
    return true
  }
  p.start(); await tick()
  p.delta('正文'); await h.advance(PROGRESS_INTERVAL_MS)
  const finishing = p.finish('', '正文')
  release(); await finishing
  assert.equal(h.calls.filter(c => c[0] === 'element').length, 0)
  assert.equal(h.calls.at(-1)[0], 'settle')
})

test('whole-card fallback uses the same slow progress and stops after send failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let now = 0
  const calls = []
  const lark = {
    async createStreamingCard() { return undefined },
    async sendMessage(target, type, card) { calls.push(['send', card]); return 'message' },
    async updatePreview(id, card) { calls.push(['update', now, card]); return 'ok' },
    async patchCard(id, card) { calls.push(['final', card]); return true },
  }
  const p = new Preview(lark, { chatId: 'chat' }, () => now)
  t.after(() => p.finish())
  p.start(); await tick()
  p.line('读取网页', true)
  now = 1499; t.mock.timers.tick(1499); await tick()
  assert.equal(calls.length, 1)
  now = 1500; t.mock.timers.tick(1); await tick()
  assert.equal(calls[1][2].body.elements[1].content, '读取网页..\n已执行 1 步')
  assert.equal(calls[1][2].body.elements[0].content, '')
  await p.finish('', '正文')
  const count = calls.length
  now += 30000; t.mock.timers.tick(30000); await tick()
  assert.equal(calls.length, count)
  assert.equal(calls.at(-1)[1].body.elements[1].tag, 'collapsible_panel')
  const failed = new Preview({ ...lark, async sendMessage() { calls.push(['refused']); return undefined } }, { chatId: 'chat' }, () => now)
  t.after(() => failed.finish())
  failed.start(); await tick()
  const refusedCount = calls.length
  now += 30000; t.mock.timers.tick(30000); await tick()
  assert.equal(calls.length, refusedCount)
  assert.equal((await failed.finish('', 'answer')).delivered, false)
})


test('configured slower animation cadence applies to the real publisher', async t => {
  const h = rig(t, 3000)
  h.preview.start(); await tick()
  await h.advance(1500)
  assert.equal(h.calls.filter(c => c[0] === 'element').length, 0)
  await h.advance(1500)
  assert.equal(h.calls.filter(c => c[0] === 'element')[0][2].content, '思考中..')
})

test('20 simultaneous thinking cards stay below the documented progress API budgets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let now = 0, id = 0
  const frames = []
  const lark = {
    async createStreamingCard() { return `card-${++id}` },
    async sendMessage() { return `message-${id}` },
    async updateCardElement(card) { frames.push([card, now]); return true },
    async streamCardContent() { return true },
    async settleStreamingCard() { return true },
  }
  const previews = Array.from({ length: 20 }, () => new Preview(lark, { chatId: 'chat' }, () => now))
  t.after(() => Promise.all(previews.map(p => p.finish('', '正文'))))
  for (const p of previews) p.start()
  await tick()
  for (const p of previews) p.line('搜索网页', true)
  for (let i = 0; i < 600; i++) {
    now += 100; t.mock.timers.tick(100); await tick()
  }
  assert.equal(frames.length, 800, 'steady progress only, excluding creation and finalization APIs')
  for (let second = 0; second < 60; second++) {
    assert.ok(frames.filter(([, time]) => time > second * 1000 && time <= (second + 1) * 1000).length <= 20)
  }
  const count = frames.length
  await Promise.all(previews.map(p => p.finish('', '正文')))
  now += 30000; t.mock.timers.tick(30000); await tick()
  assert.equal(frames.length, count)
})
