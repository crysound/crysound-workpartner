import { randomBytes } from 'node:crypto'
import type { Schema2Card } from './card.ts'
import { closeOpenFence } from './text.ts'
import type { LarkGateway, MessageTarget } from './lark-client.ts'

export const PREVIEW_INTERVAL_MS = 200

/** Delivery outcome for the final card; failed or clipped cards need a separate body. */
export interface PreviewResult {
  readonly delivered: boolean
  readonly overflow: boolean
  readonly elapsedMs: number
}

/** Body stays first, so collapsing the process never moves the answer. */
function answerCard(body: string, footer: string, lines: readonly string[], elementId?: string, progressId?: string): Schema2Card {
  return {
    schema: '2.0', config: { width_mode: 'fill' },
    body: { elements: [
      { tag: 'markdown', ...(elementId ? { element_id: elementId } : {}), content: body },
      ...(lines.length ? [{ tag: 'collapsible_panel', ...(progressId ? { element_id: progressId } : {}),
        expanded: false, header: { title: { tag: 'plain_text', content: `过程（${lines.length} 步）` } },
        elements: [{ tag: 'markdown', content: lines.slice(-3).map(line => line.slice(0, 300)).join('\n') }] }] : []),
      ...(footer ? [{ tag: 'markdown', content: footer, text_size: 'notation' }] : []),
    ] },
  }
}

/** Reserve space for process/status and nested JSON encoding below the 30 KB limit. */
function finalCard(body: string, footer: string, lines: readonly string[], elementId?: string, progressId?: string) {
  const make = (text: string) => answerCard(text, footer, lines, elementId, progressId)
  const fits = (text: string) => text.length <= 8000
    && Buffer.byteLength(JSON.stringify(JSON.stringify(text))) <= 20000
  const suffix = '\n\n全文见下条'
  const chars = Array.from(body)
  let low = 0, high = Math.min(chars.length, 7900)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(chars.slice(0, mid).join('') + '\n```' + suffix)) low = mid
    else high = mid - 1
  }
  const prefix = chars.slice(0, low).join('')
  const overflow = low < chars.length
  return { card: make(overflow ? closeOpenFence(prefix) + suffix : body), overflow }
}
const FALLBACK_INTERVAL_MS = 700
/** One turn owns the publisher and heartbeat; every outbound mutation is serialized. */
export class Preview {
  private lines: string[] = []
  private paragraph = ''
  private messageId: string | undefined
  private cardId: string | undefined
  private elementId = 'p' + randomBytes(9).toString('hex')
  private sentElementId = this.elementId
  private readonly progressId = 'p' + randomBytes(9).toString('hex')
  private sequence = 0
  private readonly startedAt: number
  private lastBody = ''
  private lastProgress = ''
  private lastSent = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private flight: Promise<void> | undefined
  private finishFlight: Promise<PreviewResult> | undefined
  private stopped = false
  private disabled = false
  private readonly lark: LarkGateway
  private readonly target: MessageTarget
  private readonly now: () => number
  private readonly intervalMs: number
  constructor(lark: LarkGateway, target: MessageTarget, now: () => number = Date.now, intervalMs = PREVIEW_INTERVAL_MS) {
    this.lark = lark; this.target = target; this.now = now; this.intervalMs = intervalMs
    this.startedAt = now()
  }

  start(): void {
    if (this.stopped || this.disabled || this.messageId || this.flight) return
    this.heartbeat = setInterval(() => this.schedule(), 1000)
    this.heartbeat.unref?.()
    this.launch()
  }
  line(text: string): void { if (text && !this.stopped) { this.lines.push(text); this.schedule() } }
  delta(text: string): void { if (text && !this.stopped) { this.paragraph += text; this.schedule() } }
  settled(text = '', hasTools = true): void {
    if (this.stopped) return
    const next = hasTools ? '' : text
    if (!next.startsWith(this.paragraph)) this.elementId = 'p' + randomBytes(9).toString('hex')
    this.paragraph = next
    this.schedule()
  }
  private progress(): string {
    const seconds = Math.max(0, Math.floor((this.now() - this.startedAt) / 1000))
    return [!this.paragraph ? `思考中 · 已 ${seconds} 秒` : '',
      this.lines.length ? `已执行 ${this.lines.length} 步` : '',
      ...this.lines.slice(-3).map(line => line.slice(0, 300))].filter(Boolean).join('\n')
  }
  private body(): string {
    return String(finalCard(this.paragraph, '', this.lines, this.elementId, this.progressId).card.body.elements[0]!.content)
  }
  private schedule(): void {
    if (this.stopped || this.disabled || this.flight || this.timer) return
    if (!this.messageId) { this.start(); return }
    if (this.body() === this.lastBody && this.elementId === this.sentElementId && this.progress() === this.lastProgress) return
    const delay = (this.cardId ? this.intervalMs : Math.max(FALLBACK_INTERVAL_MS, this.intervalMs)) - (this.now() - this.lastSent)
    if (delay > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.schedule() }, delay)
      this.timer.unref?.()
    } else this.launch()
  }
  private launch(): void {
    this.flight = this.publish().finally(() => { this.flight = undefined; this.schedule() })
  }
  private liveCard(body: string, progress: string): Schema2Card {
    return { schema: '2.0', config: { width_mode: 'fill', summary: { content: body.slice(0, 120) || '思考中…' } }, body: { elements: [
      { tag: 'markdown', element_id: this.elementId, content: body },
      { tag: 'markdown', element_id: this.progressId, content: progress, text_size: 'notation' },
    ] } }
  }
  private async stream(body: string, elementId: string): Promise<boolean> {
    if (!this.cardId) return false
    if (this.sentElementId !== elementId || !body.startsWith(this.lastBody)) {
      if (!await this.lark.updateCardElement(this.cardId, this.sentElementId,
        { tag: 'markdown', element_id: elementId, content: '' }, ++this.sequence)) return false
      this.sentElementId = elementId; this.lastBody = ''
    }
    if (body === this.lastBody) return true
    if (!await this.lark.streamCardContent(this.cardId, elementId, body, ++this.sequence)) return false
    this.lastBody = body
    return true
  }
  private async publish(): Promise<void> {
    this.lastSent = this.now()
    if (!this.messageId) {
      this.cardId = await this.lark.createStreamingCard(this.elementId, this.progressId)
      this.messageId = await this.lark.sendMessage(this.target, 'interactive', this.cardId
        ? { type: 'card', data: { card_id: this.cardId } } : this.liveCard('', '思考中 · 已 0 秒'))
      this.lastProgress = '思考中 · 已 0 秒'
      if (!this.messageId) this.disabled = true
      return
    }
    const body = this.body(), progress = this.progress(), elementId = this.elementId
    if (this.cardId) {
      if (await this.stream(body, elementId)
        && (progress === this.lastProgress || await this.lark.updateCardElement(this.cardId, this.progressId,
          { tag: 'markdown', element_id: this.progressId, content: progress, text_size: 'notation' }, ++this.sequence))) {
        this.lastProgress = progress
        return
      }
      await this.lark.settleStreamingCard(this.cardId, ++this.sequence, this.liveCard(body, progress))
      this.sequence++; this.cardId = undefined
    }
    const result = await this.lark.updatePreview(this.messageId, this.liveCard(body, progress))
    if (result === 'failed') this.disabled = true
    this.lastBody = body; this.lastProgress = progress; this.sentElementId = elementId
  }
  finish(status = '', body?: string, endedAt = this.now()): Promise<PreviewResult> {
    return this.finishFlight ??= this.settle(status, body, Math.max(0, endedAt - this.startedAt))
  }
  private async settle(status: string, body: string | undefined, elapsedMs: number): Promise<PreviewResult> {
    this.start(); this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.timer = undefined; this.heartbeat = undefined
    await this.flight
    const { card, overflow } = finalCard(body ?? (this.paragraph || '思考中…'), status, this.lines, this.elementId, this.progressId)
    const result = (delivered: boolean): PreviewResult => ({ delivered, overflow, elapsedMs })
    if (!this.messageId) return result(false)
    if (this.cardId) {
      const text = String(card.body.elements[0]!.content)
      if (!text.startsWith(this.lastBody)) this.elementId = 'p' + randomBytes(9).toString('hex')
      card.body.elements[0]!.element_id = this.elementId
      const flushed = await this.stream(text, this.elementId)
      const settled = await this.lark.settleStreamingCard(this.cardId, ++this.sequence, card)
      if (flushed && settled) return result(true)
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
