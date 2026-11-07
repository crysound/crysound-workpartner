// Modified by 兆华声学（CRYSOUND）: turn-scoped previews, acknowledgements and final replies.
/**
 * The bot orchestrator: inbound queue → command routing → session binding →
 * status-card lifecycle.
 *
 * Lifecycle rules (design doc §2/§5 定稿):
 * - silent startup — the bot never sends anything unprompted;
 * - pairing mode: with a COMPLETELY empty operator list (config ∪ persisted
 *   paired), the first p2p DM is offered a pairing confirmation card whose
 *   tap claims admin (persisted, effective in-process immediately); groups
 *   never pair, and once any admin exists strangers are silent again;
 * - unbound ordinary text creates a session with the default cwd/model;
 *   creation failure logs a warning and replies with the /new /resume hint;
 * - prompts inject via `agent.steer` while a turn runs (join the CURRENT
 *   turn's next round — the operator's mid-course corrections land
 *   immediately) and `agent.followup` when idle (open the next turn);
 * - OnIt precedes session work; one retained preview spans the whole turn;
 * - turn/end retains the answer in the preview, then clears OnIt;
 * - card operations serialize final replies in turn order;
 * - no replay of session history on bind (live events from bind time on).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type LlmRuntime, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { isOperator } from './allowlist.ts'
import {
  buildAskAnsweredCard,
  buildAskCard,
  buildAskDismissedCard,
  parseAskAction,
  parseAskFormValue,
} from './ask-card.ts'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { defaultRepairBackend, type RepairBackend } from './log-repair.ts'
import {
  buildModelPickCard,
  buildModelProviderCard,
  buildModelProviderSettledCard,
  buildModelSettledCard,
  parseModelProviderAction,
  parseModelSubmitAction,
  type ModelInfo,
  type ModelProviderInfo,
} from './model-card.ts'
import type { Model } from '@deepseek-ai/dsh-agent'
import { SelectorManager, type SelectorOutcome } from './selector.ts'
import { parseSelectorAction, type SelectorSpec } from './selector-card.ts'
import {
  DEFAULT_EFFORT,
  runPermissionCommand,
  runProfileSwitchCommand,
  runSelectSkillCommand,
  runThinkCommand,
  type CurrentSelection,
  type InteractiveHost,
  type ModelSelectionUpdate,
} from './interactive.ts'
import { buildResumePickerCard, buildResumePickedCard, parseResumeAction, type ParsedResumeAction } from './card.ts'
import { buildBodyCard, buildPushCard, buildSessionListAsMarkdown, buildSessionListCard, parseRoundCardAction, type RoundActionOp, type Schema2Card } from './card.ts'
import { classifyInbound, helpText, refusedReply } from './commands.ts'
import { buildNewSessionCard, buildNewSessionCreatedCard, buildNewSessionFailedCard, parseNewSessionAction, type NewCardChoice, type NewSessionCardSpec, type NewSummaryRow } from './new-card.ts'
import { NewSessionFlowManager, type NewSessionOutcome } from './new-flow.ts'
import { buildBtwSnapshot, type BtwStreamChunk } from './btw.ts'
import { BtwManager } from './btw-bot.ts'
import type { ResolvedConfig } from './config.ts'
import { mentionText, parseReceiveEvent, type InboundMessage } from './inbound.ts'
import { EMOJI_DONE, EMOJI_PROCESSING, type LarkGateway, type MessageTarget } from './lark-client.ts'
import {
  buildPairingOfferCard,
  buildPairingRejectedCard,
  buildPairingSuccessCard,
  decidePairing,
  PAIRING_PERSIST_NOTE,
  pairingActionContextOf,
  parsePairingAction,
  type PairingActionContext,
} from './pairing.ts'
import { buildResumeRows, loadSessionLastUpdates, pickResumeRow, readPersistedSession, type ResumeRow, type SessionPersistenceLike } from './resume-table.ts'
import {
  applyChildBackfill,
  applyRouteBackfill,
  backfillFromChildLog,
  backfillRouteFromLog,
  foldBoundEvent,
  foldBoundStreamChunk,
  foldChildEvent,
  foldChildStreamChunk,
  foldRequestError,
  foldTurnStopping,
  initialRunState,
  type RunState,
  subagentRows,
} from './run-state.ts'

/**
 * Structural shape of one `agent/assistant-stream` frame — only chunk frames
 * matter here (start/end are lifecycle markers the settlements already cover).
 */
interface StreamFrame {
  readonly type: 'start' | 'chunk' | 'end'
  /** Chunk-frame timestamp (epoch ms, same clock as firehose events). */
  readonly time?: number
  readonly chunk?: {
    readonly type?: string
    readonly text?: string
  }
}

/** The llm service surface the model cards need (structural). */
interface LlmModelSurface {
  listProviders(): readonly ModelProviderInfo[]
  listModels(provider: string): Promise<readonly ModelInfo[]>
  resolveModelInfo(provider: string, model: string): Promise<{ context?: { contextWindow?: number } }>
}
import type { BindResult, SessionBinder } from './binder.ts'
import type { StateStore } from './state-store.ts'
import { clipLine, segmentText, markdownTableCount } from './text.ts'
import { Preview, TurnOutput } from './preview.ts'
import { toolProgress } from './progress.ts'
import { replyChain, forwardedContent, type ResourceImage } from './resources.ts'
import { imageExtensionOf, sniffImageMediaType } from './image.ts'
import { foldPushEvent, initialPushTrack, pushCauseLabel, shouldPush, type PushTrack } from './push.ts'

/** Structural view of the host's attachment service (dsh-attachment ctx service). */
interface AttachmentsLike {
  readonly imageLimits?: { readonly maxImageBytes: number; readonly mediaTypes: readonly string[] }
  saveFile(input: { data: Uint8Array; name?: string }): Promise<FileAttachmentRef>
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
}

/** Structural view of the host's approval waterfall request (dsh-user-approval). */
interface ApprovalRequestLike {
  readonly agent?: { session?: { id?: unknown } }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** The closed approval outcome vocabulary (dsh-user-approval). */
type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** A pending /resume table awaiting its index reply (5-minute lifetime). */
interface PendingPicker {
  /** Matches the interactive picker card's submit button (card callback path). */
  id: string
  rows: readonly ResumeRow[]
  expiresAt: number
}

/**
 * Structural view of dsh's ask request (the fields the phone side needs).
 * The agent reference identifies the asking session for claim routing.
 */
interface AskRequestLike {
  questions: AskUserQuestionItem[]
  agent?: { session?: { id?: unknown } }
  signal?: AbortSignal
}

/** Structural view of the ask-router's surface registry (dsh-ask-router). */
interface AskSurfacesLike {
  register(surface: {
    name: string
    claim(request: AskRequestLike): boolean
    ask(request: AskRequestLike): Promise<AskUserQuestionAnswer>
    settled?(request: AskRequestLike, by: string): void
  }): () => void
}

/** One live question whose card is out on the operator's phone. */
interface PendingAsk {
  readonly questions: AskUserQuestionItem[]
  messageId: string | undefined
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: Error) => void
}

/** The operator open_id a card.action payload carries, when well-formed. */
function cardOperatorOf(data: unknown): string | undefined {
  const operator = (data as { operator?: { open_id?: unknown } }).operator?.open_id
  return typeof operator === 'string' ? operator : undefined
}

const PICKER_TTL_MS = 5 * 60 * 1000

/** Pairing-offer card cache cap (chatId → messageId); over this, drop the oldest. */
const PAIRING_CARD_CACHE_LIMIT = 32


export interface BotDeps {
  readonly ctx: Context
  readonly config: ResolvedConfig
  readonly lark: LarkGateway
  readonly binder: SessionBinder
  readonly store: StateStore
  readonly allowlist: ReadonlySet<string>
  /** Clock seam for deterministic tests. */
  readonly now?: () => number
  /** Corrupt-log repair seam (tests inject a fake; default spawns the tool). */
  readonly repair?: RepairBackend
}

export class FeishuBot {
  private readonly ctx: Context
  private readonly config: ResolvedConfig
  private readonly lark: LarkGateway
  private readonly binder: SessionBinder
  private readonly store: StateStore
  private readonly allowlist: ReadonlySet<string>
  private readonly now: () => number
  private readonly repair: RepairBackend

  private readonly runState: RunState = initialRunState()
  /** Serializes card operations (open/patch/settle/finalize) in event order. */
  private cardChain: Promise<unknown> = Promise.resolve()
  private pendingPicker: PendingPicker | undefined
  /** Session id whose route facts were already backfilled from its log. */
  private routeBackfilledFor: string | undefined
  /** Live ask-user questions keyed by the card's question id. */
  private readonly pendingAsks = new Map<string, PendingAsk>()
  /** ask() request object → question id (router settled() arrives per-request). */
  private readonly askRequestIds = new WeakMap<object, string>()
  /** The interactive /resume picker card awaiting a form submit. */
  private resumeCardMessageId: string | undefined
  /** Bot-created sessions' agent-owned model selection surfaces (/model live-switch). */
  private readonly selectionRefs = new Map<string, Model>()
  /** Session id → agent-preset id learned at bind/create time (footer display). */
  private readonly presetBySession = new Map<string, string>()
  /** /btw side-question manager (phone surface; per-surface by design). */
  private readonly btw: BtwManager
  /** The in-flight /model two-step flow. */
  private modelFlow: {
    id: string
    provider: string | undefined
    providerCardMessageId: string | undefined
    cardMessageId: string | undefined
  } | undefined
  /** Generic selection-card flows (selector FW; driven via presentSelection). */
  private readonly selectors: SelectorManager
  private readonly newFlow: NewSessionFlowManager
  /** Session ids with a corrupt-repair confirmation card currently out. */
  private readonly repairFlows = new Set<string>()
  /** Bot-side surfaces the interactive adapters drive (selector-FW commands). */
  private readonly host: InteractiveHost
  private turnOutput: TurnOutput | undefined
  private turnMessages: InboundMessage[] = []
  private turnHasUser = false
  private queuedMessages: InboundMessage[] = []
  private readonly acknowledgements = new Map<string, Promise<string | undefined>>()
  private readonly pendingPrompts = new Map<string, { messages: InboundMessage[]; sessionId: string; preview?: Preview }>()
  private readonly imageBatches = new Map<string, { messages: InboundMessage[]; timer: ReturnType<typeof setTimeout> }>()
  /** The bot's own open_id — group mention routing (resolved at start; optional). */
  private botOpenId: string | undefined
  /**
   * Pairing-offer cards currently out (chatId → messageId), so a repeated DM
   * in the same chat PATCHES the existing card instead of stacking a new one.
   * Bounded: over the cap the oldest chat's entry is dropped (a fresh card is
   * simply sent next time — self-healing, no correctness impact).
   */
  private readonly pairingCards = new Map<string, string>()
  /** Per-session background-push scratch (firehose fold; bounded). */
  private readonly pushTracks = new Map<string, PushTrack>()
  private disposed = false

  /** Inbound queue — the WS handler only pushes; a serial drain processes. */
  private readonly queue: (InboundMessage | InboundMessage[])[] = []
  private draining = false

  constructor(deps: BotDeps) {
    this.ctx = deps.ctx
    this.config = deps.config
    this.runState.toolDetail = deps.config.toolDetail
    this.lark = deps.lark
    this.binder = deps.binder
    this.store = deps.store
    this.allowlist = deps.allowlist
    this.now = deps.now ?? Date.now
    this.repair = deps.repair ?? defaultRepairBackend
    this.selectors = new SelectorManager({
      // Card ops ride the same serial chain as every other card lifecycle
      // step so selector sends/patches never interleave with a settle.
      sendCard: (chatId, card) => this.chain(() => this.lark.sendCard(chatId, card as Schema2Card)),
      patchCard: (messageId, card) => this.chain(() => this.lark.patchCard(messageId, card as Schema2Card)),
      allowlisted: openId => this.mayOperate(openId),
      logger: this.ctx.logger,
    })
    this.newFlow = new NewSessionFlowManager({
      sendCard: (chatId, card) => this.chain(() => this.lark.sendCard(chatId, card as Schema2Card)),
      patchCard: (messageId, card) => this.chain(() => this.lark.patchCard(messageId, card as Schema2Card)),
      logger: this.ctx.logger,
    })
    this.host = {
      ctx: this.ctx,
      store: this.store,
      binder: this.binder,
      reply: text => this.reply(text),
      presentSelection: (chatId, spec) => this.presentSelection(chatId, spec),
      applyModelSelection: selection => this.applyModelSelection(selection),
      injectPrompt: text => this.injectPrompt(text),
      executeCommand: (name, line) => this.handlePassthrough(name, line),
      currentSelection: () => this.currentModelSelection(),
      boundAgent: () => this.ensureBoundAgent(),
    }
    // /btw — by-the-way side questions (phone copy of dsh-tui-pi's engine,
    // docs/adr/0001-btw-duplicated-not-shared.md). Per-surface by design:
    // this queue/slot/cancellation is independent of the TUI's overlay.
    this.btw = new BtwManager({
      stream: options => {
        const llm = this.ctx.get('llm') as LlmRuntime | undefined
        if (llm === undefined) throw new Error('LLM 服务不可用。')
        return llm.stream({
          provider: options.provider,
          model: options.model,
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.reasoningEffort as ReasoningEffortId }),
          messages: options.messages,
          system: options.system,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }) as AsyncIterable<BtwStreamChunk>
      },
      sendCard: (chatId, card) => this.chain(() => this.lark.sendCard(chatId, card as Schema2Card)),
      patchCard: (messageId, card) => this.chain(() => this.lark.patchCard(messageId, card as Schema2Card)),
      notify: text => { void this.reply(text).catch(() => undefined) },
      resolveSelection: () => {
        // Sync projection only: a running main line always has a live route
        // (selection surface / runState) — the persistence fallback is irrelevant
        // for a btw, which requires the main line to be running.
        const bound = this.binder.getSessionId()
        const ref = bound === undefined ? undefined : this.selectionRefs.get(bound)?.current()
        if (ref !== undefined && ref.provider !== undefined && ref.model !== undefined) {
          return {
            provider: ref.provider,
            model: ref.model,
            ...(ref.reasoningEffort === undefined ? {} : { reasoningEffort: ref.reasoningEffort }),
          }
        }
        if (this.runState.provider !== undefined && this.runState.model !== undefined) {
          return {
            provider: this.runState.provider,
            model: this.runState.model,
            ...(this.runState.reasoningEffort === undefined ? {} : { reasoningEffort: this.runState.reasoningEffort }),
          }
        }
        return undefined
      },
      buildSnapshot: () => {
        const agent = this.binder.getAgent()
        // dsh 0.1.7: the surface-driven derived history replaces the
        // soft-deprecated raw `snapshotEvents()` scan — compaction-replaced
        // turns drop off, so the side call sees the history the main agent
        // actually holds (see buildBtwSnapshot for the role/source filter).
        return agent === undefined
          ? []
          : buildBtwSnapshot(agent.session.deriveMessages(), this.config.btwContextMessages)
      },
      isMainRunning: () => this.binder.getAgent()?.status === 'running',
      isReadOnlyView: () => this.binder.isReadOnlyView(),
      beatMs: this.config.statusIntervalMs,
      logger: this.ctx.logger,
    })
  }

  /** Wire subscriptions and open the Lark connection. */
  async start(): Promise<void> {
    await this.store.ready()
    const offFirehose = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      try {
        this.onSessionEvent(session, event)
      } catch (error) {
        this.ctx.logger.warn('dsh-feishu: firehose fold failed: %o', error)
      }
    })
    // dsh 0.1.5-rc.1: incremental streaming left the `session/event` firehose
    // (settlements only) and moved to per-agent `agent/assistant-stream`
    // frames. Root-scope listening sees every agent; frames are routed by the
    // agent's session id exactly like the firehose above.
    const offStream = this.ctx.on('agent/assistant-stream', (payload: { agent: { readonly id: SessionId }; frame: StreamFrame }) => {
      try {
        this.onStreamFrame(payload.agent, payload.frame)
      } catch (error) {
        this.ctx.logger.warn('dsh-feishu: stream frame fold failed: %o', error)
      }
    })
    // dsh 0.1.5 agent lifecycle notifications: `agent/turn-stopping` fires the
    // moment a cancel/stop starts being honored (the phone sees "⛔ 停止中"
    // instead of the stale live phase), `agent/request-error` surfaces a model
    // failure immediately (the card shows the one-line summary even while a
    // retry is still scheduled). Both are routed by the agent's session id
    // exactly like the stream frames; children are ignored (their failures
    // settle through the parent's own request cycle). Neither event is part of
    // the cordis type surface this plugin imports — structural casts, same as
    // the ask/approval waterfalls.
    const onStopping = (this.ctx.on as unknown as (
      event: 'agent/turn-stopping',
      listener: (payload: { agent: { readonly id: SessionId } }) => void | Promise<void>,
    ) => () => boolean)
    const offStopping = onStopping('agent/turn-stopping', payload => {
      try {
        const boundId = this.binder.getSessionId()
        if (boundId !== undefined && String(payload.agent.id) === boundId) {
          foldTurnStopping(this.runState)
        }
      } catch (error) {
        this.ctx.logger.warn('dsh-feishu: turn-stopping fold failed: %o', error)
      }
    })
    const onRequestError = (this.ctx.on as unknown as (
      event: 'agent/request-error',
      listener: (payload: { agent: { readonly id: SessionId }; failure?: { message?: unknown } }) => Promise<{ kind: 'retry' } | undefined>,
    ) => () => boolean)
    const offRequestError = onRequestError('agent/request-error', async payload => {
      try {
        const boundId = this.binder.getSessionId()
        if (boundId !== undefined && String(payload.agent.id) === boundId) {
          const message = typeof payload.failure?.message === 'string' ? payload.failure.message : undefined
          foldRequestError(this.runState, message)
        }
      } catch (error) {
        this.ctx.logger.warn('dsh-feishu: request-error fold failed: %o', error)
      }
      return undefined // observe-only: never owns the request recovery
    })
    this.cleanupFns.push(offFirehose, offStream, offStopping, offRequestError)
    this.registerAskSurface()
    this.registerApprovalSurface()
    await this.lark.start(data => this.enqueue(data))
    // The bot's own open_id gates group mentions (only @bot dispatches).
    // Best-effort: a failure only degrades the gate to "any mention counts",
    // never blocks the p2p path.
    this.botOpenId = await this.lark.fetchBotOpenId()
    if (this.botOpenId === undefined) {
      this.ctx.logger.warn('dsh-feishu: bot open_id unresolvable — group mention gate accepts any mention')
    }
    // Restore the binding WITHOUT resuming: if the persisted session happens
    // to be live in this process, attach to it (no side effects). A stored
    // but cold id stays in the store only — the lazy resume happens on the
    // operator's first interaction, because an eager resume at startup would
    // occupy the registry and could block the TUI from resuming that session.
    const storedId = this.store.get().boundSessionId
    if (storedId !== undefined && this.binder.getAgentFor(storedId) === undefined) {
      this.ctx.logger.info('dsh-feishu: stored binding %s is not live — will resume on first use', storedId)
    }
    await this.attachStoredBindingIfLive('startup')
  }

  /**
   * Attach the stored binding when its session is ALREADY live — never resume.
   *
   * Runs at startup and again from the firehose. A session the desktop opens
   * after this plugin started is not live at startup time, so the attach was
   * skipped and the phone went silent: `binder.getSessionId()` stays undefined,
   * which drops every card (`onSessionEvent` returns early) and makes every
   * claim false. `session/event` is a global subscription, so the stored
   * session's first event is a reliable second chance to finish the attach.
   *
   * @param reason - what triggered the attempt (log only).
   * @returns whether a live agent was found and bound.
   */
  private async attachStoredBindingIfLive(reason: string): Promise<boolean> {
    if (this.storedAttachInFlight) return false
    if (this.binder.getSessionId() !== undefined) return false
    const bound = this.store.get().boundSessionId
    if (bound === undefined || this.binder.getAgentFor(bound) === undefined) return false
    this.storedAttachInFlight = true
    try {
      await this.binder.bind(bound)
      void this.learnPreset(bound)
      this.backfillRoute()
      this.maybeOpenCardForRunningAgent()
      if (reason !== 'startup') {
        this.ctx.logger.info('dsh-feishu: attached the stored binding %s (%s)', bound, reason)
      }
      return true
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: stored binding %s attach failed (%s): %o', bound, reason, error)
      return false
    } finally {
      this.storedAttachInFlight = false
    }
  }

  /** One stored-binding attach in flight; the firehose may fire many events. */
  private storedAttachInFlight = false

  private readonly cleanupFns: Array<() => void> = []

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const fn of this.cleanupFns.splice(0)) {
      try { fn() } catch { /* contained */ }
    }
    this.btw.dispose()
    await this.closeCardAsDetached()
    // Settle every phone-side interactive flow before the WS dies: the
    // host-side callers fail fast (rejected, never left hanging) and the
    // cards on the phone get a terminal patch instead of surviving as
    // submittable zombies aimed at a disposed bot.
    for (const [questionId, entry] of [...this.pendingAsks]) {
      this.pendingAsks.delete(questionId)
      this.patchAskCard(entry, buildAskDismissedCard(entry.questions, 'cancelled', ''))
      entry.reject(new UserQuestionError('dsh-feishu is unloading — the ask was discarded', 'ASK_ABORTED'))
    }
    this.selectors.cancelAll('dsh-feishu disposed')
    // Let the terminal card patches flush while the WS is still open.
    await this.cardChain.catch(() => undefined)
    this.lark.close()
    await this.binder.dispose().catch(() => undefined)
  }

  // ------------------------------------------------------------- inbound --

  /** WS receive callback — enqueue-only (3s ack window; no business logic). */
  private enqueue(data: unknown): void {
    const message = parseReceiveEvent(data)
    if (message === undefined) return
    if (this.admitted(message) && this.isPromptMessage(message)) {
      void this.acknowledge(message)
      // Debounce by arrival time, even when an earlier download blocks drain.
      if (message.messageType === 'image') { this.bufferImage(message); return }
      if (message.messageType === 'text' || message.messageType === 'post') {
        const images = this.takeImageBatch(message)
        if (images.length) {
          this.queue.push([...images, { ...message, text: mentionText(message.text ?? '', message.mentions, this.botOpenId) }])
          void this.drain()
          return
        }
      }
    }
    this.queue.push(message)
    void this.drain()
  }

  /** Run a card operation after every previously queued one completes. */
  private chain<T>(op: () => Promise<T>): Promise<T> {
    const run = this.cardChain.then(op, op)
    this.cardChain = run.catch(() => undefined)
    return run
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const message = this.queue.shift()!
        try {
          if (Array.isArray(message)) await this.handleMedia(message.at(-1)!, message.slice(0, -1))
          else await this.process(message)
        } catch (error) {
          await this.clearAcknowledgements(Array.isArray(message) ? message : [message])
          this.ctx.logger.warn('dsh-feishu: inbound processing failed: %o', error)
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** Reply with a body card — markdown renders in lark_md, not in msg_type=text. */
  private async reply(text: string): Promise<void> {
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    await this.lark.sendCard(chatId, buildBodyCard(text))
  }

  /** Reply with a long body, segmented at the configured size; each segment ships as its own card. */
  private async replyLong(text: string): Promise<void> {
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    for (const segment of segmentText(text, this.config.bodySegmentChars)) {
      await this.lark.sendCard(chatId, buildBodyCard(segment))
    }
  }

  /**
   * Group gate: only @-mentions of the bot are dispatched — group traffic
   * delivers EVERY message to the bot, and replying to all of them would
   * spam the chat. Without a resolvable bot open_id any mention counts (a
   * gate that dropped everything forever would be worse than a loose one).
   *
   * Images are the one exception to the mention rule: an image message cannot
   * carry @mentions, so a group image counts as addressed when THIS chat is
   * the bot's current dispatch surface (the operator has been driving from
   * here) and a session is bound. A group that never touched the bot never
   * receives image injection.
   */
  private groupGate(message: InboundMessage): boolean {
    if (message.mentions.length === 0) {
      return message.messageType === 'image'
        && this.store.get().lastChatId === message.chatId
        && this.boundId() !== undefined
    }
    return this.botOpenId === undefined || message.mentions.some(mention => mention.openId === this.botOpenId)
  }

  private async process(message: InboundMessage): Promise<void> {
    // Pairing gate (replaces the plain allowlist check): the operator lists
    // are unioned with the PERSISTED pairing admins, re-read on every message
    // so a just-confirmed pairing takes effect in this very process. When the
    // union is empty, the first p2p DM is offered the pairing card instead of
    // being dropped; groups and configured-away senders stay silent.
    const decision = decidePairing({
      chatType: message.chatType,
      senderOpenId: message.openId,
      configOperators: [...this.allowlist],
      pairedOperators: this.store.get().pairedOperators ?? [],
    })
    if (decision.kind === 'ignore') return // silent — non-operator
    if (decision.kind === 'offer-pairing') {
      await this.offerPairing(message.chatId)
      return
    }
    if (message.chatType === 'group' && !this.groupGate(message)) return
    if (message.text !== undefined) message = { ...message, text: mentionText(message.text, message.mentions, this.botOpenId) }
    if (this.isPromptMessage(message)) await this.acknowledge(message)
    if (this.store.get().lastChatId !== message.chatId) {
      await this.store.update({ lastChatId: message.chatId })
    }
    if (message.messageType === 'image') {
      this.bufferImage(message)
      return
    }
    if (['post', 'file', 'merge_forward'].includes(message.messageType)) {
      await this.handleMedia(message, this.takeImageBatch(message))
      return
    }
    if (message.messageType !== 'text' || !message.text) {
      if (message.chatType === 'group' || message.messageType === 'text') return
      await this.reply('目前支持文字、富文本、图片、文件和合并转发消息。')
      return
    }
    const intent = classifyInbound(message.text)
    switch (intent.kind) {
      case 'help': await this.reply(helpText(this.boundId() !== undefined)); break
      case 'resume': await this.handleResumeList(); break
      case 'resume-pick': await this.handleResumePick(intent.n); break
      case 'new': await this.handleNew(); break
      case 'status': await this.reply(this.statusText()); break
      case 'stop': await this.handleStop(); break
      case 'sub': await this.handleSub(intent.n); break
      case 'model': await this.handleModel(); break
      case 'think': await this.interactiveCommand(runThinkCommand); break
      case 'permission': await this.interactiveCommand(runPermissionCommand); break
      case 'select-skill': await this.interactiveCommand(runSelectSkillCommand); break
      case 'profile-switch': await this.interactiveCommand(runProfileSwitchCommand); break
      case 'btw': await this.handleBtw(message, intent.line); break
      case 'onboard':
        // Desktop-only one-shot config — never let it reach the model as a
        // prompt from the phone.
        await this.reply('「/feishu-onboard」是桌面端首次配置命令，请在电脑端 dsh 的 TUI 里运行；手机端完成配置后即可用 /help 开始。')
        break
      case 'display':
        await this.store.update({ displayThink: intent.value === 'on' })
        await this.reply(intent.value === 'on' ? '已开启思考尾行显示。' : '已关闭思考尾行显示（/feishu-plugin think on 重新开启）。')
        break
      case 'rejected':
        await this.reply(refusedReply(intent.name))
        break
      case 'passthrough': await this.handlePassthrough(intent.name, intent.line); break
      case 'prompt': {
        const images = this.takeImageBatch(message)
        if (images.length || message.parentId) await this.handleMedia(message, images)
        else await this.handlePrompt(message, intent.text)
        break
      }
    }
  }

  // ----------------------------------------------------------- pairing --

  /**
   * Effective operator gate: the configured allowlist OR a persisted pairing
   * admin (read fresh — a claim must take effect in-process immediately).
   * Every interactive surface (card callbacks, selector FW) funnels through
   * here so a paired admin is a first-class operator everywhere, not only on
   * the message path.
   */
  private mayOperate(openId: string | undefined): boolean {
    if (isOperator(openId, this.allowlist)) return true
    if (openId === undefined || openId === '') return false
    const paired = this.store.get().pairedOperators
    return Array.isArray(paired) && paired.includes(openId)
  }

  /**
   * Whether an admin exists at all (config ∪ paired, freshly read) — the
   * pairing card's claim window is open only while this is false.
   */
  private hasAnyOperator(): boolean {
    if (this.allowlist.size > 0) return true
    const paired = this.store.get().pairedOperators
    return Array.isArray(paired) && paired.length > 0
  }

  /**
   * Offer the pairing confirmation card in a p2p chat. A repeated DM in the
   * same chat patches the already-out card (no stacking); a patch failure
   * (card deleted/too old) falls back to a fresh send. Both sends swallow
   * API errors — `undefined` messageId simply means the offer never landed
   * and the next DM retries.
   */
  private async offerPairing(chatId: string): Promise<void> {
    const existing = this.pairingCards.get(chatId)
    if (existing !== undefined) {
      const patched = await this.chain(() => this.lark.patchCard(existing, buildPairingOfferCard()))
      if (patched) return
      this.pairingCards.delete(chatId)
    }
    const messageId = await this.chain(() => this.lark.sendCard(chatId, buildPairingOfferCard()))
    if (messageId === undefined) return
    this.pairingCards.set(chatId, messageId)
    if (this.pairingCards.size > PAIRING_CARD_CACHE_LIMIT) {
      const oldest = this.pairingCards.keys().next().value
      if (oldest !== undefined) this.pairingCards.delete(oldest)
    }
  }

  /**
   * A pairing-card tap arrived: claim admin for the TAPPER (the open_id in
   * the event, never the card's original target). The claim window is
   * re-checked at tap time against the CURRENT config ∪ paired union — a
   * stale card tapped after an operator was configured resolves to the
   * "已有管理员" terminal state instead of a second admin. Never throws:
   * a failed claim degrades to a log line, the card callback contract
   * forbids leaking errors into the SDK dispatcher.
   */
  private async handlePairingClaim(openId: string, context: PairingActionContext): Promise<void> {
    try {
      const chatId = context.chatId ?? this.pairingChatIdOf(context.messageId)
      const messageId = context.messageId ?? (chatId === undefined ? undefined : this.pairingCards.get(chatId))
      if (this.hasAnyOperator()) {
        if (messageId !== undefined) await this.lark.patchCard(messageId, buildPairingRejectedCard())
        if (chatId !== undefined) this.pairingCards.delete(chatId)
        return
      }
      await this.store.addPairedOperator(openId)
      if (messageId !== undefined) await this.lark.patchCard(messageId, buildPairingSuccessCard())
      if (chatId !== undefined) {
        this.pairingCards.delete(chatId)
        await this.lark.sendText(chatId, PAIRING_PERSIST_NOTE)
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: pairing claim for %s failed: %o', openId, error)
    }
  }

  /** Reverse lookup: which chat a tracked pairing card was sent to. */
  private pairingChatIdOf(messageId: string | undefined): string | undefined {
    if (messageId === undefined) return undefined
    for (const [chatId, tracked] of this.pairingCards) {
      if (tracked === messageId) return chatId
    }
    return undefined
  }

  // ------------------------------------------------------------ commands --

  private async handleResumeList(): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) {
      await this.reply('当前 profile 没有 session 持久化服务，无法列出会话。')
      return
    }
    let rows: ResumeRow[]
    try {
      // Same last-update ordering as the TUI picker (jsonl mtimes; the walk
      // is best-effort and never throws — an unknown store root degrades to
      // createdAt ordering).
      rows = await buildResumeRows(persistence, await loadSessionLastUpdates())
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: /resume list failed: %o', error)
      await this.reply('读取会话列表失败，请稍后再试。')
      return
    }
    const pickerId = randomUUID()
    this.pendingPicker = { id: pickerId, rows, expiresAt: this.now() + PICKER_TTL_MS }
    await this.store.update({ picker: this.pendingPicker })
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    const style = this.config.resumeListStyle ?? 'auto'
    if (style === 'list') {
      await this.lark.sendCard(chatId, buildSessionListAsMarkdown(rows, this.now()))
      return
    }
    // sendCard swallows API errors and resolves undefined — that is the only
    // failure signal we get at send time: server rejection, rate-limit retries
    // exhausted, or a transport error. An old client that receives the card but
    // silently renders the table element blank fails AFTER delivery, which is
    // undetectable here — that scenario needs `resumeListStyle: 'list'` to
    // force the markdown list outright. In `auto` mode degrade exactly once on
    // a send-time failure; a second failure falls through to the existing
    // onError sink.
    const messageId = await this.lark.sendCard(chatId, buildResumePickerCard(rows, pickerId, this.now()))
    if (messageId === undefined && style === 'auto') {
      this.ctx.logger.warn('dsh-feishu: /resume picker card failed to send — falling back to markdown list')
      await this.lark.sendCard(chatId, buildSessionListAsMarkdown(rows, this.now()))
      return
    }
    this.resumeCardMessageId = messageId
  }

  /**
   * The effective picker: the in-memory one wins, the PERSISTED one is the
   * fallback after a restart (bot state survives reboots; the raw picker
   * previously died with the process, stranding `/resume N` replies).
   */
  private currentPicker(): PendingPicker | undefined {
    return this.pendingPicker ?? this.store.get().picker
  }

  private async handleResumePick(n: number): Promise<void> {
    await this.resumePickCore(n)
  }

  /** Interactive picker submit (card.action.trigger) → same core as /resume N. */
  private async handleResumeAction(parsed: ParsedResumeAction): Promise<void> {
    const picker = this.currentPicker()
    if (picker === undefined || picker.id !== parsed.pickerId) {
      // A stale card from an earlier list — its picker id no longer matches.
      this.reply('选择已过期（旧列表的卡片）。先发 /resume 刷新。').catch(() => undefined)
      return
    }
    await this.resumePickCore(parsed.index)
  }

  /** Shared bind flow for the text path (/resume N) and the card submit. */
  private async resumePickCore(n: number): Promise<void> {
    const picker = this.currentPicker()
    if (picker === undefined || picker.expiresAt < this.now()) {
      this.pendingPicker = undefined
      await this.store.update({ picker: undefined })
      this.resumeCardMessageId = undefined
      await this.reply('选择已过期。先发 /resume 查看会话列表。')
      return
    }
    const row = pickResumeRow(picker.rows, n)
    if (row === undefined) {
      await this.reply(`序号超出范围（1–${picker.rows.length}）。重新发 /resume 刷新列表。`)
      return
    }
    try {
      await this.bindAndAnnounce(row)
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: bind %s failed: %o', row.sessionId, error)
      if (error instanceof SessionAlreadyOwnedError) {
        await this.degradeToRemoteWatch(row)
        return
      }
      // The reason rides along (clipped): a bare "failed" on the phone gave
      // nothing to debug from — the whole /resume investigation stalled on it.
      const reason = clipLine(String(error instanceof Error ? error.message : error), 200)
      if (/corrupt .*(session|zstandard) log/i.test(reason)) {
        // Torn record inside a complete zstd frame — historical double-writer
        // damage. The phone can repair it in place (vendored tool + backup);
        // without a locatable log dir, keep pointing at the desktop tool.
        await this.offerCorruptRepair(row)
        return
      }
      await this.reply(`进入会话失败：${reason === '' ? '未知错误' : reason}`)
    }
  }

  /**
   * The host's single-writer guard fired on a bind (SessionAlreadyOwnedError):
   * another dsh process drives the session under its kernel write lease.
   * Degrade to a READ-ONLY view over its persisted log instead of a dead end
   * — the same fold pipeline paints round cards, so every turn's final reply
   * lands on the phone (poll-delayed). Queued follow-ups drive an automatic
   * takeover once the other process releases the session. Shared by the
   * /resume failure path and the post-repair re-entry (a racer can take the
   * session in the gap between the repair and the bind).
   */
  private async degradeToRemoteWatch(row: ResumeRow): Promise<void> {
    // Read-only watching is not a live main line — btw has nothing to run
    // alongside; cancel any in-flight side call on the switch.
    this.btw.cancelAll()
    try {
      await this.binder.watchRemote(row.sessionId, async events => {
        for (const event of events) {
          // Stub session header matching the bound id — turn cards,
          // tool rows and todo updates reuse the live pipeline verbatim.
          this.onSessionEvent({ id: row.sessionId } as Session, event as unknown as SessionEvent)
        }
      })
      // Queued follow-ups drive an automatic takeover at the next idle.
      this.binder.setOnPromotable(async () => {
        await this.store.update({ boundSessionId: row.sessionId })
        this.resetRunView()
        this.backfillRoute()
        this.drainQueuedPrompts()
        await this.reply('已自动接管该会话，排队消息已发送；本轮起由此端驱动。')
      })
      await this.store.update({ boundSessionId: row.sessionId })
      void this.learnPreset(row.sessionId)
      await this.reply(
        `已进入只读旁观：${row.preview}\n`
        + '该会话正由另一个进程驱动，为避免日志分叉不能从这里派活；\n'
        + '对面的最终回复会同步到这里，此时发消息会先排队，对面释放后自动接管并发出。/resume 或 /new 可切换。',
      )
    } catch (watchError: unknown) {
      this.ctx.logger.warn('dsh-feishu: watch remote %s failed: %o', row.sessionId, watchError)
      // Watching is best-effort — its own failure gets a plain refusal.
      const reason = clipLine(String(watchError instanceof Error ? watchError.message : watchError), 200)
      await this.reply(`只读旁观失败：${reason === '' ? '未知错误' : reason}`)
    }
  }

  /**
   * The bind + first-reply + picker-settle half of a successful /resume —
   * shared by the picker path and the post-repair re-entry (whose picker is
   * long gone; the row alone is enough). `notice`, when given, prefixes the
   * announcement so a repair lands as ONE message after the bind succeeded.
   */
  private async bindAndAnnounce(row: ResumeRow, notice?: string): Promise<BindResult> {
    // Switching sessions strands the btw context snapshot — cancel first.
    this.btw.cancelAll()
    const bound = await this.binder.bind(row.sessionId, await this.resolveResumeRoute(row.sessionId))
    if (!bound.tookOverWatch) await this.closeCardAsDetached()
    void this.learnPreset(row.sessionId)
    // An explicit resume can itself be the takeover the promote poll waits
    // for (0.16.1 made bind clear the view) — drain what the operator queued
    // while spectating. Switching to a DIFFERENT session drops their queue.
    let queueNote = ''
    if (bound.tookOverWatch === true) {
      const queued = this.binder.outboxSize()
      this.drainQueuedPrompts()
      if (queued > 0) queueNote = `\n（排队 ${queued} 条已随接管发送）`
    } else if (typeof bound.droppedQueued === 'number' && bound.droppedQueued > 0) {
      queueNote = `\n（已丢弃 ${bound.droppedQueued} 条排队消息——它们属于之前被旁观的会话）`
    }
    await this.store.update({ boundSessionId: row.sessionId, picker: undefined })
    this.pendingPicker = undefined
    this.resetRunView()
    this.backfillRoute()
    await this.reply(
      (notice === undefined ? '' : `${notice}\n`)
      + `已进入会话：${row.preview}\n`
      + `（${bound.mode === 'attached' ? '附着正在运行的会话' : '已从持久化恢复'} · ${row.sessionId.slice(0, 8)}）`
      + `${queueNote}\n`
      + '直接发消息即可派活；/help 查看全部命令。',
    )
    // Settle the interactive picker card (best-effort; absent after restart).
    if (this.resumeCardMessageId !== undefined) {
      const cardId = this.resumeCardMessageId
      this.resumeCardMessageId = undefined
      void this.chain(() => this.lark.patchCard(cardId, buildResumePickedCard(row)))
    }
    this.maybeOpenCardForRunningAgent()
    return bound
  }

  // -------------------------------------------------------- corrupt repair --

  /**
   * A /resume died on a corrupt log: resolve the session's storage dir and
   * put up a repair confirmation card. The interactive part runs DETACHED —
   * resumePickCore can be executing inside a card-chain task (card submit
   * path), and presentSelection dead-locks when awaited from that chain
   * (its sends enqueue on the very same chain).
   */
  private async offerCorruptRepair(row: ResumeRow): Promise<void> {
    const dir = await this.binder.sessionDirOf(row.sessionId)
    const chatId = this.store.get().lastChatId
    if (dir === undefined || chatId === undefined) {
      await this.reply(this.corruptPointerText())
      return
    }
    if (this.repairFlows.has(row.sessionId)) {
      await this.reply('修复确认卡已在上面，请在原卡片上操作。')
      return
    }
    this.repairFlows.add(row.sessionId)
    // Detached — see the invariant above. The catch mirrors the interactive
    // command wrapper: log, then ONE best-effort reply (itself allowed to
    // fail), so a flaky Lark send never surfaces as an unhandled rejection
    // in this long-lived process.
    void this.repairFlow(row, dir, chatId)
      .catch(async error => {
        this.ctx.logger.warn('dsh-feishu: repair flow for %s failed: %o', row.sessionId, error)
        await this.reply('修复流程异常中断，原文件未动。').catch(() => undefined)
      })
      .finally(() => {
        this.repairFlows.delete(row.sessionId)
      })
  }

  /** The desktop-tool pointer (degrade path when no log dir is resolvable). */
  private corruptPointerText(): string {
    return '该会话日志已损坏（多为历史双写者写入所致），无法从这里进入。\n'
      + '修复要在电脑端做：关闭使用该会话的 dsh 进程后，运行 dsh-tui-pi 的\n'
      + 'scripts/repair-session-log.mjs <session.jsonl.zstd> --apply，\n'
      + '按提示把 *.repaired 换回原位，再重试 /resume。'
  }

  /** Confirmation card → one-shot repair → re-enter the session. */
  private async repairFlow(row: ResumeRow, dir: string, chatId: string): Promise<void> {
    let outcome: SelectorOutcome
    try {
      outcome = await this.presentSelection(chatId, {
        title: '会话日志已损坏',
        description: '（多为历史双写者写入所致）修复会重建日志并保留备份，原文件不会删除。',
        options: [
          { value: 'repair', label: '🛠 修复并进入' },
          { value: 'skip', label: '先不修' },
        ],
        mode: 'buttons',
      })
    } catch (error) {
      // The card never went out — degrade to the desktop-tool pointer.
      this.ctx.logger.warn('dsh-feishu: repair card for %s failed: %o', row.sessionId, error)
      await this.reply(this.corruptPointerText())
      return
    }
    // Expired stays silent: the framework already patched the card grey, and
    // the operator who left it to expire should not get pinged afterwards.
    if (outcome.status === 'expired') return
    if (outcome.status !== 'picked' || outcome.value !== 'repair') {
      await this.reply('好的，未做修改。')
      return
    }
    await this.repairAndEnter(row, dir)
  }

  /**
   * The guarded repair: rebuild the corrupt log, verify the result, then swap
   * and re-enter. Every failure path leaves the original byte-identical.
   *
   * Cross-process arbitration note (0.1.5): a corrupt log cannot be DRIVEN —
   * any process that tries to open it for write fails at log validation and
   * the host's kernel write lease is released with that failure, so there is
   * no live writer to exclude during the rebuild window (the pre-0.1.5
   * pid-file guard here was deleted with the host lease taking over
   * arbitration). A racer that takes the session after the swap degrades the
   * re-entry below to the same read-only watch a refused /resume gets.
   */
  private async repairAndEnter(row: ResumeRow, dir: string): Promise<void> {
    // Compressed or raw — sessions written without zstd exist on disk.
    const logPath = await this.repair.locateSessionLog(dir)
    if (logPath === undefined) {
      await this.reply('修复失败：会话目录下没有日志文件，原文件未动。')
      return
    }
    try {
      const applied = await this.repair.runRepair(logPath, { apply: true })
      if (applied.status === 'failed') {
        await this.reply(`修复失败：${applied.detail ?? '未知原因'}，原文件未动。`)
        return
      }
      if (applied.status !== 'repaired' || applied.repairedPath === undefined) {
        // The tool found no seq violations — the bind failure had another
        // shape; touching nothing is the only safe answer.
        await this.reply('修复检查未发现可修的损坏，原文件未动；请重新 /resume 看具体报错。')
        return
      }
      if (!(await this.repair.verifyClean(applied.repairedPath))) {
        await this.reply('修复失败：重建的日志未通过完整性校验，未换入，原文件未动。')
        return
      }
      await this.repair.swapRepaired(logPath, applied.repairedPath)
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: repair %s failed: %o', logPath, error)
      await this.reply(`修复失败：${clipLine(String(error instanceof Error ? error.message : error), 200) || '未知原因'}，原文件未动。`)
      return
    }
    // Bind FIRST, announce after: replying (a network round-trip) before the
    // bind would only widen the window for a racer — and the bind's own
    // SessionAlreadyOwnedError has a degrade path below.
    try {
      await this.bindAndAnnounce(row, '✅ 已修复并换入（原件备份为 .corrupt-bak）。')
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError) {
        await this.degradeToRemoteWatch(row)
        return
      }
      const reason = clipLine(String(error instanceof Error ? error.message : error), 200)
      if (/corrupt .*(session|zstandard) log/i.test(reason)) {
        await this.reply(`换入后仍报日志损坏（${reason}）——请改用电脑端工具核查。`)
        return
      }
      await this.reply(`进入会话失败：${reason === '' ? '未知错误' : reason}`)
    }
  }

  /**
   * /new: close the current binding and start a FRESH session bound to the
   * bot. The old stream gets its visual boundary — the last card greys out
   * (已解绑), then a 🆕 header card marks where the new session begins; the
   * chat history itself is never deleted (round cards are the operator's
   * record). The new session inherits the previous one's cwd when readable,
   * else the process cwd.
   */
  private async handleBtw(message: InboundMessage, rawInput: string): Promise<void> {
    const text = await this.btw.handleBtw(rawInput, message.chatId)
    await this.reply(text)
  }

  private async handleNew(): Promise<void> {
    // A fresh session strands the btw context snapshot — cancel first.
    this.btw.cancelAll()
    const previousId = this.binder.getSessionId() ?? this.store.get().boundSessionId
    const cwd = this.newSessionCwd(previousId)
    const selection = this.newSessionDefaultSelection(previousId)
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) {
      await this.reply('还没有可用的飞书会话，先在手机上给机器人发条消息。')
      return
    }
    const spec = await this.buildNewSessionSpec(cwd, selection)
    // No workspace to land in → /new is impossible (NA). The registry is the
    // authoritative source; a profile WITHOUT the service keeps the legacy
    // fallback cwd behavior instead of blocking.
    if (spec.workspaces !== undefined && spec.workspaces.length === 0) {
      await this.reply('当前环境没有任何已注册的 workspace（NA），无法创建新会话。请先在桌面端或 Web UI 打开一个工作目录后再试 /new。')
      return
    }
    // The config card goes out; the session is minted ONLY on submit
    // (handleNewOutcome). Cancel/expiry patch the grey terminal card inside
    // the flow manager and land here as no-ops. present() resolves
    // undefined when the CARD SEND itself failed (sendCard swallows API
    // errors) — never stay silent there, the operator tapped /new and got
    // nothing otherwise.
    void this.newFlow.present(chatId, spec)
      .then(outcome => {
        if (outcome === undefined) return this.reply('新会话配置卡发送失败，请重试 /new。')
        return this.handleNewOutcome(outcome, { cwd, selection })
      })
      .catch(error => {
        this.ctx.logger.warn('dsh-feishu: /new config flow failed: %o', error)
        void this.reply('新会话配置流程出错，请重试 /new。').catch(() => undefined)
      })
  }

  /** The cwd a fresh session starts in: the bound session's cwd, else here. */
  private newSessionCwd(previousId: string | undefined): string {
    let cwd = process.cwd()
    if (previousId !== undefined) {
      const sessions = this.ctx.get('sessions') as
        | { get(id: string): { header?: { cwd?: string } } | undefined }
        | undefined
      const headerCwd = sessions?.get(previousId)?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd !== '') cwd = headerCwd
    }
    return cwd
  }

  /**
   * Model selection the /new card PRE-FILLS (a bare agents.create has NO
   * provider/model — the first request dies with "agent has no
   * provider/model", Round 0 ❌ in live use). Resolution order:
   * 1. the previous session's own selection incl. reasoning effort
   *    (continuity: same model + effort, fresh context) from its log;
   * 2. the phone's own stored default (provider/model/effort saved by
   *    /model, /think or /profile-switch on the phone) — the operator's
   *    explicit pick beats the settings default;
   * 3. the settings' default model via ctx.agentDefaultModel — the same
   *    fallback the TUI seeds from before creating.
   */
  private newSessionDefaultSelection(previousId: string | undefined): ModelSelection | undefined {
    let selection: ModelSelection | undefined
    if (previousId !== undefined) {
      const sessions = this.ctx.get('sessions') as
        | { get(id: string): { events?: unknown[] } | undefined }
        | undefined
      const events = sessions?.get(previousId)?.events
      if (Array.isArray(events) && events.length > 0) {
        const backfill = backfillRouteFromLog(events as SessionEvent[])
        if (backfill.provider !== undefined && backfill.model !== undefined) {
          selection = {
            provider: backfill.provider,
            model: backfill.model,
            ...(backfill.reasoningEffort === undefined ? {} : { reasoningEffort: backfill.reasoningEffort as ModelSelection['reasoningEffort'] }),
          }
        }
      }
    }
    if (selection === undefined) {
      const phone = this.store.get().phoneModel
      if (phone?.provider !== undefined && phone?.model !== undefined) {
        selection = {
          provider: phone.provider,
          model: phone.model,
          ...(phone.reasoningEffort === undefined ? {} : { reasoningEffort: phone.reasoningEffort as ModelSelection['reasoningEffort'] }),
        }
      }
    }
    if (selection === undefined) {
      const defaultModel = this.ctx.get('agentDefaultModel') as
        | { currentSelection?: () => ModelSelection | undefined }
        | undefined
      const fallback = defaultModel?.currentSelection?.()
      if (fallback?.provider !== undefined && fallback?.model !== undefined) {
        selection = fallback
      }
    }
    return selection
  }

  /**
   * Dropdown sources for the /new config card — every field is best-effort:
   * a source that is absent (no presets service on this profile), fails, or
   * answers nothing just omits its dropdown, and the submit falls back to
   * the default-resolution chain for that key.
   */
  private async buildNewSessionSpec(cwd: string, selection?: ModelSelection): Promise<NewSessionCardSpec> {
    // Mutable build view of the readonly card spec.
    const spec: { -readonly [K in keyof NewSessionCardSpec]: NewSessionCardSpec[K] } = {}
    // Workspaces FIRST: the new session lands in an EXISTING workspace the
    // operator picks — never an invented path. An empty registry means /new
    // is impossible (NA) and no card goes out at all.
    try {
      const registry = this.ctx.get('workspaceRegistry') as
        | { list?: () => Array<{ id: unknown; path?: unknown; title?: unknown }> }
        | undefined
      if (registry?.list !== undefined) {
        const entities = registry.list()
        const choices = entities
          .filter(workspace => typeof workspace.path === 'string' && workspace.path !== '')
          .map(workspace => ({
            value: workspace.path as string,
            label: clipLine(typeof workspace.title === 'string' && workspace.title !== ''
              ? workspace.title
              : (workspace.path as string).split('/').pop() || (workspace.path as string), 48),
          }))
        // Set even when EMPTY — an empty list from a PRESENT registry is the
        // NA signal (no workspace to land in); only an ABSENT registry leaves
        // the field undefined (legacy fallback cwd).
        spec.workspaces = choices
        if (choices.length > 0) {
          spec.defaultWorkspace = choices.some(choice => choice.value === cwd) ? cwd : choices[0]?.value
        }
      }
    } catch {
      // Registry unavailable — the dropdown is omitted, cwd falls back.
    }
    try {
      // dsh 0.1.7 reimplements the presets service as agent-preset-registry
      // under the SAME context key with a compatible in-process surface —
      // remoteExportList() still answers the roster (id/name/isDefault),
      // minus the removed `trust` dimension (user-authored rows no longer
      // distinguishable, so the label shows the shipped roster only).
      const presets = this.ctx.get('agentPresets') as
        | { remoteExportList?: () => Promise<{ presets: Array<{ id: string; name?: string; isDefault?: boolean; broken?: boolean }> }> }
        | undefined
      if (presets?.remoteExportList !== undefined) {
        const roster = await presets.remoteExportList()
        const choices = roster.presets
          .filter(preset => preset.broken !== true)
          .map(preset => ({
            value: preset.id,
            label: `${preset.name ?? preset.id}${preset.isDefault === true ? ' ★' : ''}`,
          }))
        if (choices.length > 0) {
          spec.presets = choices
          spec.defaultPreset = roster.presets.find(preset => preset.isDefault === true)?.id ?? choices[0]?.value
        }
      }
    } catch {
      // Preset roster unavailable — the dropdown is omitted.
    }
    const llm = this.ctx.get('llm') as
      | {
          listModels?: (provider: string) => Promise<readonly { id: string; name?: string; contextWindow?: number }[]>
          resolveModelInfo?: (provider: string, model: string) => Promise<{ reasoning?: { efforts?: readonly { id: string; name: string }[] } }>
        }
      | undefined
    const provider = selection?.provider
    if (llm?.listModels !== undefined && provider !== undefined) {
      try {
        const models = await llm.listModels(provider)
        const choices = models.map(model => ({
          value: model.id,
          label: model.name === undefined || model.name === model.id ? model.id : `${model.name} (${model.id})`,
        }))
        if (choices.length > 0) {
          spec.models = choices
          spec.defaultModel = selection?.model
        }
      } catch {
        // Model metadata unavailable — the dropdown is omitted.
      }
    }
    if (llm?.resolveModelInfo !== undefined && provider !== undefined && selection?.model !== undefined) {
      try {
        const info = await llm.resolveModelInfo(provider, selection.model)
        const efforts = info.reasoning?.efforts
        if (efforts !== undefined && efforts.length > 0) {
          spec.efforts = [{ value: DEFAULT_EFFORT, label: '默认' }, ...efforts.map(effort => ({ value: effort.id, label: effort.name }))]
          spec.defaultEffort = selection.reasoningEffort ?? DEFAULT_EFFORT
        }
      } catch {
        // Effort metadata unavailable — the dropdown is omitted.
      }
    }
    const contextParts: string[] = []
    if (provider !== undefined) contextParts.push(`provider：${provider}（换 provider 用 /model）`)
    contextParts.push(`cwd：${cwd.split('/').pop() || cwd}`)
    spec.contextLine = contextParts.join(' · ')
    return spec
  }

  /**
   * The operator submitted (or closed) the /new config card. Only a submit
   * mints a session: the picks overlay the resolved defaults, each absent
   * key keeping the default. The preset id goes to the binder verbatim —
   * omitted resolves the deployment default (issue #2 parity).
   */
  private async handleNewOutcome(outcome: NewSessionOutcome, base: { cwd: string; selection?: ModelSelection }): Promise<void> {
    if (outcome.status !== 'submitted') return
    const picks = outcome.picks
    // The picked workspace path IS the new session's cwd; absent (card
    // without the dropdown) falls back to the resolved cwd.
    const cwd = picks.workspace ?? base.cwd
    const provider = base.selection?.provider
    const model = picks.model ?? base.selection?.model
    let selection: ModelSelection | undefined
    if (provider !== undefined && model !== undefined) {
      let reasoningEffort: ModelSelection['reasoningEffort'] | undefined
      if (picks.effort === undefined) reasoningEffort = base.selection?.reasoningEffort
      else if (picks.effort === DEFAULT_EFFORT) reasoningEffort = undefined
      else reasoningEffort = picks.effort as ModelSelection['reasoningEffort']
      selection = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    }
    // Grey out the live card BEFORE resetRunView clears cardMessageId —
    // the original ordering made this patch dead code.
    await this.closeCardAsDetached()
    this.resetRunView()
    try {
      const created = await this.binder.createNew(cwd, selection, picks.preset)
      if (created.model !== undefined) {
        this.selectionRefs.set(created.sessionId, created.model)
      }
      void this.learnPreset(created.sessionId, picks.preset)
      await this.store.update({ boundSessionId: created.sessionId, picker: undefined })
      const rows: NewSummaryRow[] = [
        { field: 'Workspace', value: cwd.split('/').pop() || cwd },
        { field: 'Preset', value: picks.preset ?? '环境默认' },
        { field: 'Model', value: provider !== undefined || model !== undefined ? [provider, model].filter(Boolean).join(' / ') : '环境默认' },
        { field: 'Think', value: picks.effort ?? base.selection?.reasoningEffort ?? DEFAULT_EFFORT },
        { field: 'Session', value: created.sessionId.slice(0, 8) },
      ]
      await this.lark.patchCard(outcome.messageId, buildNewSessionCreatedCard(rows, created.sessionId))
    } catch (error) {
      // Creation failed — ensure we stay cleanly unbound and say why.
      await this.binder.detach()
      await this.store.update({ boundSessionId: undefined })
      this.ctx.logger.warn('dsh-feishu: /new create failed: %o', error)
      const reason = clipLine(String(error instanceof Error ? error.message : error), 200)
      await this.lark.patchCard(outcome.messageId, buildNewSessionFailedCard(reason === '' ? '未知错误' : reason)).catch(() => undefined)
      await this.reply(`新会话创建失败：${reason === '' ? '未知错误' : reason}`)
    }
  }

  private async handleStop(): Promise<void> {
    if (this.binder.getAgent()?.status !== 'running') {
      await this.reply('没有正在执行的任务。')
      return
    }
    await this.stopNow()
  }

  /** The everything-stop: phone-side btw calls die too. */
  private async stopNow(): Promise<void> {
    this.btw.cancelAll()
    const agent = this.binder.getAgent()
    if (agent === undefined || agent.status !== 'running') return
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      // Background/continuable children survive the parent cancel (they do
      // not ride the tool call's abort signal) — sweep every live child the
      // run state tracks, the same everything-stop leg the TUI's bridge
      // provides (dsh-tui-pi 2.10.0). keepInbox preserves a continuable
      // child's queued work; this stops the running turn, not the child.
      const agents = (this.ctx as Context & { agents?: { get(id: string): { cancel(cause: unknown, options?: { keepInbox?: boolean }): void } | undefined } | undefined }).agents
      for (const row of subagentRows(this.runState)) {
        if (row.outcome !== undefined) continue
        try {
          agents?.get(row.childId)?.cancel({ kind: 'user' }, { keepInbox: true })
        } catch {
          // Child not live in this process — nothing to stop.
        }
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: stop failed: %o', error)
      await this.reply('停止指令发送失败。')
    }
  }

  /**
   * Round-card quick action: ⛔ 停止 is exactly the /stop path (btw calls die
   * too); ▶️ 继续 nudges the agent with the literal word — a turn that ended
   * mid-work (or an unattended question in text) picks up from there. The
   * injected prompt IS the feedback when it lands; only refusals need a reply.
   */
  private async handleRoundAction(op: RoundActionOp): Promise<void> {
    if (op === 'stop') {
      await this.handleStop()
      return
    }
    const outcome = await this.injectPrompt('继续')
    if (outcome === 'refused') {
      await this.reply(this.binder.isReadOnlyView()
        ? '当前为只读旁观（该会话正由另一进程驱动），无法从这里派活。'
        : '还没有选会话。发 /new 新建一个会话，或发 /resume 进入网页里已有的会话。')
    }
  }

  private async handleSub(n: number): Promise<void> {
    const rows = subagentRows(this.runState)
    if (rows.length === 0) {
      await this.reply('当前 turn 没有子代理活动。')
      return
    }
    if (n < 1 || n > rows.length) {
      await this.reply(`序号超出范围（1–${rows.length}）。`)
      return
    }
    const row = rows[n - 1]!
    const status = row.outcome === undefined ? '运行中' : `已结束（${row.outcome}）`
    const lines = [
      `🧵 ${row.label} · ${status}`,
      `round ${row.rounds}${row.lastTool !== undefined ? ` · 最近工具 ${row.lastTool}` : ''}`,
    ]
    if (row.tail !== undefined) lines.push(`最新输出：${clipLine(row.tail, 500)}`)
    else lines.push('（暂无输出）')
    await this.reply(lines.join('\n'))
  }

  private async handlePassthrough(name: string, line: string): Promise<void> {
    const agent = await this.ensureBoundAgent()
    if (agent === undefined) {
      await this.reply('还没有选会话。发 /new 新建一个会话，或发 /resume 进入网页里已有的会话。')
      return
    }
    const commands = this.ctx.get('commands') as
      | {
          execute(
            agent: Agent,
            line: string,
            images: readonly unknown[],
            signal: AbortSignal,
          ): Promise<{ result?: { kind?: string; text?: string } } | undefined>
          find?: (agent: Agent, name: string) => unknown
        }
      | undefined
    if (commands === undefined) {
      await this.reply('当前 profile 没有命令服务，无法透传。')
      return
    }
    if (commands.find?.(agent, name) === undefined) {
      await this.reply(`命令 /${name} 在当前环境不可用。`)
      return
    }
    try {
      // alpha.3 signature: execute(agent, line, images, signal) — the images
      // array is mandatory (pass empty for text-only passthrough).
      const execution = commands.execute(agent, line, [], AbortSignal.timeout(30_000))
      const outcome = await execution
      const text = outcome?.result?.text
      if (outcome?.result?.kind === 'error') {
        await this.reply(`/${name} 执行失败：${clipLine(text ?? '未知错误', 500)}`)
      } else if (text !== undefined && text !== '') {
        await this.replyLong(text)
      } else {
        await this.reply(`/${name} 已执行。`)
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: passthrough /%s failed: %o', name, error)
      await this.reply(`/${name} 执行出错。`)
    }
  }

  /**
   * Shared prompt-injection channel (operator messages AND the interactive
   * adapters' skill activation): running turns get steered (join the CURRENT
   * turn's next round), idle sessions open the next turn. 'refused' covers
   * the read-only view and the missing binding — callers word their replies.
   * Content is a block array: text for prompts, text+image for pictures.
   */
  private async injectContent(content: readonly ContentBlock[], messages: InboundMessage[] = []): Promise<'steered' | 'opened' | 'refused'> {
    if (content.length === 0) return 'refused'
    if (this.binder.isReadOnlyView()) return 'refused'
    const agent = await this.ensureBoundAgent()
    if (agent === undefined) return 'refused'
    const userMessage = createUserMessage({
      content: [...content],
      source: { kind: 'user' },
    })
    if (messages.length) this.pendingPrompts.set(userMessage.id, { messages, sessionId: String(agent.id ?? this.binder.getSessionId()) })
    try {
      if (agent.status === 'running') {
        agent.steer(userMessage)
        return 'steered'
      }
      agent.followup(userMessage)
      return 'opened'
    } catch (error) {
      await this.pendingPrompts.get(userMessage.id)?.preview?.finish('消息未能进入会话')
      this.pendingPrompts.delete(userMessage.id)
      throw error
    }
  }

  private async injectPrompt(text: string): Promise<'steered' | 'opened' | 'refused'> {
    if (text === '') return 'refused'
    return this.injectContent([{ type: 'text', text }])
  }

  private drainQueuedPrompts(): void {
    this.binder.drainOutboxIntoAgent(id => {
      const message = this.queuedMessages.shift()
      if (message) this.pendingPrompts.set(id, { messages: [message], sessionId: this.binder.getSessionId()! })
    })
  }

  private admitted(message: InboundMessage): boolean {
    return decidePairing({ chatType: message.chatType, senderOpenId: message.openId,
      configOperators: [...this.allowlist], pairedOperators: this.store.get().pairedOperators ?? [] }).kind === 'allow'
      && (message.chatType !== 'group' || this.groupGate(message))
  }

  private isPromptMessage(message: InboundMessage): boolean {
    if (['image', 'post', 'file', 'merge_forward'].includes(message.messageType)) return true
    const text = mentionText(message.text ?? '', message.mentions, this.botOpenId)
    return !!text && classifyInbound(text).kind === 'prompt'
  }

  private acknowledge(message: InboundMessage): Promise<string | undefined> {
    let pending = this.acknowledgements.get(message.messageId)
    if (!pending) {
      pending = this.lark.react(message.messageId, EMOJI_PROCESSING).catch(error => {
        this.ctx.logger.debug?.('dsh-feishu: acknowledgement failed: %o', error)
        return undefined
      })
      this.acknowledgements.set(message.messageId, pending)
    }
    return pending
  }

  private async clearAcknowledgements(messages: readonly InboundMessage[], done = false): Promise<void> {
    for (const message of messages) {
      const pending = this.acknowledgements.get(message.messageId)
      this.acknowledgements.delete(message.messageId)
      const id = await pending
      if (id) await this.lark.deleteReaction(message.messageId, id)
      if (done) await this.lark.react(message.messageId, EMOJI_DONE)
    }
  }

  private target(message: InboundMessage): MessageTarget {
    return { chatId: message.chatId, messageId: message.messageId, threadId: message.threadId }
  }

  private async submitContent(messages: InboundMessage[], content: readonly ContentBlock[]): Promise<void> {
    const trigger = messages.at(-1)!
    try {
      let outcome = await this.injectContent(content, messages)
      if (outcome === 'refused' && this.binder.getSessionId() === undefined && !this.binder.isReadOnlyView()) {
        try {
          const created = await this.binder.createNew(this.newSessionCwd(undefined), this.newSessionDefaultSelection(undefined), undefined)
          if (created.model !== undefined) this.selectionRefs.set(created.sessionId, created.model)
          await this.store.update({ boundSessionId: created.sessionId, picker: undefined })
          outcome = await this.injectContent(content, messages)
        } catch (error) { this.ctx.logger.warn('dsh-feishu: auto-new failed: %o', error) }
      }
      if (outcome === 'refused') {
        await this.clearAcknowledgements(messages)
        await this.sendFinal(this.target(trigger), '还没有选会话。发 /new 新建一个会话，或发 /resume 进入网页里已有的会话。')
      }
    } catch (error) {
      for (const [id, pending] of this.pendingPrompts) if (pending.messages === messages) {
        await pending.preview?.finish('消息未能进入会话')
        this.pendingPrompts.delete(id)
      }
      await this.clearAcknowledgements(messages)
      await this.sendFinal(this.target(trigger), '消息未能进入会话，请重发一次。')
      this.ctx.logger.warn('dsh-feishu: injection failed: %o', error)
    }
  }

  private async handlePrompt(message: InboundMessage, text: string): Promise<void> {
    if (!text) return
    await this.acknowledge(message)
    if (this.binder.isReadOnlyView()) {
      this.queuedMessages.push(message)
      this.binder.queueRemoteFollowup(text)
      await this.reply(`已排队（第 ${this.binder.outboxSize()} 条）：该会话正由另一进程驱动，对面释放后自动接管并发出；/resume 或 /new 可切换。`)
      return
    }
    await this.submitContent([message], [{ type: 'text', text }])
  }

  private batchKey(message: InboundMessage): string {
    return JSON.stringify([message.chatId, message.threadId ?? '', message.openId])
  }
  private takeImageBatch(message: InboundMessage): InboundMessage[] {
    const key = this.batchKey(message)
    const batch = this.imageBatches.get(key)
    if (!batch) return []
    clearTimeout(batch.timer)
    this.imageBatches.delete(key)
    return batch.messages
  }
  private bufferImage(message: InboundMessage): void {
    const messages = [...this.takeImageBatch(message), message]
    const timer = setTimeout(() => {
      this.imageBatches.delete(this.batchKey(message))
      // Media preparation stays in the inbound serial drain. ACKs already started.
      this.queue.push(messages)
      void this.drain()
    }, 800)
    timer.unref?.()
    this.imageBatches.set(this.batchKey(message), { messages, timer })
  }
  private async imageBlock(image: ResourceImage): Promise<ContentBlock> {
    const attachments = this.ctx.get('attachments') as AttachmentsLike | undefined
    if (!attachments) throw new Error('当前 profile 没有附件服务，图片无法进会话。')
    const bytes = await this.lark.downloadImage(image.messageId, image.key)
    if (!bytes?.length) throw new Error('图片下载失败，请重发一次。')
    const mediaType = sniffImageMediaType(bytes)
    if (!mediaType) throw new Error('不支持的图片格式（仅 png / jpeg / webp / gif 可进会话）。')
    if (attachments.imageLimits && bytes.length > attachments.imageLimits.maxImageBytes) throw new Error('图片超过大小上限，无法发给伙伴。')
    const ref = await attachments.saveImage({ data: bytes, mediaType, name: `feishu-image.${imageExtensionOf(mediaType)}` }) as ImageAttachmentRef
    return { type: 'image', attachment: ref }
  }

  private async handleMedia(message: InboundMessage, buffered: InboundMessage[]): Promise<void> {
    const messages = [...buffered, message]
    for (const item of messages) await this.acknowledge(item)
    try {
      if (this.store.get().lastChatId !== message.chatId) await this.store.update({ lastChatId: message.chatId })
      if (this.binder.isReadOnlyView()) throw new Error('当前为只读旁观（该会话正由另一进程驱动），附件无法注入；发 /resume 切换会话。')
      let text = message.text ?? ''
      const images: ResourceImage[] = []
      for (const item of messages) {
        if (item.messageType === 'image' && !item.imageKey) throw new Error('图片消息缺少可下载的资源，无法注入。')
        if (item.imageKey) images.push({ messageId: item.messageId, key: item.imageKey })
        for (const key of item.imageKeys ?? []) images.push({ messageId: item.messageId, key })
      }
      const quote = message.parentId ? await replyChain(this.lark, message.parentId) : undefined
      if (message.messageType === 'merge_forward') {
        const forward = await forwardedContent(this.lark, message.messageId)
        if (!forward) throw new Error('合并转发的内容读取失败，请把内容直接发过来。')
        text = [text, forward.text].filter(Boolean).join('\n')
        images.push(...forward.images)
      }
      const content: ContentBlock[] = []
      for (const image of images) content.push(await this.imageBlock(image))
      if (quote) {
        try {
          const quotedImages: ContentBlock[] = []
          for (const image of quote.images) quotedImages.push(await this.imageBlock(image))
          content.push(...quotedImages)
          text = quote.text + text
        } catch { /* resource permission denial: inject only the user's own content */ }
      }
      if (message.messageType === 'file') {
        const attachments = this.ctx.get('attachments') as AttachmentsLike | undefined
        if (!message.fileKey || !attachments?.saveFile) throw new Error('文件下载失败，请重发一次。')
        const bytes = await this.lark.downloadFile(message.messageId, message.fileKey)
        if (!bytes) throw new Error('文件下载失败，请重发一次。')
        try { content.push({ type: 'file', attachment: await attachments.saveFile({ data: bytes, name: message.fileName }) }) }
        catch (error) {
          if (/size|limit|large|大小|上限/i.test(String(error))) throw new Error('文件超过大小上限，无法发给伙伴。')
          throw new Error('文件下载失败，请重发一次。')
        }
      }
      if (text) content.push({ type: 'text', text })
      if (!content.length) throw new Error('消息没有可读取的内容，请重发一次。')
      await this.submitContent(messages, content)
    } catch (error) {
      await this.clearAcknowledgements(messages)
      await this.sendFinal(this.target(message), error instanceof Error ? error.message : '附件读取失败，请重发一次。')
    }
  }

  /**
   * Model route for a COLD resume: the target session's own log route first
   * (sessions created before the route fix have none), then the settings'
   * default model. Without it a resumed agent can come back route-less and
   * every message dies with "agent has no provider/model".
   */
  private async resolveResumeRoute(sessionId: string): Promise<{ provider: string; model: string } | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence !== undefined) {
      try {
        const { events } = await readPersistedSession(persistence, SessionId(sessionId))
        const backfill = backfillRouteFromLog(events)
        if (backfill.provider !== undefined && backfill.model !== undefined) {
          return { provider: backfill.provider, model: backfill.model }
        }
      } catch {
        // unreadable log — fall through to the default model
      }
    }
    const defaultModel = this.ctx.get('agentDefaultModel') as
      | { currentSelection?: () => { provider?: string; model?: string } | undefined }
      | undefined
    const fallback = defaultModel?.currentSelection?.()
    if (fallback?.provider !== undefined && fallback?.model !== undefined) {
      return { provider: fallback.provider, model: fallback.model }
    }
    return undefined
  }

  /** Resolve the bound session to a live agent, resuming it if needed. */
  private async ensureBoundAgent(): Promise<Agent | undefined> {
    const id = this.binder.getSessionId() ?? this.store.get().boundSessionId
    if (id === undefined) return undefined
    const live = this.binder.getAgent()
    if (live !== undefined) return live
    try {
      const bound = await this.binder.bind(id, await this.resolveResumeRoute(id))
      await this.store.update({ boundSessionId: id })
      void this.learnPreset(id)
      this.backfillRoute()
      this.maybeOpenCardForRunningAgent()
      return bound.agent
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------ firehose --

  /** Route one live stream frame to the bound-session or child fold. */
  private onStreamFrame(agent: { readonly id: SessionId }, frame: StreamFrame): void {
    if (this.disposed || frame.type !== 'chunk') return
    const sessionId = String(agent.id)
    const boundId = this.binder.getSessionId()
    if (boundId === undefined) return
    if (sessionId === boundId) {
      foldBoundStreamChunk(this.runState, frame.chunk, frame.time ?? 0)
      if (frame.chunk?.type === 'text-delta' && frame.chunk.text) this.turnOutput?.preview?.delta(frame.chunk.text)
      return
    }
    // Children: frames only refine tails of rows the firehose already
    // discovered; unknown ids would race the descriptor and are ignored —
    // the settlement (`assistant/message`) builds the tail authoritatively.
    if (this.runState.subagents.has(sessionId)) {
      foldChildStreamChunk(this.runState, sessionId, frame.chunk)
    }
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.disposed) return
    const sessionId = String(session.id)
    // The stored session may have become live only now (the desktop opened it
    // after this plugin started). Finish the attach before the pipeline reads
    // the binding below — while unbound this event is otherwise dropped and the
    // phone stays silent until the operator happens to touch the bot.
    if (this.binder.getSessionId() === undefined && this.store.get().boundSessionId === sessionId) {
      void this.attachStoredBindingIfLive('session became live')
    }
    const boundId = this.binder.getSessionId()
    if (boundId !== undefined && sessionId === boundId) {
      foldBoundEvent(this.runState, event)
      if (event.type === 'turn/start') {
        // Request preparation can fail before user/message is committed. Keep
        // a provisional origin so that failure still clears the prompt's OnIt.
        const waiting = [...this.pendingPrompts.values()].find(pending => pending.sessionId === sessionId)
        this.turnMessages = waiting?.messages ?? []
        const target = waiting ? this.target(waiting.messages.at(-1)!) : undefined
        if (waiting && target) {
          waiting.preview ??= new Preview(this.lark, target, this.now, this.config.previewIntervalMs)
          waiting.preview.start()
        }
        this.turnOutput = new TurnOutput(waiting?.preview, target)
        this.turnHasUser = false
      } else if (event.type === 'user/message') {
        const pending = this.pendingPrompts.get(event.data.id)
        if (!['user', 'dsh-feishu'].includes(String(event.data.source.kind))) return
        if (!this.turnHasUser && !pending) {
          this.turnOutput = new TurnOutput()
          this.turnMessages = []
        }
        if (pending && pending.sessionId === sessionId) {
          this.pendingPrompts.delete(event.data.id)
          if (!this.turnHasUser) {
            this.turnMessages = pending.messages
            const target = this.target(pending.messages.at(-1)!)
            pending.preview ??= new Preview(this.lark, target, this.now, this.config.previewIntervalMs)
            pending.preview.start()
            this.turnOutput = new TurnOutput(pending.preview, target)
          } else {
            void pending.preview?.finish('已加入本轮')
            void this.clearAcknowledgements(pending.messages, true)
          }
        }
        this.turnHasUser = true
      } else if (event.type === 'assistant/message') {
        this.turnOutput ??= new TurnOutput()
        // Match streamed deltas verbatim, including whitespace between text blocks.
        this.turnOutput.assistant(event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
          event.data.message.content.some(block => block.type === 'tool-call'))
      } else if (event.type === 'tool/call') {
        this.turnOutput?.tool(event.data.callId, toolProgress(event.data.name, event.data.arguments))
      } else if (event.type === 'turn/end') {
        const output = this.turnOutput ?? new TurnOutput()
        const messages = this.turnMessages
        const reason = this.runState.turnEndReason
        const error = this.runState.lastError
        const endReason = event.data.reason
        const endError = endReason.kind === 'error' ? endReason.error.message : error
        for (const [id, pending] of this.pendingPrompts) {
          if (pending.messages === messages) this.pendingPrompts.delete(id)
        }
        this.turnOutput = undefined
        this.turnMessages = []
        const lastChatId = this.store.get().lastChatId
        const endedAt = this.now()
        void this.chain(() => this.finishOutput(output, messages, reason, endError,
          lastChatId ? { chatId: lastChatId } : undefined, endedAt))
      }
      return
    }
    const header = session.header as
      | { parentSession?: string; origin?: string; delegationDepth?: number }
      | undefined
    if (
      boundId !== undefined
      && header?.parentSession !== undefined && String(header.parentSession) === boundId
      && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
    ) {
      const known = this.runState.subagents.has(sessionId)
      foldChildEvent(this.runState, sessionId, event)
      if (!known) this.backfillChild(sessionId)
      return
    }
    // Every other session in the process is background-push territory (the
    // profile-level firehose delivers them all).
    this.trackBackgroundPush(session, sessionId, event)
  }

  /**
   * Background completion push: fold non-bound ROOT sessions' events into a
   * per-session scratch and, at turn/end, push a compact card when the config
   * mode covers the cause. Bound sessions never double-push (their live round
   * cards already flow); subagent children are skipped (their settlement
   * reaches the parent as a subagent-settled notice, which IS pushed).
   */
  private trackBackgroundPush(session: Session, sessionId: string, event: SessionEvent): void {
    if (this.config.backgroundPush === 'off') return
    const header = session.header as { parentSession?: unknown } | undefined
    if (header?.parentSession !== undefined) return
    let track = this.pushTracks.get(sessionId)
    if (track === undefined) {
      track = initialPushTrack()
      this.pushTracks.set(sessionId, track)
      // Bound the scratch: drop the oldest id in insertion order.
      if (this.pushTracks.size > 64) {
        const oldest = this.pushTracks.keys().next().value
        if (oldest !== undefined) this.pushTracks.delete(oldest)
      }
    }
    const cause = foldPushEvent(track, event)
    if (cause === undefined || !shouldPush(this.config.backgroundPush, cause)) return
    const chatId = this.store.get().lastChatId
    this.pushTracks.delete(sessionId)
    if (chatId === undefined) return
    const durationMs = track.turnStartedAt !== undefined && typeof event.time === 'number'
      ? Math.max(0, event.time - track.turnStartedAt)
      : undefined
    const card = buildPushCard({
      cause: pushCauseLabel(cause),
      reason: track.endReason,
      sessionLabel: sessionId.slice(0, 8),
      lastAssistant: track.lastAssistant,
      durationMs,
    })
    void this.chain(() => this.lark.sendCard(chatId, card as Schema2Card)).catch(() => undefined)
  }

  /**
   * Backfill the route facts (provider/model/think level/context window and
   * the cache-hit segment) from the BOUND session's own log. The route events
   * are appended only at session start or on a route change, so a mid-run
   * bind never sees them live — without this the footer shows no model, no
   * think level and a windowless ctx. Runs once per bound session; best-effort.
   */
  private backfillRoute(): void {
    const id = this.binder.getSessionId()
    if (id === undefined || this.routeBackfilledFor === id) return
    // ctx.get (NOT property access): a service not declared in `inject`
    // throws "cannot get property ... without inject" on property access —
    // this bug turned successful binds into failure replies in live use.
    const sessions = this.ctx.get('sessions') as
      | { get(id: string): { events?: unknown[] } | undefined }
      | undefined
    if (sessions === undefined) return
    try {
      const events = sessions.get(id)?.events
      if (!Array.isArray(events) || events.length === 0) return
      applyRouteBackfill(this.runState, backfillRouteFromLog(events as SessionEvent[]))
      this.routeBackfilledFor = id
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: route backfill for %s failed: %o', id, error)
    }
  }

  /**
   * Backfill a newly discovered child row from the child's OWN session log.
   * Discovery can happen long after spawn (mid-turn attach) or with the
   * child's events beating the parent's agent-start — either way the naming
   * events never reach the live firehose, and without this the card shows the
   * bare hash prefix instead of the agent name. Best-effort: no sessions
   * service or an unreadable log just keeps the fallback label.
   */
  private backfillChild(childId: string): void {
    // ctx.get (NOT property access): a service not declared in `inject`
    // throws "cannot get property ... without inject" on property access —
    // this bug turned successful binds into failure replies in live use.
    const sessions = this.ctx.get('sessions') as
      | { get(id: string): { events?: unknown[] } | undefined }
      | undefined
    if (sessions === undefined) return
    try {
      const events = sessions.get(childId)?.events
      if (!Array.isArray(events) || events.length === 0) return
      applyChildBackfill(this.runState, childId, backfillFromChildLog(events as SessionEvent[]))
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: child backfill for %s failed: %o', childId, error)
    }
  }

  // ---------------------------------------------------------- status card --

  /**
   * Learn a session's preset: the operator's explicit /new pick when given,
   * else the host's sessionQuery projection of `agent-preset/selected` (the
   * same record binder.presetOfSession reads for resume rejoins). Best-effort
   * — a missing/failed query leaves the cache untouched, the footer omits
   * the field, and nothing else depends on it.
   */
  private async learnPreset(sessionId: string, picked?: string): Promise<void> {
    if (picked !== undefined) {
      this.presetBySession.set(sessionId, picked)
      return
    }
    try {
      const query = this.ctx.get('sessionQuery') as
        | { observeSession(id: SessionId): Promise<{ projections?: { values?: { agentPreset?: unknown } } } | undefined> }
        | undefined
      const observation = await query?.observeSession(SessionId(sessionId))
      const preset = observation?.projections?.values?.agentPreset
      if (typeof preset === 'string' && preset !== '') this.presetBySession.set(sessionId, preset)
    } catch {
      // Best-effort — footer simply stays without the field.
    }
  }

  private maybeOpenCardForRunningAgent(): void {
    if (this.binder.getAgent()?.status === 'running' && !this.runState.running) {
      this.runState.running = true
      this.runState.turnStartedAt = this.now()
      this.turnOutput ??= new TurnOutput()
    }
  }

  private async sendFinal(target: MessageTarget, text: string): Promise<void> {
    const post = markdownTableCount(text) > 5
    const segments = segmentText(text, this.config.bodySegmentChars ?? 4000)
    let plain = false
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!
      const type = plain ? 'text' : post ? 'post' : 'interactive'
      const content = type === 'text' ? { text: segment } : post
        ? { zh_cn: { content: [[{ tag: 'md', text: segment }]] } } : buildBodyCard(segment)
      let sent = await this.lark.sendMessage(target, type, content)
      if (!sent) sent = await this.lark.sendMessage(target, type, content)
      if (!sent && !plain) {
        plain = true
        await this.lark.sendMessage(target, 'text', { text: segment })
      }
    }
  }

  private async finishOutput(output: TurnOutput, messages: InboundMessage[], reason?: string, error?: string, fallbackTarget?: MessageTarget, endedAt = this.now()): Promise<void> {
    let override: string | undefined
    if (reason === 'error') {
      override = /Session not found/i.test(error ?? '') ? '⚠️ 会话已过期，请发送 /new 开始新会话' : `❌ 错误: ${error || '本轮执行失败'}`
    } else if (reason === 'aborted' || reason === 'stopped') override = '⏹ 执行已停止。'
    let body = output.body(override)
    if (reason === 'max-tokens') body += '\n⚠️ 达到长度上限'
    if (reason === 'blocked') body += '\n🚫 被拦截'
    const status = reason === 'error' ? `失败：${error || '本轮执行失败'}`
      : reason === 'aborted' || reason === 'stopped' ? '已停止'
      : reason === 'max-tokens' ? '已达到长度上限'
      : reason === 'blocked' ? '已被拦截' : '已完成'
    const retained = await output.preview?.finish(status.slice(0, 500), body, endedAt)
    const target = output.target ?? fallbackTarget
    if (target) {
      if (!retained?.delivered || retained.overflow) await this.sendFinal(target, body)
      else {
        const threshold = this.config.completionReminderSeconds ?? 60
        if (threshold > 0 && retained.elapsedMs > threshold * 1000) {
          await this.lark.sendMessage(target, 'text', { text: '做完了，结果在上面。' })
        }
      }
    }
    await this.clearAcknowledgements(messages)
  }

  private async closeCardAsDetached(): Promise<void> {
    await this.turnOutput?.preview?.finish('会话已解绑（/resume 可重新进入）')
    await this.clearAcknowledgements(this.turnMessages)
    await this.clearAcknowledgements(this.queuedMessages)
    this.queuedMessages = []
    for (const pending of this.pendingPrompts.values()) {
      await pending.preview?.finish('会话已解绑（/resume 可重新进入）')
      await this.clearAcknowledgements(pending.messages)
    }
    this.pendingPrompts.clear()
    for (const batch of this.imageBatches.values()) {
      clearTimeout(batch.timer)
      await this.clearAcknowledgements(batch.messages)
    }
    this.imageBatches.clear()
    this.turnOutput = undefined
    this.turnMessages = []
  }

  /** Clear the run view (new binding / detach) — no history replay. */
  private resetRunView(): void {
    const fresh = initialRunState(this.config.toolDetail)
    Object.assign(this.runState, fresh)
    this.runState.subagents = fresh.subagents
    this.runState.runSeqToChild = fresh.runSeqToChild
    this.resumeCardMessageId = undefined
    this.modelFlow = undefined
    this.routeBackfilledFor = undefined
    // Pending selection cards die with the old view — the new binding must
    // not inherit submits meant for it.
    this.selectors.cancelAll('run view reset')
  }

  // ------------------------------------------------------------- /model --

  /** The llm service surface the model cards need (structural). */
  private llm(): LlmModelSurface | undefined {
    return this.ctx.get('llm') as LlmModelSurface | undefined
  }

  /**
   * Enrich a provider's model list with each model's context window, resolved
   * in bounded-parallel and fail-open (a resolution failure leaves the model
   * without a window rather than failing the picker). The catalog entries from
   * `listModels` carry no context — only `resolveModelInfo` knows it.
   */
  private async enrichModelsWithContext(
    llm: LlmModelSurface,
    provider: string,
    models: readonly ModelInfo[],
  ): Promise<readonly ModelInfo[]> {
    if (typeof llm.resolveModelInfo !== 'function') return models
    const CONCURRENCY = 6
    const out: ModelInfo[] = new Array(models.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < models.length) {
        const index = cursor
        cursor += 1
        const model = models[index]!
        try {
          const info = await llm.resolveModelInfo(provider, model.id)
          const window = info.context?.contextWindow
          out[index] = typeof window === 'number' && Number.isFinite(window) && window > 0
            ? { ...model, contextWindow: window }
            : model
        } catch {
          out[index] = model
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, models.length) }, worker))
    return out
  }

  /**
   * /model step 1: list the registered providers (grouped classification —
   * the next step lists the chosen provider's models).
   */
  private async handleModel(): Promise<void> {
    const chatId = this.store.get().lastChatId
    const llm = this.llm()
    if (chatId === undefined || llm === undefined || typeof llm.listProviders !== 'function') {
      await this.reply('当前 profile 没有 llm 服务，无法列出模型。')
      return
    }
    const providers = [...llm.listProviders()].sort((a, b) => a.name.localeCompare(b.name))
    if (providers.length === 0) {
      await this.reply('没有已注册的 provider。')
      return
    }
    const flowId = randomUUID()
    this.modelFlow = { id: flowId, provider: undefined, providerCardMessageId: undefined, cardMessageId: undefined }
    const current = this.runState.provider !== undefined && this.runState.model !== undefined
      ? { provider: this.runState.provider, model: this.runState.model }
      : undefined
    const messageId = await this.lark.sendCard(chatId, buildModelProviderCard(providers, flowId, current))
    if (messageId !== undefined) this.modelFlow.providerCardMessageId = messageId
  }

  /** /model step 2: list the chosen provider's models. */
  private async handleModelProviderPicked(parsed: { provider: string; flowId: string }): Promise<void> {
    if (this.modelFlow === undefined || this.modelFlow.id !== parsed.flowId) return
    const llm = this.llm()
    if (llm === undefined || typeof llm.listModels !== 'function') return
    let models: readonly ModelInfo[]
    try {
      models = await llm.listModels(parsed.provider)
    } catch (error) {
      await this.reply(`列出模型失败：${clipLine(String(error instanceof Error ? error.message : error), 200)}`)
      return
    }
    if (models.length === 0) {
      await this.reply(`provider ${parsed.provider} 没有可用模型。`)
      return
    }
    // Context windows come from resolveModelInfo, not the catalog — enrich
    // best-effort so the picker shows `· 128k ctx` per model when known.
    let enriched: readonly ModelInfo[] = models
    try {
      enriched = await this.enrichModelsWithContext(llm, parsed.provider, models)
    } catch {
      // Enrichment is cosmetic — a failure degrades to the plain catalog.
    }
    this.modelFlow.provider = parsed.provider
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    const messageId = await this.lark.sendCard(chatId, buildModelPickCard(parsed.provider, enriched, parsed.flowId))
    if (this.modelFlow === undefined) return
    // Grey out the provider card — the flow moved on; a stale submit there
    // would otherwise be a silent no-op.
    if (this.modelFlow.providerCardMessageId !== undefined) {
      const providerCardId = this.modelFlow.providerCardMessageId
      void this.chain(() => this.lark.patchCard(providerCardId, buildModelProviderSettledCard(parsed.provider)))
      this.modelFlow.providerCardMessageId = undefined
    }
    if (messageId !== undefined) this.modelFlow.cardMessageId = messageId
  }

  /**
   * Shared model-selection apply core — /model submits AND the interactive
   * adapters (/think, /profile-switch) land here so the live-switch and
   * phone-default branches cannot drift apart. Live-switches bot-created
   * sessions through their agent-owned selection surface (an absent effort
   * follows adapter defaults without inheriting a previous one —
   * Model.select's contract, same clear semantics the old mutable ref had);
   * otherwise remembers the pick as the phone default (used by /new,
   * honored on the next live bind).
   */
  private async applyModelSelection(selection: ModelSelectionUpdate): Promise<'live' | 'phone-default'> {
    const bound = this.binder.getSessionId()
    const surface = bound === undefined ? undefined : this.selectionRefs.get(bound)
    if (surface !== undefined) {
      surface.select({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort as ModelSelection['reasoningEffort'] }),
      })
      return 'live'
    }
    await this.store.update({
      phoneModel: selection.reasoningEffort === undefined
        ? { provider: selection.provider, model: selection.model }
        : { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort },
    })
    return 'phone-default'
  }

  /**
   * Best-effort current model selection of the BOUND session — the data
   * source for the interactive /think adapter. Chain (mirrors the /model
   * and cold-resume routes): the bot-owned selection ref, the run view
   * (live route folds + the bind-time log backfill), the persisted log
   * itself, then the settings' default model. Undefined = nothing known.
   */
  private async currentModelSelection(): Promise<CurrentSelection | undefined> {
    const bound = this.binder.getSessionId() ?? this.store.get().boundSessionId
    if (bound !== undefined) {
      const refSelection = this.selectionRefs.get(bound)?.current()
      if (refSelection?.provider !== undefined && refSelection.model !== undefined) {
        return {
          provider: refSelection.provider,
          model: refSelection.model,
          ...(refSelection.reasoningEffort === undefined ? {} : { reasoningEffort: refSelection.reasoningEffort }),
        }
      }
    }
    if (this.runState.provider !== undefined && this.runState.model !== undefined) {
      return {
        provider: this.runState.provider,
        model: this.runState.model,
        ...(this.runState.reasoningEffort === undefined ? {} : { reasoningEffort: this.runState.reasoningEffort }),
      }
    }
    if (bound !== undefined) {
      const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
      if (persistence !== undefined) {
        try {
          const { events } = await readPersistedSession(persistence, SessionId(bound))
          const backfill = backfillRouteFromLog(events)
          if (backfill.provider !== undefined && backfill.model !== undefined) {
            return {
              provider: backfill.provider,
              model: backfill.model,
              ...(backfill.reasoningEffort === undefined ? {} : { reasoningEffort: backfill.reasoningEffort }),
            }
          }
        } catch {
          // unreadable log — fall through to the default model
        }
      }
      const defaultModel = this.ctx.get('agentDefaultModel') as
        | { currentSelection?: () => ModelSelection | undefined }
        | undefined
      const fallback = defaultModel?.currentSelection?.()
      if (fallback?.provider !== undefined && fallback?.model !== undefined) {
        return { provider: fallback.provider, model: fallback.model }
      }
    }
    return undefined
  }

  /**
   * /model submit: live-switch bot-created sessions through their selection
   * ref; otherwise remember the pick as the phone default (used by /new)
   * and point desktop-driven sessions at the desktop switcher.
   */
  private async handleModelSubmitted(parsed: { flowId: string; model: string }): Promise<void> {
    const flow = this.modelFlow
    if (flow === undefined || flow.id !== parsed.flowId || flow.provider === undefined) return
    this.modelFlow = undefined
    const selection: ModelSelectionUpdate = { provider: flow.provider, model: parsed.model }
    const target = await this.applyModelSelection(selection)
    const bound = this.binder.getSessionId()
    const chatId = this.store.get().lastChatId
    if (chatId !== undefined) {
      const note = target === 'live'
        ? undefined
        : bound === undefined
          ? '已存为手机默认模型（/new 的新会话将使用它）。'
          : '已存为手机默认模型；当前会话由桌面驱动，请在电脑端 /model 切换。'
      const cardId = flow.cardMessageId
      if (cardId !== undefined) {
        void this.chain(() => this.lark.patchCard(cardId, buildModelSettledCard(selection.provider, selection.model, note)))
      } else {
        await this.reply(`✅ ${selection.provider} / ${selection.model}${note === undefined ? '' : '\n' + note}`)
      }
    }
  }

  // ---------------------------------------------------------- ask surface --

  /**
   * Register the phone as an ask-user surface. With dsh-ask-router present
   * this registers as one surface among several (first answer wins across
   * surfaces). Without it: a claim-scoped 'user-questions/request' cordis
   * waterfall answerer — answer by returning, delegate unclaimed asks via
   * next(). (alpha.3 removed the rc-era registerProvider slot along with its
   * DUPLICATE_PROVIDER yield protocol; the waterfall is the host's single
   * dispatch.)
   */
  private registerAskSurface(): void {
    const ask = (request: AskRequestLike): Promise<AskUserQuestionAnswer> => this.askViaCard(request)
    const router = this.ctx.get('askSurfaces') as AskSurfacesLike | undefined
    if (router !== undefined && typeof router.register === 'function') {
      const dispose = router.register({
        name: 'feishu',
        claim: request => this.claimsAskSession(request),
        ask,
        settled: (request, by) => this.dismissAsk(request, by),
      })
      this.cleanupFns.push(dispose)
      return
    }
    // Standalone path: answerers compose on the Agent-scoped
    // 'user-questions/request' cordis waterfall. The event is not part of the
    // dsh-user-questions type surface this plugin imports, hence the
    // structural cast.
    const registerWaterfall = (this.ctx.on as unknown as (
      event: 'user-questions/request',
      listener: (request: AskRequestLike, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>,
    ) => () => boolean)
    this.cleanupFns.push(registerWaterfall('user-questions/request', (request, next) => (
      this.claimsAskSession(request) ? ask(request) : next()
    )))
  }

  /** Whether the bound session is the one asking (claim routing). The read
   * is structural on purpose — ask requests and approval requests share the
   * `agent.session.id` identity but nothing else. */
  private claimsAskSession(request: { readonly agent?: { readonly session?: { readonly id?: unknown } } }): boolean {
    const bound = this.binder.getSessionId()
    if (bound === undefined) return false
    const asking = request.agent?.session?.id
    return asking === undefined ? true : String(asking) === bound
  }

  /**
   * Send the interactive ask card and resolve when the operator submits
   * (or reject when the owning turn aborts). The card stays submittable
   * until answered or aborted — no TTL: expiring would fail the agent's
   * tool call just because the phone sat in a pocket.
   */
  private askViaCard(request: AskRequestLike): Promise<AskUserQuestionAnswer> {
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const chatId = this.store.get().lastChatId
      if (chatId === undefined) {
        reject(new UserQuestionError('ask_user_question has no operator chat on the phone', 'NO_CHAT'))
        return
      }
      const questionId = randomUUID()
      const entry: PendingAsk = { questions: [...request.questions], messageId: undefined, resolve, reject }
      this.pendingAsks.set(questionId, entry)
      this.askRequestIds.set(request, questionId)
      request.signal?.addEventListener('abort', () => {
        if (!this.pendingAsks.delete(questionId)) return
        this.patchAskCard(entry, buildAskDismissedCard(entry.questions, 'cancelled', ''))
        entry.reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
      }, { once: true })
      void this.chain(async () => {
        const messageId = await this.lark.sendCard(chatId, buildAskCard(entry.questions, questionId))
        if (!this.pendingAsks.has(questionId)) {
          // Aborted while the send was in flight — dismiss the stray card.
          if (messageId !== undefined) await this.lark.patchCard(messageId, buildAskDismissedCard(entry.questions, 'cancelled', ''))
          return
        }
        if (messageId === undefined) {
          this.pendingAsks.delete(questionId)
          entry.reject(new UserQuestionError('the ask card could not be delivered', 'CARD_SEND_FAILED'))
          return
        }
        entry.messageId = messageId
      })
    })
  }

  /** Router notification: another surface answered — settle and dismiss. */
  private dismissAsk(request: AskRequestLike, by: string): void {
    const questionId = this.askRequestIds.get(request)
    if (questionId === undefined) return
    const entry = this.pendingAsks.get(questionId)
    if (entry === undefined) return
    this.pendingAsks.delete(questionId)
    this.patchAskCard(entry, buildAskDismissedCard(entry.questions, 'elsewhere', by))
    entry.reject(new UserQuestionError(`answered on ${by} before the phone submitted`, 'ANSWERED_ELSEWHERE'))
  }

  /** Best-effort terminal patch of an ask card. */
  private patchAskCard(entry: PendingAsk, card: ReturnType<typeof buildAskCard>): void {
    if (entry.messageId === undefined) return
    void this.chain(() => this.lark.patchCard(entry.messageId!, card))
  }

  // ------------------------------------------------------- approval surface --

  /**
   * Register the phone as an approval answerer on the host's
   * 'approval/request' cordis waterfall — the same dispatch shape as the ask
   * waterfall (dsh-acp is the host's own reference answerer; the TUI plugin
   * registers none, so the phone is the sole interactive approver). Claiming
   * means the requesting session is the bound one and a delivery chat exists;
   * anything else delegates via next(), which the host treats as
   * 'unavailable' (fail-closed) when no other answerer takes it.
   */
  private registerApprovalSurface(): void {
    const registerWaterfall = (this.ctx.on as unknown as (
      event: 'approval/request',
      listener: (request: ApprovalRequestLike, next: () => Promise<ApprovalOutcomeLike>) => Promise<ApprovalOutcomeLike>,
    ) => () => boolean)
    this.cleanupFns.push(registerWaterfall('approval/request', async (request, next) => {
      const chatId = this.store.get().lastChatId
      if (chatId === undefined || !this.claimsAskSession(request)) return next()
      return this.approvalViaCard(chatId, request)
    }))
  }

  /**
   * Send the approval card and resolve with the operator's decision. The
   * request's own abort signal cancels the card mid-wait (turn aborted →
   * 'cancelled'); the selector's standard 10-minute TTL bounds an ignored
   * card, whose expiry fails closed as 'unavailable' — never an implicit
   * allow.
   */
  private async approvalViaCard(chatId: string, request: ApprovalRequestLike): Promise<ApprovalOutcomeLike> {
    const detail = request.reason === undefined || request.reason === ''
      ? ''
      : `：${clipLine(request.reason, 200)}`
    try {
      const outcome = await this.presentSelection(chatId, {
        title: '🔐 权限审批',
        description: `工具 \`${request.toolName}\`${detail}`,
        mode: 'buttons',
        // 拒绝 = 拒绝一次工具执行，误触成本高 — 取消（拒绝）按钮要求二次确认。
        confirmCancel: true,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        options: [
          { value: 'allow', label: '✅ 允许一次' },
          { value: 'deny', label: '❌ 拒绝' },
        ],
      })
      if (outcome.status === 'picked' && outcome.value === 'allow') return 'allowed-once'
      if (outcome.status === 'picked') return 'rejected'
      if (outcome.status === 'cancelled') return 'cancelled'
      return 'unavailable' // expired — fail closed, never an implicit allow
    } catch {
      // The card never went out (send rejected) — a hung turn would be worse
      // than a denied escalation; the host's own audit logs record it.
      return 'unavailable'
    }
  }

  /**
   * card.action.trigger entry (ask-card submits, selector FW submits).
   * Unknown actions and foreign cards are ignored; only allowlisted
   * operators may answer.
   */
  onCardAction(data: unknown): void {
    // Resume / model callbacks gate on the operator allowlist too — same
    // contract as the ask and selector branches below: non-operators (and
    // payloads without an operator) are silent no-ops, never errors.
    const operator = cardOperatorOf(data)
    // Pairing-card taps run BEFORE the operator gate: the tapper is by
    // definition not on the allowlist yet — claiming is the whole point.
    // The event's own open_id (the tapper) becomes the claimed admin.
    if (parsePairingAction(data) !== undefined) {
      if (operator === undefined || operator === '') return
      void this.chain(() => this.handlePairingClaim(operator, pairingActionContextOf(data)))
      return
    }
    const resume = parseResumeAction(data)
    if (resume !== undefined) {
      if (!this.mayOperate(operator)) return
      void this.chain(() => this.handleResumeAction(resume))
      return
    }
    const modelProvider = parseModelProviderAction(data)
    if (modelProvider !== undefined) {
      if (!this.mayOperate(operator)) return
      void this.chain(() => this.handleModelProviderPicked(modelProvider))
      return
    }
    const modelSubmit = parseModelSubmitAction(data)
    if (modelSubmit !== undefined) {
      if (!this.mayOperate(operator)) return
      void this.chain(() => this.handleModelSubmitted(modelSubmit))
      return
    }
    // /new config card: submit mints the session (handleNewOutcome), cancel
    // patches the grey card — both settle the awaiting present() promise.
    const newSession = parseNewSessionAction(data)
    if (newSession !== undefined) {
      if (!this.mayOperate(operator)) return
      this.newFlow.handleAction(newSession)
      return
    }
    // Round-card quick actions (⛔ 停止 / ▶️ 继续) — same operator gate as
    // every interactive surface; taps on stale cards degrade to the /stop
    // path's own "no running turn" reply.
    const roundOp = parseRoundCardAction(data)
    if (roundOp !== undefined) {
      if (!this.mayOperate(operator)) return
      void this.handleRoundAction(roundOp).catch(() => undefined)
      return
    }
    const parsed = parseAskAction(data)
    if (parsed === undefined) {
      // Selector FW submits ride LAST in the parser chain — the marker is
      // mutually exclusive with every parser above (ask included), so this
      // branch is only reachable for payloads none of them claimed.
      const selector = parseSelectorAction(data)
      if (selector === undefined) return
      this.selectors.handleAction(selector, operator)
      return
    }
    const entry = this.pendingAsks.get(parsed.questionId)
    if (entry === undefined) return
    if (!this.mayOperate(operator)) return
    const result = parseAskFormValue(entry.questions, parsed.formValue)
    if (result.kind === 'missing') {
      void this.reply(`还有未回答的问题：${result.missing.join('、')}`)
      return
    }
    this.pendingAsks.delete(parsed.questionId)
    void this.chain(async () => {
      if (entry.messageId !== undefined) {
        await this.lark.patchCard(entry.messageId, buildAskAnsweredCard(entry.questions, result.answers))
      }
      entry.resolve({ answers: result.answers })
    })
  }

  // ---------------------------------------------------- selector framework --

  /**
   * Present a generic selection card in a chat and resolve with the
   * operator's outcome (picked / cancelled / expired). Submits arrive via
   * onCardAction → SelectorManager, and resetRunView cancels flows pending
   * on a rebind.
   *
   * INVARIANT: never call from inside a card-chain task (a chain(() => …)
   * callback) — sendCard enqueues a NEW task on that same chain, so awaiting
   * the outcome from within the chain dead-locks. Callers must run at the
   * top level (command dispatch) or on their own async context.
   */
  presentSelection(chatId: string, spec: SelectorSpec): Promise<SelectorOutcome> {
    return this.selectors.present(chatId, spec)
  }

  // -------------------------------------------------- interactive commands --

  /**
   * Run one interactive command adapter (selector-FW consumer). The adapters
   * own their degraded replies; this wrapper only contains an unexpected
   * throw (e.g. a rejected selection card) so the dispatch loop survives.
   */
  private async interactiveCommand(run: (host: InteractiveHost) => Promise<void>): Promise<void> {
    try {
      await run(this.host)
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: interactive command failed: %o', error)
      await this.reply('交互选择失败，请稍后再试。')
    }
  }

  // --------------------------------------------------------------- /status --

  /** Effective bound id: live binding first, then the stored (not-yet-resumed) one. */
  private boundId(): string | undefined {
    return this.binder.getSessionId() ?? this.store.get().boundSessionId
  }

  private statusText(): string {
    const id = this.binder.getSessionId() ?? this.store.get().boundSessionId
    if (id === undefined) {
      return ['🧷 未绑定会话。发 /resume 查看可进入的会话。', '', helpText(false)].join('\n')
    }
    const agent = this.binder.getAgent()
    const state = this.runState
    const lines = [`🧷 绑定：${id.slice(0, 8)}（${agent === undefined ? '未激活' : agent.status === 'running' ? '运行中' : '空闲'}）`]
    if (state.running || state.turnEndedAt !== undefined) {
      const parts = [`rounds ${state.rounds}`]
      if (state.toolsDone > 0 || state.toolsFailed > 0) parts.push(`tools ✔${state.toolsDone} ✘${state.toolsFailed}`)
      if (state.retries > 0) parts.push(`↻${state.retries}`)
      const live = subagentRows(state).filter(row => row.outcome === undefined).length
      if (live > 0) parts.push(`🧵 ×${live}`)
      lines.push(`▶ 本轮：${parts.join(' · ')}`)
      if (state.lastAssistantLine !== undefined) lines.push(`最后输出：${clipLine(state.lastAssistantLine, 80)}`)
    }
    lines.push(`🖥 think 尾行：${this.store.get().displayThink ? 'on' : 'off'}（/display think on|off）`)
    return lines.join('\n')
  }
}
