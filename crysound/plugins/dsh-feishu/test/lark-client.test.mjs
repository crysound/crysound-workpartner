import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeSdkLogger, FeishuApiError, LarkClient, requestFeishu } from '../lib/lark-client.js'

test('warn matching "no <event> handler" downgrades to debug', () => {
  const entries = []
  const logger = bridgeSdkLogger((level, message) => entries.push([level, message]))
  logger.warn('no im.message.message_read_v1 handler')
  logger.warn('  no im.message.reaction.created_v1 handle ')
  assert.deepEqual(entries, [
    ['debug', 'no im.message.message_read_v1 handler'],
    ['debug', '  no im.message.reaction.created_v1 handle '],
  ])
})

test('warn called with the LoggerProxy array shape still matches and downgrades', () => {
  // The SDK's LoggerProxy forwards its collected args as ONE ARRAY — the
  // flatten step must unwrap that layer or every match fails behind a
  // JSON `["…"]` wrapper.
  const entries = []
  const logger = bridgeSdkLogger((level, message) => entries.push([level, message]))
  logger.warn(['no im.message.message_read_v1 handler'])
  logger.warn(['no im.message.reaction.created_v1 handle'])
  // Real warnings in the same shape pass through at warn severity.
  logger.warn(['websocket connection lost, reconnecting'])
  assert.deepEqual(entries, [
    ['debug', 'no im.message.message_read_v1 handler'],
    ['debug', 'no im.message.reaction.created_v1 handle'],
    ['warn', 'websocket connection lost, reconnecting'],
  ])
})

test('real SDK warnings and errors keep their severity and content', () => {
  const entries = []
  const logger = bridgeSdkLogger((level, message) => entries.push([level, message]))
  logger.warn('websocket connection lost, reconnecting')
  logger.error('send message failed:', { code: 99991663 })
  logger.info('token refreshed')
  assert.deepEqual(entries, [
    ['warn', 'websocket connection lost, reconnecting'],
    ['error', 'send message failed: {"code":99991663}'],
    ['debug', 'token refreshed'],
  ])
})

test('no-handler downgrade is case-insensitive and rejects near misses', () => {
  const levels = []
  const logger = bridgeSdkLogger(level => levels.push(level))
  logger.warn('NO im.message.message_read_v1 HANDLER')
  logger.warn('no handler for event') // not the dispatcher's notice format
  assert.deepEqual(levels, ['debug', 'warn'])
})

// ------------------------------------------------- requestFeishu (P1 wrapper) --

/** Instant fake timer recording the requested backoff delays. */
function fakeSleep() {
  const delays = []
  return {
    delays,
    sleep: async ms => { delays.push(ms) },
  }
}

test('requestFeishu throws FeishuApiError on a fulfilled non-zero-code body', async () => {
  const { delays, sleep } = fakeSleep()
  await assert.rejects(
    requestFeishu(async () => ({ code: 99991663, msg: 'forbidden', data: {} }), { sleep }),
    error => {
      assert.ok(error instanceof FeishuApiError)
      assert.equal(error.feishuCode, 99991663)
      assert.equal(error.msg, 'forbidden')
      assert.match(error.message, /code=99991663/)
      return true
    },
  )
  // A plain business error is not rate-limited — no retry attempted.
  assert.deepEqual(delays, [])
})

test('requestFeishu passes a zero-code response through untouched', async () => {
  const result = await requestFeishu(async () => ({ code: 0, data: { message_id: 'om_1' } }))
  assert.deepEqual(result, { code: 0, data: { message_id: 'om_1' } })
})

test('requestFeishu retries HTTP 429 with backoff and then succeeds', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  const result = await requestFeishu(async () => {
    calls++
    if (calls === 1) throw Object.assign(new Error('rate limited'), { response: { status: 429 } })
    return { code: 0, data: { ok: true } }
  }, { sleep })
  assert.deepEqual(result, { code: 0, data: { ok: true } })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [500]) // exponential backoff base
})

test('requestFeishu retries a fulfilled rate-limit code body (11232)', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  const result = await requestFeishu(async () => {
    calls++
    if (calls === 1) return { code: 11232, msg: 'too many requests' }
    return { code: 0, data: {} }
  }, { sleep })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [500])
  assert.deepEqual(result, { code: 0, data: {} })
})

test('requestFeishu gives up after the retry budget under sustained limiting', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  await assert.rejects(
    requestFeishu(async () => {
      calls++
      throw Object.assign(new Error('rate limited'), { response: { status: 429, data: { code: 230020 } } })
    }, { sleep }),
    // The original transport-shaped error propagates, not a wrapped one.
    error => error.message === 'rate limited',
  )
  assert.equal(calls, 3) // initial attempt + maxRetries=2
  assert.deepEqual(delays, [500, 1000]) // exponential schedule
})

test('requestFeishu does not retry non-rate-limit errors', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  await assert.rejects(
    requestFeishu(async () => {
      calls++
      throw new Error('socket hang up')
    }, { sleep }),
    /socket hang up/,
  )
  assert.equal(calls, 1)
  assert.deepEqual(delays, [])
})

// ------------------------------------------------------- LarkClient.patchCard --

test('patchCard returns false when Feishu fulfills with a business error body', async () => {
  const errors = []
  const client = new LarkClient({
    appId: 'cli_test',
    appSecret: 'secret',
    domain: 'feishu',
    onError: (what, error) => errors.push([what, error]),
    sleep: async () => {},
  })
  // Test seam: replace the SDK transport method with one that FULFILLS an
  // error envelope — the historical bug was patchCard returning true here,
  // silently lying to finalizeTurn's fallback resend chain.
  ;(client.client.im.message).patch = async () => ({ code: 99991663, msg: 'forbidden' })
  const card = { config: { wide_screen_mode: true }, elements: [] }
  const ok = await client.patchCard('om_1', card)
  assert.equal(ok, false)
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], 'patch-card')
  assert.ok(errors[0][1] instanceof FeishuApiError)
  assert.equal(errors[0][1].feishuCode, 99991663)
})

test('patchCard returns true on a zero-code success body', async () => {
  const errors = []
  const client = new LarkClient({
    appId: 'cli_test',
    appSecret: 'secret',
    domain: 'feishu',
    onError: (what, error) => errors.push([what, error]),
    sleep: async () => {},
  })
  ;(client.client.im.message).patch = async () => ({ code: 0 })
  const card = { config: { wide_screen_mode: true }, elements: [] }
  assert.equal(await client.patchCard('om_1', card), true)
  assert.deepEqual(errors, [])
})

test('reaction IDs, deletion, raw-card fetching, and thread replies use the intended API shape', async () => {
  const client = new LarkClient({ appId: 'test', appSecret: 'test', domain: 'feishu', sleep: async () => {} })
  const calls = []
  client.client.im.messageReaction.create = async args => { calls.push(['react', args]); return { code: 0, data: { reaction_id: 'r' } } }
  client.client.im.messageReaction.delete = async args => { calls.push(['unreact', args]); return { code: 0 } }
  client.client.im.message.reply = async args => { calls.push(['reply', args]); return { code: 0, data: { message_id: 'reply' } } }
  client.client.im.message.create = async args => { calls.push(['send', args]); return { code: 0, data: { message_id: 'send' } } }
  client.client.request = async args => { calls.push(['get', args]); return { code: 0, data: { items: [{ message_id: 'm' }] } } }
  assert.equal(await client.react('m', 'OnIt'), 'r')
  await client.deleteReaction('m', 'r')
  await client.sendMessage({ chatId: 'chat', threadId: 'thread', messageId: 'm' }, 'text', { text: 'body' })
  await client.sendMessage({ chatId: 'chat', messageId: 'm' }, 'text', { text: 'body' })
  assert.equal((await client.getMessages('m'))[0].message_id, 'm')
  assert.deepEqual(calls[0][1].data, { reaction_type: { emoji_type: 'OnIt' } })
  assert.deepEqual(calls[1][1].path, { message_id: 'm', reaction_id: 'r' })
  assert.equal(calls[2][1].data.reply_in_thread, true)
  assert.equal(calls[2][1].path.message_id, 'm')
  assert.equal(calls[3][1].data.receive_id, 'chat')
  assert.equal(calls[4][1].params.card_msg_content_type, 'raw_card_content')
})

test('preview limits skip the frame without retry; denied capabilities warn once; failed reactions log debug', async () => {
  const errors = [], logs = [], sleeps = []
  const client = new LarkClient({ appId: 'test', appSecret: 'test', domain: 'feishu', sleep: async ms => sleeps.push(ms),
    onError: what => errors.push(what), onLog: level => logs.push(level) })
  client.client.im.message.patch = async () => ({ code: 230020, msg: 'rate limited' })
  assert.equal(await client.updatePreview('m', {}), 'limited')
  assert.deepEqual(sleeps, [])
  client.client.request = async () => ({ code: 99991672, msg: 'scope denied' })
  assert.equal(await client.createStreamingCard('a'), undefined)
  assert.equal(await client.createStreamingCard('b'), undefined)
  assert.deepEqual(errors, ['cardkit-create'])
  client.client.im.messageReaction.create = async () => ({ code: 99991672, msg: 'scope denied' })
  assert.equal(await client.react('m', 'OnIt'), undefined)
  assert.deepEqual(logs, ['debug'])
  assert.deepEqual(errors, ['cardkit-create'])
})

test('CardKit creates streaming JSON 2.0, sends card_id into threads, streams and closes before replacement', async () => {
  const client = new LarkClient({ appId: 'test', appSecret: 'test', domain: 'feishu' })
  const calls = []
  client.client.request = async args => { calls.push(args); return { code: 0, data: { card_id: 'card' } } }
  client.client.im.message.reply = async args => { calls.push(args); return { code: 0, data: { message_id: 'message' } } }
  assert.equal(await client.createStreamingCard('unique_element', 'progress_element'), 'card')
  const initial = JSON.parse(calls[0].data.data)
  assert.equal(initial.config.streaming_mode, true)
  assert.equal(initial.config.summary.content, '思考中…')
  assert.deepEqual(initial.config.streaming_config, { print_frequency_ms: { default: 40, android: 40, ios: 40, pc: 40 }, print_step: { default: 6, android: 6, ios: 6, pc: 6 }, print_strategy: 'fast' })
  assert.equal(initial.body.elements[0].element_id, 'unique_element')
  assert.equal(initial.body.elements[0].content, '')
  assert.equal(initial.body.elements[1].element_id, 'progress_element')
  assert.equal(initial.body.elements[1].content, '思考中.')
  await client.sendMessage({ chatId: 'chat', messageId: 'origin', threadId: 'thread' }, 'interactive', { type: 'card', data: { card_id: 'card' } })
  assert.deepEqual(JSON.parse(calls[1].data.content), { type: 'card', data: { card_id: 'card' } })
  assert.equal(calls[1].data.reply_in_thread, true)
  assert.equal(await client.streamCardContent('card', 'unique_element', '完整文本', 1), true)
  const card = { schema: '2.0', config: { width_mode: 'fill' }, body: { elements: [{ tag: 'markdown', content: '已完成' }] } }
  assert.equal(await client.settleStreamingCard('card', 2, card), true)
  assert.deepEqual(calls.slice(2).map(c => [c.method, c.data.sequence]), [['PUT', 1], ['PATCH', 2], ['PUT', 3]])
  assert.equal(calls[2].url, '/open-apis/cardkit/v1/cards/card/elements/unique_element/content')
  assert.equal(calls[2].data.content, '完整文本')
  assert.equal(JSON.parse(calls[3].data.settings).config.streaming_mode, false)
  assert.deepEqual(JSON.parse(calls[4].data.card.data), card)
})

for (const code of [300309, 99991672]) test(`CardKit code ${code} reports fallback without retry or swallowed success`, async () => {
  const client = new LarkClient({ appId: 'test', appSecret: 'test', domain: 'feishu' })
  const calls = []
  client.client.request = async args => { calls.push(args); return { code, msg: 'denied or closed' } }
  assert.equal(await client.streamCardContent('card', 'element', 'text', 1), false)
  assert.equal(await client.settleStreamingCard('card', 2, {}), false)
  assert.deepEqual(calls.map(c => c.data.sequence), [1, 2, 3])
})


test('progress and new answer rounds use non-typing element replacement', async () => {
  const client = new LarkClient({ appId: 'test', appSecret: 'test', domain: 'feishu' })
  const calls = []
  client.client.request = async args => { calls.push(args); return { code: 0 } }
  const element = { tag: 'markdown', element_id: 'progress', content: '已执行 6 步' }
  assert.equal(await client.updateCardElement('card', 'progress', element, 1), true)
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].url, '/open-apis/cardkit/v1/cards/card/elements/progress')
  assert.deepEqual(calls[0].data, { element: JSON.stringify(element), sequence: 1 })
  client.client.request = async () => ({ code: 300309, msg: 'closed' })
  assert.equal(await client.updateCardElement('card', 'progress', element, 2), false)
})


test('CardKit creation includes the turn note and no elapsed seconds', async () => {
  const client = new LarkClient({ appId: 'test', appSecret: 'test', domain: 'feishu' })
  let card
  client.client.request = async args => { card = JSON.parse(args.data.data); return { code: 0, data: { card_id: 'card' } } }
  await client.createStreamingCard('body', 'progress', '已新开会话\n思考中.')
  assert.equal(card.body.elements[1].content, '已新开会话\n思考中.')
  assert.equal(card.body.elements[0].content, '')
})
