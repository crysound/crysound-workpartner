import { randomUUID } from 'node:crypto'
import { buildBodyCard } from './card.ts'
import type { LarkGateway, MessageTarget } from './lark-client.ts'

export const PREVIEW_INTERVAL_MS = 250
const FALLBACK_INTERVAL_MS = 700
export function previewBody(lines: readonly string[], paragraph: string, streaming = false): string | undefined {
  const rows = lines.flatMap(line => line.match(/[\s\S]{1,2000}/g) ?? [])
  paragraph = paragraph.split('\n').map(line => (line.match(/[\s\S]{1,2000}/g) ?? ['']).join('\n')).join('\n')
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
  private readonly elementId = `preview_${randomUUID()}`
  private sequence = 0
  private readonly startedAt: number
  private readonly intervalMs: number
  private lastBody: string | undefined
  private lastSent = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private flight: Promise<void> | undefined
  private stopped = false
  private disabled = false
  private readonly lark: LarkGateway
  private readonly target: MessageTarget
  private readonly now: () => number
  constructor(lark: LarkGateway, target: MessageTarget, now: () => number = Date.now, intervalMs = PREVIEW_INTERVAL_MS) {
    this.lark = lark; this.target = target; this.now = now
    this.startedAt = now(); this.intervalMs = intervalMs
  }

  line(text: string): void { if (text) { this.lines.push(text); this.schedule() } }
  delta(text: string): void { if (text) { this.paragraph += text; this.schedule() } }
  settled(): void { this.paragraph = ''; this.schedule() }

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
        ? { type: 'card', data: { card_id: this.cardId } } : buildBodyCard('正在处理…'))
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
  async finish(status = '已完成'): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.flight
    if (!this.messageId) return
    const seconds = Math.max(0, Math.round((this.now() - this.startedAt) / 1000))
    const text = `${status} · 用时 ${seconds} 秒`
    const card = buildBodyCard(text)
    card.config = { ...card.config, summary: { content: text } }
    if (this.cardId && await this.lark.settleStreamingCard(this.cardId, ++this.sequence, card)) return
    await this.lark.patchCard(this.messageId, card)
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
    this.preview?.settled()
  }
  body(override?: string): string {
    const final = (override ?? this.finalText ?? this.lastText) || '(空响应)'
    const substantial = this.intermediate.filter(text => (text.length >= 400 || /^\s*\|\s*---/m.test(text)) && !final.includes(text))
    return substantial.length ? `（中途内容）\n\n${[...substantial, final].join('\n\n')}` : final
  }
}
