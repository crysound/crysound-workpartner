import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeishuBot } from '../lib/bot.js'
import { Preview, TurnOutput, previewBody } from '../lib/preview.js'
import { toolProgress } from '../lib/progress.js'
import { replyChain, forwardedContent } from '../lib/resources.js'
import { preprocessCardMarkdown, markdownTableCount } from '../lib/text.js'
import { parseReceiveEvent, mentionText } from '../lib/inbound.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const message = (id = 'trigger', extra = {}) => ({ openId: 'operator', chatId: 'chat', chatType: 'p2p', messageId: id,
  messageType: 'text', text: 'hello', mentions: [], ...extra })
function harness(options = {}) {
  const calls = [], prompts = [], warnings = []
  let now = 0, bound = options.unbound ? undefined : 'session'
  const state = { lastChatId: 'chat', pairedOperators: [] }
  const lark = {
    async react(id, emoji) { calls.push(['react', id, emoji]); return `r-${id}` },
    async deleteReaction(id, reaction) { calls.push(['unreact', id, reaction]) },
    async sendMessage(target, type, content) { calls.push(['send', target, type, content]); return `out-${calls.length}` },
    async sendCard(chatId, card) { calls.push(['command', chatId, card]); return 'command' },
    async updatePreview(id, card) { calls.push(['patch', id, card]); return 'ok' },
    async patchCard(id, card) { calls.push(['fallback', id, card]); return true },
    async deleteMessage(id) { calls.push(['delete', id]); return true },
    async downloadImage(id, key) { calls.push(['download-image', id, key]); return png },
    async downloadFile(id, key) { calls.push(['download-file', id, key]); return new Uint8Array([1]) },
    async getMessages() { return undefined },
    ...options.lark,
  }
  const agent = { id: 'session', status: 'idle', followup(m) { calls.push(['inject', m]); prompts.push(m) },
    steer(m) { calls.push(['steer', m]); prompts.push(m) }, cancel(...args) { calls.push(['cancel', ...args]) } }
  const attachments = { async saveImage() { return { attachmentId: 'img', mediaType: 'image/png' } },
    async saveFile() { return { attachmentId: 'file', name: 'document.pdf', bytes: 1 } }, ...options.attachments }
  const binder = { getSessionId: () => bound, getAgent: () => bound ? agent : undefined, isReadOnlyView: () => false,
    async createNew() { calls.push(['create']); bound = 'session'; return { sessionId: bound, agent } }, ...options.binder }
  const bot = new FeishuBot({ ctx: { logger: { info() {}, debug() {}, error() {}, warn(...args) { warnings.push(args) } },
    get: key => key === 'attachments' ? attachments : undefined },
    config: { bodySegmentChars: 4000, statusIntervalMs: 30000, backgroundPush: 'off' }, lark, binder,
    store: { get: () => state, async update(patch) { Object.assign(state, patch) } }, allowlist: new Set(['operator']), now: () => now })
  const event = (type, data = {}) => bot.onSessionEvent({ id: 'session' }, { type, data, time: now })
  const consume = (index = prompts.length - 1) => event('user/message', prompts[index])
  const assistant = (text, tools = false) => event('assistant/message', { message: { content: [
    { type: 'text', text }, ...(tools ? [{ type: 'tool-call', id: 'tool', name: 'bash', arguments: '{}' }] : []) ] } })
  const end = async (kind = 'completed', extra = {}) => { event('turn/end', { reason: { kind, ...extra } }); await bot.cardChain }
  return { bot, lark, binder, agent, calls, prompts, warnings, state, event, consume, assistant, end, clock: n => { now = n } }
}

for (const type of ['text', 'image', 'file']) test(`${type}: OnIt precedes creation, download and injection; refusal clears it`, async () => {
  const h = harness({ unbound: true })
  const m = message(type, { messageType: type, imageKey: type === 'image' ? 'img' : undefined, fileKey: 'file', fileName: 'document.pdf' })
  if (type === 'text') await h.bot.handlePrompt(m, 'hello')
  else await h.bot.handleMedia(m, [])
  assert.deepEqual(h.calls[0], ['react', type, 'OnIt'])
  assert.ok(h.calls.findIndex(c => c[0] === 'create') > 0)
  assert.ok(h.calls.findIndex(c => c[0] === 'inject') > 0)
  const rejected = harness({ binder: { getAgent: () => undefined, async bind() { throw Error('unavailable') } } })
  if (type === 'text') await rejected.bot.handlePrompt(m, 'hello'); else await rejected.bot.handleMedia(m, [])
  assert.deepEqual(rejected.calls.slice(-2).map(c => c[0]), ['unreact', 'send'])
})

test('acknowledgement starts even while a previous download blocks the drain', async () => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  const h = harness({ lark: { async downloadFile() { await wait; return new Uint8Array([1]) } } })
  const envelope = (id, type, content) => ({ sender: { sender_id: { open_id: 'operator' } },
    message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: type, content: JSON.stringify(content) } })
  h.bot.enqueue(envelope('file', 'file', { file_key: 'key' }))
  await tick()
  h.bot.enqueue(envelope('next', 'text', { text: 'hello' }))
  assert.ok(h.calls.some(c => c[0] === 'react' && c[1] === 'next'))
  release(); await tick(); await tick()
})

test('normal turn: placeholder, latest patch, retract, segmented final, clear reaction; tool text stays intermediate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  await h.bot.handlePrompt(message('origin', { threadId: 'thread' }), 'hello')
  h.event('turn/start'); h.consume()
  h.event('tool/call', { callId: 't', name: 'bash', arguments: '{}' })
  h.event('tool/call', { callId: 't', name: 'bash', arguments: '{}' })
  await tick()
  h.assistant('正在检查', true)
  h.bot.onStreamFrame({ id: 'session' }, { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'secret reasoning' } })
  h.bot.onStreamFrame({ id: 'session' }, { type: 'chunk', chunk: { type: 'text-delta', text: 'final' } })
  h.clock(700); t.mock.timers.tick(700); await tick()
  assert.equal(h.calls.filter(c => c[0] === 'patch').length, 1)
  const preview = h.calls.find(c => c[0] === 'patch')[2].body.elements[0].content
  assert.equal(preview, '运行命令\n正在检查\n\nfinal\n\n...')
  h.assistant('x'.repeat(4500))
  assert.equal(h.calls.filter(c => c[0] === 'send').length, 1)
  await h.end()
  assert.deepEqual(h.calls.map(c => c[0]), ['react', 'inject', 'send', 'patch', 'delete', 'send', 'send', 'unreact'])
  for (const send of h.calls.filter(c => c[0] === 'send')) assert.equal(send[1].threadId, 'thread')
  assert.equal(h.calls.at(-2)[3].body.elements[0].content, 'x'.repeat(500))
  assert.ok(!JSON.stringify(h.calls).includes('secret reasoning'))
})

test('finish waits for an in-flight PATCH before retracting or sending final', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resolvePatch
  const h = harness({ lark: { updatePreview: () => new Promise(resolve => { resolvePatch = resolve }) } })
  await h.bot.handlePrompt(message(), 'hello'); h.event('turn/start'); h.consume()
  h.bot.onStreamFrame({ id: 'session' }, { type: 'chunk', chunk: { type: 'text-delta', text: 'writing' } })
  await tick(); h.clock(700); t.mock.timers.tick(700); await tick()
  h.assistant('done')
  const finishing = h.end()
  await tick(); assert.ok(!h.calls.some(c => c[0] === 'delete'))
  resolvePatch('ok'); await finishing
  assert.deepEqual(h.calls.slice(-3).map(c => c[0]), ['delete', 'send', 'unreact'])
  t.mock.timers.tick(2000); await tick()
  assert.equal(h.calls.at(-1)[0], 'unreact')
})

test('steer consumed mid-turn becomes DONE; steer consumed next turn becomes its origin', async () => {
  const h = harness(); await h.bot.handlePrompt(message(), 'hello')
  h.event('turn/start'); h.consume(); h.agent.status = 'running'
  await h.bot.handlePrompt(message('steer'), 'also English'); h.consume(); await tick()
  assert.deepEqual(h.calls.slice(-2), [['unreact', 'steer', 'r-steer'], ['react', 'steer', 'DONE']])
  await h.bot.handlePrompt(message('queued', { chatId: 'other' }), 'next turn')
  h.assistant('first'); await h.end()
  assert.equal(h.calls.filter(c => c[0] === 'send').at(-1)[1].chatId, 'chat')
  h.event('turn/start'); h.consume(); h.assistant('second'); await h.end()
  assert.equal(h.calls.filter(c => c[0] === 'send').at(-1)[1].chatId, 'other')
  assert.deepEqual(h.calls.at(-1), ['unreact', 'queued', 'r-queued'])
})

test('switching sessions clears unread steer and buffered image reactions without DONE', async () => {
  const h = harness(); h.agent.status = 'running'
  await h.bot.handlePrompt(message('steer'), 'hello')
  await h.bot.acknowledge(message('picture', { messageType: 'image' }))
  h.bot.bufferImage(message('picture', { messageType: 'image', imageKey: 'img' }))
  await h.bot.closeCardAsDetached()
  assert.deepEqual(h.calls.filter(c => c[0] === 'unreact').map(c => c[1]), ['steer', 'picture'])
  assert.ok(!h.calls.some(c => c[2] === 'DONE'))
})

test('stop cancels immediately including children/btw; end sends only stop text and cleans preview', async () => {
  const h = harness(); await h.bot.handlePrompt(message(), 'hello'); h.event('turn/start'); h.consume()
  h.bot.onStreamFrame({ id: 'session' }, { type: 'chunk', chunk: { type: 'text-delta', text: 'writing' } }); await tick()
  h.agent.status = 'running'
  let children = 0, btw = 0
  h.bot.ctx.agents = { get: () => ({ cancel() { children++ } }) }
  h.bot.btw.cancelAll = () => { btw++ }
  h.bot.runState.subagents.set('child', { childId: 'child' })
  await h.bot.handleStop()
  assert.equal(children, 1); assert.equal(btw, 1)
  assert.ok(!h.calls.some(c => c[0] === 'command'))
  await h.end('aborted')
  assert.equal(h.calls.filter(c => c[0] === 'send').at(-1)[3].body.elements[0].content, '⏹ 执行已停止。')
  assert.deepEqual(h.calls.slice(-3).map(c => c[0]), ['delete', 'send', 'unreact'])
})

for (const [reason, expected] of [['error', '❌ 错误: model failed'], ['aborted', '⏹ 执行已停止。'],
  ['max-tokens', 'answer\n⚠️ 达到长度上限'], ['blocked', 'answer\n🚫 被拦截']]) test(`end reason ${reason} sends a body without status header`, async () => {
  const h = harness(); h.event('turn/start'); h.assistant('answer'); await h.end(reason, { error: { message: 'model failed' } })
  const card = h.calls.at(-1)[3]; assert.equal(card.header, undefined); assert.equal(card.body.elements[0].content, expected)
})

test('expired-session error, empty response, web-originated turn and final fallback candidate', async () => {
  const h = harness(); h.event('turn/start'); h.assistant('intermediate', true); await h.end()
  assert.equal(h.calls.at(-1)[3].body.elements[0].content, 'intermediate')
  h.event('turn/start'); await h.end(); assert.equal(h.calls.at(-1)[3].body.elements[0].content, '(空响应)')
  h.event('turn/start'); await h.end('error', { error: { message: 'Session not found' } })
  assert.match(h.calls.at(-1)[3].body.elements[0].content, /会话已过期/)
  assert.ok(h.calls.every(c => c[0] === 'send'))
})

test('retraction refusal updates preview with first final segment; card send failure retries then uses text', async () => {
  const h = harness({ lark: { async deleteMessage(id) { h.calls.push(['delete', id]); return false } } })
  await h.bot.handlePrompt(message(), 'hello'); h.event('turn/start'); h.consume()
  h.bot.onStreamFrame({ id: 'session' }, { type: 'chunk', chunk: { type: 'text-delta', text: 'writing' } }); await tick()
  h.assistant('answer'); await h.end()
  assert.deepEqual(h.calls.slice(-3).map(c => c[0]), ['delete', 'fallback', 'unreact'])
  assert.equal(h.calls.at(-2)[2].body.elements[0].content, 'answer')
  const failures = harness({ lark: { async sendMessage(target, type, content) { failures.calls.push(['attempt', type, content]); return type === 'text' ? 'ok' : undefined } } })
  await failures.bot.sendFinal({ chatId: 'chat' }, 'x'.repeat(4500))
  assert.deepEqual(failures.calls.map(c => c[1]), ['interactive', 'interactive', 'text', 'text'])
})

test('800ms image debounce resets and text/post joins all images into one user message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const type of ['text', 'post']) {
    const h = harness()
    for (let i = 0; i < 3; i++) { await h.bot.process(message(`img${i}`, { messageType: 'image', imageKey: `key${i}` })); t.mock.timers.tick(500) }
    assert.equal(h.prompts.length, 0)
    await h.bot.process(message('caption', { messageType: type, text: 'compare' }))
    assert.deepEqual(h.prompts[0].content.map(c => c.type), ['image', 'image', 'image', 'text'])
    h.event('turn/start'); h.consume(); h.assistant('compared'); await h.end()
    assert.deepEqual(h.calls.filter(c => c[0] === 'unreact').map(c => c[1]), ['img0', 'img1', 'img2', 'caption'])
    t.mock.timers.tick(800); await tick(); assert.equal(h.prompts.length, 1)
  }
})

test('image-only batches flush after 800ms; file limits and failed downloads clean OnIt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(); await h.bot.process(message('pic', { messageType: 'image', imageKey: 'key' }))
  t.mock.timers.tick(799); await tick(); assert.equal(h.prompts.length, 0)
  t.mock.timers.tick(1); await tick(); assert.equal(h.prompts.length, 1)
  for (const failure of [undefined, 'limit']) {
    const f = harness({ lark: { async downloadFile() { return failure ? new Uint8Array([1]) : undefined } },
      attachments: { async saveFile() { throw Error('size limit') } } })
    await f.bot.handleMedia(message('file', { messageType: 'file', fileKey: 'key' }), [])
    assert.equal(f.calls.at(-2)[0], 'unreact')
    assert.equal(f.calls.at(-1)[3].body.elements[0].content, failure ? '文件超过大小上限，无法发给伙伴。' : '文件下载失败，请重发一次。')
  }
})

test('post parsing, named mentions and reply routing preserve the user content', () => {
  const parsed = parseReceiveEvent({ sender: { sender_id: { open_id: 'operator' } }, message: {
    message_id: 'm', chat_id: 'chat', message_type: 'post', thread_id: 'thread', parent_id: 'parent', root_id: 'root',
    content: JSON.stringify({ zh_cn: { title: 'Title', content: [[{ tag: 'text', text: 'bold' }, { tag: 'img', image_key: 'img' }], [{ tag: 'a', text: 'link' }, { tag: 'at', user_name: '同事' }]] } }),
  } })
  assert.equal(parsed.text, 'Title\nbold\nlink@同事'); assert.deepEqual(parsed.imageKeys, ['img'])
  assert.equal(parsed.threadId, 'thread'); assert.equal(parsed.parentId, 'parent'); assert.equal(parsed.rootId, 'root')
  assert.equal(mentionText('@_1 hello @_2', [{ key: '@_1', openId: 'bot' }, { key: '@_2', openId: 'peer', name: '同事' }], 'bot'), 'hello @同事')
})

test('single/multi-level quotes, quote permission degradation, forwarded tree with images', async () => {
  const parent = { message_id: 'parent', msg_type: 'text', body: { content: '{"text":"quoted"}' }, sender: { sender_type: 'app' } }
  const lark = { async getMessages() { return [parent] } }
  assert.equal((await replyChain(lark, 'parent')).text, '[Quoted message from 伙伴]:\nquoted\n\n')
  const child = { message_id: 'child', parent_id: 'parent', msg_type: 'image', body: { content: '{"image_key":"img"}' } }
  lark.getMessages = async id => [id === 'child' ? child : parent]
  const multi = await replyChain(lark, 'child')
  assert.equal(multi.text, '--- Reply chain (2 messages) ---\n[1] 伙伴 (assistant):\nquoted\n\n[2] 用户 (user):\n\n\n---\n\n')
  assert.deepEqual(multi.images, [{ messageId: 'child', key: 'img' }])
  assert.equal(await replyChain({ async getMessages() {} }, 'parent'), undefined)
  const forward = await forwardedContent({ async getMessages() { return [
    { message_id: 'root', msg_type: 'merge_forward' }, { ...parent, upper_message_id: 'root', create_time: '0' },
    { ...child, upper_message_id: 'root', create_time: '0' } ] } }, 'root')
  assert.match(forward.text, /<forwarded_messages>\n\[1970-01-01 08:00:00\] 伙伴:/)
  assert.equal(forward.images.length, 1)
})

test('progress summaries filter secret labels, basenames, commands, hosts, and actual dsh tool names', () => {
  for (const path of ['.env', 'my-secret.txt', 'a'.repeat(24), 'bad name', 'id_rsa']) assert.equal(toolProgress('read', { path }), '读取文件')
  assert.equal(toolProgress('read', { path: '/workspace/README.md' }), '读取文件 README.md')
  assert.equal(toolProgress('bash', { command: 'secret command' }), '运行命令')
  assert.equal(toolProgress('web_fetch', { url: 'https://example.com/secret?token=private' }), '读取网页 example.com')
  assert.equal(toolProgress('skill', { name: 'design' }), '加载技能 design')
  assert.equal(toolProgress('mcp__calendar__list', {}), '调用工具 calendar')
  assert.equal(toolProgress('edit', { description: '修改配置\n完成' }), '修改配置 完成')
})

test('preview bounds and fence marker; substantive content survives retraction', () => {
  assert.equal(previewBody([], 'code```js\nx '), 'code```js\nx\n```\n\n...')
  assert.match(previewBody(['x'.repeat(2000), 'y'.repeat(2000), 'z'.repeat(2000), 'w'.repeat(2000)], ''), /^…（前 1 条已折叠）/)
  assert.equal(previewBody([], 'x'.repeat(8001)), undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(previewBody(['\\'.repeat(10000)], '')))) <= 20000)
  const output = new TurnOutput(); output.assistant('x'.repeat(400), true); output.assistant('short', true); output.assistant('answer', false)
  assert.equal(output.body(), `（中途内容）\n\n${'x'.repeat(400)}\n\nanswer`)
  output.assistant('x'.repeat(400), false); assert.equal(output.body(), 'x'.repeat(400))
})

test('Markdown preprocessing and table post fallback ignore fenced tables', async () => {
  const table = '| a | b |\n|---|---|\n| 1 | 2 |'
  assert.equal(preprocessCardMarkdown('# Title\n## Sub\n[local](file:///a)\n![pic](https://a)\n![ok](img_key)\n\n\nend'),
    '#### Title\n##### Sub\nlocal (file:///a)\n\n![ok](img_key)\n\nend')
  assert.equal(preprocessCardMarkdown('hi```js\n# code\n```'), 'hi\n```js\n# code\n```')
  assert.ok(preprocessCardMarkdown(Array(4).fill(table).join('\n\n')).includes(`\x60\x60\x60\n${table}\n\x60\x60\x60`))
  assert.equal(markdownTableCount(`\x60\x60\x60\n${table}\n\x60\x60\x60`), 0)
  const h = harness(); await h.bot.sendFinal({ chatId: 'chat' }, Array(6).fill(table).join('\n\n'))
  assert.equal(h.calls[0][2], 'post'); assert.ok(h.calls[0][3].zh_cn)
})

test('failure before user/message commit still clears the triggering OnIt', async () => {
  const h = harness(); await h.bot.handlePrompt(message(), 'hello')
  h.event('turn/start'); await h.end('error', { error: { message: 'prepare failed' } })
  assert.equal(h.calls.at(-2)[3].body.elements[0].content, '❌ 错误: prepare failed')
  assert.deepEqual(h.calls.at(-1), ['unreact', 'trigger', 'r-trigger'])
  assert.equal(h.bot.pendingPrompts.size, 0)
})

test('text, image and file acknowledgement precedes cold session restoration', async () => {
  for (const type of ['text', 'image', 'file']) {
    let live
    const h = harness({ binder: { getAgent: () => live, async bind() { h.calls.push(['restore']); live = h.agent; return { agent: live } } } })
    const m = message(type, { messageType: type, imageKey: type === 'image' ? 'img' : undefined, fileKey: 'file' })
    if (type === 'text') await h.bot.handlePrompt(m, 'hello'); else await h.bot.handleMedia(m, [])
    assert.deepEqual(h.calls[0], ['react', type, 'OnIt'])
    assert.ok(h.calls.findIndex(c => c[0] === 'restore') > 0)
    assert.ok(h.calls.findIndex(c => c[0] === 'inject') > h.calls.findIndex(c => c[0] === 'restore'))
  }
})

test('permission-denied quote image uses only own text; forwarded retrieval failure has the prescribed reply', async () => {
  const h = harness({ lark: { async getMessages() { return [{ message_id: 'parent', msg_type: 'image', body: { content: '{"image_key":"img"}' } }] },
    async downloadImage() {} } })
  await h.bot.handleMedia(message('quote', { parentId: 'parent', text: 'own text' }), [])
  assert.deepEqual(h.prompts[0].content, [{ type: 'text', text: 'own text' }])
  const f = harness()
  await f.bot.handleMedia(message('forward', { messageType: 'merge_forward' }), [])
  assert.deepEqual(f.calls.at(-2), ['unreact', 'forward', 'r-forward'])
  assert.equal(f.calls.at(-1)[3].body.elements[0].content, '合并转发的内容读取失败，请把内容直接发过来。')
})

test('denied preview update stops later updates; limit skips only that frame', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const result of ['failed', 'limited']) {
    let now = 0, patches = 0
    const h = harness({ lark: { async updatePreview() { patches++; return result } } })
    const preview = new Preview(h.lark, { chatId: 'chat' }, () => now)
    preview.delta('first'); await tick(); now = 700; t.mock.timers.tick(700); await tick()
    preview.delta('next'); now = 1400; t.mock.timers.tick(700); await tick()
    assert.equal(patches, result === 'failed' ? 1 : 2)
    await preview.finish()
  }
})

test('white list and group mention gate stay silent for strangers and unaddressed groups', async () => {
  const h = harness()
  await h.bot.process(message('stranger', { openId: 'stranger' }))
  await h.bot.process(message('group', { chatType: 'group' }))
  assert.deepEqual(h.calls, [])
  h.bot.botOpenId = 'bot'
  await h.bot.process(message('addressed', { chatType: 'group', text: '@_bot ask @_peer', mentions: [
    { openId: 'bot', key: '@_bot' }, { openId: 'peer', key: '@_peer', name: '同事' } ] }))
  assert.equal(h.prompts[0].content[0].text, 'ask @同事')
})

test('image arrival debounce and caption merging still work while an earlier file download blocks drain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const wait = new Promise(resolve => { release = resolve })
  const h = harness({ lark: { async downloadFile() { await wait; return new Uint8Array([1]) } } })
  const envelope = (id, type, content) => ({ sender: { sender_id: { open_id: 'operator' } }, message: {
    message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: type, content: JSON.stringify(content) } })
  h.bot.enqueue(envelope('file', 'file', { file_key: 'key' })); await tick()
  h.bot.enqueue(envelope('img1', 'image', { image_key: 'a' })); t.mock.timers.tick(500)
  h.bot.enqueue(envelope('img2', 'image', { image_key: 'b' })); t.mock.timers.tick(500)
  h.bot.enqueue(envelope('caption', 'text', { text: 'compare' })); t.mock.timers.tick(800)
  release(); await tick(); await tick()
  assert.equal(h.prompts.length, 2)
  assert.deepEqual(h.prompts[1].content.map(c => c.type), ['image', 'image', 'text'])
  assert.equal(h.prompts[1].content.at(-1).text, 'compare')
})

test('rich post at nodes use mention keys so the bot mention disappears but colleagues keep names', () => {
  const parsed = parseReceiveEvent({ sender: { sender_id: { open_id: 'operator' } }, message: {
    message_id: 'm', chat_id: 'chat', message_type: 'post', mentions: [
      { id: { open_id: 'bot' }, key: '@_bot', name: '伙伴' }, { id: { open_id: 'peer' }, key: '@_peer', name: '同事' } ],
    content: JSON.stringify({ content: [[{ tag: 'at', user_id: 'bot' }, { tag: 'text', text: ' ask ' }, { tag: 'at', user_id: '@_peer' }]] }),
  } })
  assert.equal(mentionText(parsed.text, parsed.mentions, 'bot'), 'ask @同事')
})
