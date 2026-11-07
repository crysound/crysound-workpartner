import { randomBytes } from 'node:crypto'
import { buildBodyCard, type Schema2Card } from './card.ts'
import { closeOpenFence } from './text.ts'
import type { LarkGateway, MessageTarget } from './lark-client.ts'

export const PREVIEW_INTERVAL_MS = 250

/** Delivery outcome for the final card; failed or clipped cards need a separate body. */
export interface PreviewResult {
  readonly delivered: boolean
  readonly overflow: boolean
  readonly elapsedMs: number
}

/** Keep ample room below Feishu's 30 KB card limit, including nested JSON encoding. */
function finalCard(body: string, footer: string) {
  const make = (text: string): Schema2Card => ({
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: { elements: [
      { tag: 'markdown', content: text },
      ...(footer ? [{ tag: 'markdown', content: footer, text_size: 'notation' }] : []),
    ] },
  })
  const fits = (text: string) => text.length <= 8000
    && Buffer.byteLength(JSON.stringify(JSON.stringify(make(text)))) <= 28000
  if (fits(body)) return { card: make(body), overflow: false }
  const suffix = '\n\n全文见下条'
  let prefix = Array.from(body).slice(0, 8000).join('')
  while (!fits(closeOpenFence(prefix) + suffix)) prefix = Array.from(prefix).slice(0, -200).join('')
  return { card: make(closeOpenFence(prefix) + suffix), overflow: true }
}
const FALLBACK_INTERVAL_MS = 700
export function previewBody(lines: readonly string[], paragraph: string, streaming = false): string | undefined {
  const rows = lines.flatMap(line => line.match(/[\s\S]{1,2000}/g) ?? [])
  if (!streaming) paragraph = paragraph.split('\n').map(line => (line.match(/[\s\S]{1,2000}/g) ?? ['']).join('\n')).join('\n')
  let folded = 0
  for (;;) {
    const parts = [...(folded ? [`…（前 ${folded} 条已折叠）`] : []), ...rows]
    let body = [parts.join('\n'), paragraph].filter(Boolean).join('\n\n')
    if (!streaming) body = body.trimEnd()
    if (!streaming && (body.match(/```/g)?.length ?? 0) % 2) body += '\n```'
    if (!streaming) body += '\n\n...'
    if (body.length <= 8000 && Buffer.byteLength(JSON.stringify(JSON.stringify(body))) <= 20000) return body
    if (!rows.length) return undefined
    rows.shift()
    folded++
  }
}

/** One turn owns one publisher, timer and in-flight PATCH; finish drains it. */
export class Preview {
  private lines: string[] = []
  private paragraph = ''
  private messageId: string | undefined
  private cardId: string | undefined
  private readonly elementId = 'p' + randomBytes(9).toString('hex')
  private sequence = 0
  private readonly startedAt: number
  private readonly intervalMs: number
  private lastBody: string | undefined
  private lastSent = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private flight: Promise<void> | undefined
  private finishFlight: Promise<PreviewResult> | undefined
  private stopped = false
  private disabled = false
  private readonly lark: LarkGateway
  private readonly target: MessageTarget
  private readonly now: () => number
  constructor(lark: LarkGateway, target: MessageTarget, now: () => number = Date.now, intervalMs = PREVIEW_INTERVAL_MS) {
    this.lark = lark; this.target = target; this.now = now
    this.startedAt = now(); this.intervalMs = intervalMs
  }

  /** Start once, before any model output; subsequent content reuses this publisher. */
  start(): void {
    if (this.stopped || this.disabled || this.messageId || this.flight) return
    this.flight = this.publish('').finally(() => { this.flight = undefined; this.schedule() })
  }

  line(text: string): void { if (text) { this.lines.push(text); this.schedule() } }
  delta(text: string): void { if (text) { this.paragraph += text; this.schedule() } }
  settled(text = '', hasTools = true): void {
    this.paragraph = hasTools ? '' : text
    if (!hasTools) this.lines = []
    this.schedule()
  }

  private schedule(): void {
    if (this.stopped || this.disabled || this.flight || this.timer) return
    const body = previewBody(this.lines, this.paragraph, this.cardId !== undefined)
    if (!body || body === this.lastBody || (!this.lines.length && !this.paragraph)) return
    const delay = (this.cardId ? this.intervalMs : Math.max(FALLBACK_INTERVAL_MS, this.intervalMs)) - (this.now() - this.lastSent)
    if (delay > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.schedule() }, delay)
      this.timer.unref?.()
      return
    }
    this.flight = this.publish(body).finally(() => { this.flight = undefined; this.schedule() })
  }
  private async publish(body: string): Promise<void> {
    this.lastSent = this.now()
    if (!this.messageId) {
      this.cardId = await this.lark.createStreamingCard(this.elementId)
      this.messageId = await this.lark.sendMessage(this.target, 'interactive', this.cardId
        ? { type: 'card', data: { card_id: this.cardId } } : this.placeholderCard())
      if (!this.messageId) this.disabled = true
      return
    }
    if (this.cardId) {
      // No temporary ellipsis or closing fence: normal deltas keep the old text as a prefix.
      if (await this.lark.streamCardContent(this.cardId, this.elementId, body, ++this.sequence)) {
        this.lastBody = body
        return
      }
      await this.lark.settleStreamingCard(this.cardId, ++this.sequence, buildBodyCard(body))
      this.sequence++
      this.cardId = undefined
    }
    const result = await this.lark.updatePreview(this.messageId, buildBodyCard(body))
    if (result === 'failed') this.disabled = true
    // A rate-limited frame is skipped; only a subsequent change retries it.
    this.lastBody = body
  }
  private placeholderCard() {
    const card = buildBodyCard('思考中…')
    card.config.summary = { content: '思考中…' }
    return card
  }
  /** Keep the body and an optional abnormal-end status; endedAt excludes queued delivery time. */
  finish(status = '', body?: string, endedAt = this.now()): Promise<PreviewResult> {
    return this.finishFlight ??= this.settle(status, body, Math.max(0, endedAt - this.startedAt))
  }
  private async settle(status: string, body: string | undefined, elapsedMs: number): Promise<PreviewResult> {
    this.start()
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.flight
    const { card, overflow } = finalCard(body ?? (this.paragraph || '思考中…'), status)
    const result = (delivered: boolean): PreviewResult => ({ delivered, overflow, elapsedMs })
    if (!this.messageId) return result(false)
    if (this.cardId) {
      // Flush the exact rendered final body before disabling the typewriter.
      const text = String(card.body.elements[0]!.content)
      await this.lark.streamCardContent(this.cardId, this.elementId, text, ++this.sequence)
      if (await this.lark.settleStreamingCard(this.cardId, ++this.sequence, card)) return result(true)
    }
    return result(await this.lark.patchCard(this.messageId, card))
  }
}

/** Settlements, independent of streamed text and publisher timing. */
export class TurnOutput {
  lastText = ''
  finalText: string | undefined
  intermediate: string[] = []
  private readonly toolIds = new Set<string>()
  readonly preview: Preview | undefined
  readonly target: MessageTarget | undefined
  constructor(preview?: Preview, target?: MessageTarget) { this.preview = preview; this.target = target }
  tool(id: string, line: string): void {
    if (this.toolIds.has(id)) return
    this.toolIds.add(id)
    this.preview?.line(line)
  }
  assistant(text: string, hasTools: boolean): void {
    if (text) this.lastText = text
    if (hasTools) {
      if (text) { this.intermediate.push(text); this.preview?.line(text.replace(/[\r\n]+/g, ' ')) }
    } else this.finalText = text
    this.preview?.settled(text, hasTools)
  }
  body(override?: string): string {
    const final = (override ?? this.finalText ?? this.lastText) || '(空响应)'
    const substantial = this.intermediate.filter(text => (text.length >= 400 || /^\s*\|\s*---/m.test(text)) && !final.includes(text))
    return substantial.length ? `（中途内容）\n\n${[...substantial, final].join('\n\n')}` : final
  }
}
