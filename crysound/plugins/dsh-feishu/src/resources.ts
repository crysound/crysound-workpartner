import { parseContent, postContent } from './inbound.ts'
import type { FetchedMessage, LarkGateway } from './lark-client.ts'

export interface ResourceImage { messageId: string; key: string }
interface MessageContent { text: string; images: ResourceImage[] }
/** No directory lookup: sender labels deliberately expose only the role. */
export function senderLabel(message: FetchedMessage): string {
  return message.sender?.sender_type === 'app' ? '伙伴' : '用户'
}
function cardText(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(cardText)
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'string' && ['title', 'text', 'content'].includes(key) ? [child] : cardText(child))
}
export function fetchedContent(message: FetchedMessage): MessageContent {
  const value = parseContent(message.body?.content ?? '')
  const rich = message.msg_type === 'post' ? postContent(value) : undefined
  const keys = rich?.images ?? (message.msg_type === 'image' && typeof value.image_key === 'string' ? [value.image_key] : [])
  let text: string
  switch (message.msg_type) {
    case 'text': text = typeof value.text === 'string' ? value.text : ''; break
    case 'post': text = rich?.text ?? ''; break
    case 'image': text = ''; break
    case 'file': text = `[文件: ${typeof value.file_name === 'string' ? value.file_name : '文件'}]`; break
    case 'interactive': text = cardText(value).join('\n'); break
    default: text = `[${message.msg_type}]`
  }
  return { text, images: keys.map(key => ({ messageId: message.message_id, key })) }
}
export async function replyChain(lark: LarkGateway, parentId: string): Promise<MessageContent | undefined> {
  const chain: FetchedMessage[] = []
  const seen = new Set<string>()
  let id: string | undefined = parentId
  while (id && chain.length < 5 && !seen.has(id)) {
    seen.add(id)
    const items = await lark.getMessages(id)
    const message = items?.find(item => item.message_id === id)
    if (!message) return undefined // permission failure: inject only the user's own content
    chain.push(message)
    id = message.parent_id
  }
  chain.reverse()
  const images = chain.flatMap(message => fetchedContent(message).images)
  if (chain.length === 1) return { text: `[Quoted message from ${senderLabel(chain[0]!)}]:\n${fetchedContent(chain[0]!).text}\n\n`, images }
  return {
    text: `--- Reply chain (${chain.length} messages) ---\n${chain.map((message, i) =>
      `[${i + 1}] ${senderLabel(message)} (${message.sender?.sender_type === 'app' ? 'assistant' : 'user'}):\n${fetchedContent(message).text}\n\n`).join('')}---\n\n`, images,
  }
}
function beijingTime(timestamp?: string): string {
  const time = Number(timestamp)
  if (!Number.isFinite(time)) return ''
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
}
export async function forwardedContent(lark: LarkGateway, messageId: string): Promise<MessageContent | undefined> {
  const items = await lark.getMessages(messageId)
  if (!items?.length) return undefined
  const rows: string[] = []
  const images: ResourceImage[] = []
  const seen = new Set<string>()
  let failed = false
  const visit = async (message: FetchedMessage, depth: number): Promise<void> => {
    if (depth > 10 || seen.has(message.message_id)) return
    seen.add(message.message_id)
    if (message.msg_type === 'merge_forward') {
      // Some responses inline the whole tree; others need a nested GET.
      let children = items.filter(item => item.upper_message_id === message.message_id)
      if (!children.length && message.message_id !== messageId) {
        const fetched = await lark.getMessages(message.message_id)
        if (!fetched) { failed = true; return }
        children = fetched
      }
      for (const child of children) await visit(child, depth + 1)
      return
    }
    const content = fetchedContent(message)
    rows.push(`[${beijingTime(message.create_time)}] ${senderLabel(message)}:\n    ${content.text.replace(/\n/g, '\n    ')}`)
    images.push(...content.images)
    for (const child of items.filter(item => item.upper_message_id === message.message_id)) await visit(child, depth + 1)
  }
  const ids = new Set(items.map(item => item.message_id))
  for (const item of items.filter(item => !item.upper_message_id || !ids.has(item.upper_message_id))) await visit(item, 1)
  if (failed || (!rows.length && !images.length)) return undefined
  return { text: `<forwarded_messages>\n${rows.join('\n')}\n</forwarded_messages>`, images }
}
