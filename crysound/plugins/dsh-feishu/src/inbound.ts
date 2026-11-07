/** Parse external message envelopes once, preserving routing and resource keys. */
export interface InboundMention { readonly openId: string; readonly key?: string; readonly name?: string }
export interface InboundMessage {
  readonly openId: string
  readonly chatId: string
  readonly chatType: string
  readonly messageId: string
  readonly messageType: string
  readonly text: string | undefined
  readonly imageKey: string | undefined
  readonly imageKeys?: readonly string[]
  readonly fileKey?: string
  readonly fileName?: string
  readonly parentId?: string
  readonly rootId?: string
  readonly threadId?: string
  readonly mentions: readonly InboundMention[]
}
export interface ReceiveV1Payload {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string }
  message?: {
    message_id?: string; chat_id?: string; chat_type?: string; message_type?: string
    content?: string; parent_id?: string; root_id?: string; thread_id?: string
    mentions?: Array<{ key?: string; id?: { open_id?: string } | string; name?: string }>
  }
}
export function parseContent(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
  catch { return {} }
}
/** All supported rich text paragraphs; pictures are separate model inputs. */
export function postContent(value: Record<string, unknown>, mentions: readonly InboundMention[] = []): { text: string; images: string[] } {
  const post = (value.zh_cn ?? value.en_us ?? value) as Record<string, unknown>
  const images: string[] = []
  const paragraphs = typeof post.title === 'string' && post.title ? [post.title] : []
  if (Array.isArray(post.content)) for (const row of post.content) {
    if (!Array.isArray(row)) continue
    const text: string[] = []
    for (const item of row) {
      if (!item || typeof item !== 'object') continue
      if (item.tag === 'img' && typeof item.image_key === 'string') images.push(item.image_key)
      if (['text', 'a', 'md'].includes(item.tag) && typeof item.text === 'string') text.push(item.text)
      if (item.tag === 'at') {
        const mention = mentions.find(entry => entry.openId === item.user_id || entry.key === item.user_id)
        text.push(mention?.key ?? (String(item.user_id).startsWith('@_') ? item.user_id : `@${mention?.name ?? item.user_name ?? item.name ?? item.user_id ?? ''}`))
      }
    }
    paragraphs.push(text.join(''))
  }
  return { text: paragraphs.join('\n').trim(), images }
}
export function mentionText(text: string, mentions: readonly InboundMention[], botId?: string): string {
  for (const mention of mentions) if (mention.key) {
    text = text.split(mention.key).join(mention.openId === botId ? ' ' : `@${mention.name ?? mention.openId}`)
  }
  return text.trim()
}
export function parseReceiveEvent(payload: unknown): InboundMessage | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const data = payload as ReceiveV1Payload
  const message = data.message
  const openId = data.sender?.sender_id?.open_id
  if (!openId || !message?.chat_id || !message.message_id) return undefined
  const raw = message.content ?? ''
  const content = parseContent(raw)
  const mentions: InboundMention[] = []
  if (Array.isArray(message.mentions)) for (const entry of message.mentions) {
    const id = typeof entry?.id === 'string' ? entry.id : entry?.id?.open_id
    if (id) mentions.push({ openId: id, key: entry.key, name: entry.name })
  }
  const rich = message.message_type === 'post' ? postContent(content, mentions) : undefined
  const str = (key: string) => typeof content[key] === 'string' ? content[key] as string : undefined
  return {
    openId, chatId: message.chat_id, chatType: message.chat_type ?? '', messageId: message.message_id,
    messageType: message.message_type ?? '',
    text: rich?.text ?? (message.message_type === 'text' ? (str('text') ?? raw).trim() : undefined),
    imageKey: str('image_key'), imageKeys: rich?.images,
    fileKey: str('file_key'), fileName: str('file_name'),
    parentId: message.parent_id, rootId: message.root_id, threadId: message.thread_id, mentions,
  }
}
