// The reviewer: one bounded async drain per session, one model call per delta.
//
// Failure policy is no-stall — the main loop never waits on us. Transient
// errors get one retry, quota/permanent errors park the session, and the
// backlog is bounded so a dead model cannot grow memory without limit.

import { buildGateHint, CONTRACT_REMINDER, CONTENT_FREE_PHRASES, normalizeNote, PROBLEM_CATEGORIES } from './prompts.js'
import { isNote, type SupervisorNote } from './kinds.js'
import { EmissionGuard } from './guard.js'
import type { TranscriptDelta } from './transcript.js'

export interface ReviewerLlm {
  stream(options: any): AsyncIterable<any>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<any>
}

export interface ReviewerRoute {
  readonly provider: string
  readonly model: string
}

/**
 * How one review ended. `state.reviews` alone cannot tell a working reviewer
 * from a broken one — all of these look identical from outside — so every call
 * reports exactly one of these.
 */
export type ReviewOutcome =
  | 'silent' // model answered, nothing actionable (the normal case)
  | 'note' // model raised something and it was delivered
  | 'suppressed' // real note, but a repeat we already raised
  | 'gated_clear' // gate screened clear AND skipping is opted in; no model call was made
  | 'unparseable' // reply was not the JSON frame we asked for: the reviewer is effectively dead
  | 'error' // transport failure, retry exhausted
  | 'quota' // rate-limited; the session is parked
  | 'halted' // permanent model failure; the session is stopped

/** Detection gate in front of the model call (see jev-gate.ts). Optional: absent means every delta is reviewed by the model. */
export interface ReviewGate {
  screen(
    markdown: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'clear' }
    | { readonly kind: 'hits'; readonly hits: readonly { readonly id: string; readonly probability: number }[] }
    | { readonly kind: 'unavailable'; readonly reason: string }
  >
}

export interface ReviewerOptions {
  readonly llm: ReviewerLlm
  readonly systemPrompt: string
  readonly maxTokens: number
  readonly maxNoteChars: number
  readonly callTimeoutMs?: number
  readonly maxBacklog?: number
  /** When set, a delta the gate screens clear skips the model call entirely. */
  readonly gate?: ReviewGate
  /**
   * Opt-in cost mode. Off (the accuracy-first default) a clear gate verdict
   * still pays for the model call — the gate only contributes leads, never a
   * skip — so a false-clear can never drop a review on the floor. The skipped
   * case is also what makes false-clear measurable for free: with skipping off,
   * every clear delta still gets an LLM verdict to compare against.
   */
  readonly gateSkipClear?: boolean
  /**
   * Gate-vs-LLM agreement, for calibrating the gate threshold. `cleared`: the
   * gate said clear and (skipping off) the delta was reviewed anyway.
   * `false_clear`: that review then raised a note — a measured gate miss, not
   * a guess. Free while skipping stays off. `false_clear` carries the note's
   * self-reported categories so the ledger shows which categories the gate
   * systematically misses; an empty list means the route did not report them.
   */
  readonly onGateStat?: (stat: 'cleared' | 'false_clear' | 'flagged' | 'flag_confirmed', categories?: readonly string[]) => void
  /**
   * Blind-spot fix: after this many consecutive transient failures on the
   * session's own route, reviews switch to the fallback route instead of
   * erroring into silence for the rest of the session. Live-read so the
   * settings page can arm or change it mid-session.
   */
  readonly getFallback?: () => { readonly provider: string; readonly model: string; readonly afterErrors: number } | undefined
  /**
   * Optional review-model override, highest route precedence. Default (empty
   * provider/model) is undefined here and the reviewer follows the session's
   * own route. Live-read so the settings page can pin or unpin mid-session.
   */
  readonly getReviewRoute?: () => { readonly provider: string; readonly model: string } | undefined
  /**
   * Images attached to the session since this reviewer last looked, drained on
   * read. The session/event feed carries no image blocks, so the host captures
   * them from `agent/request` and hands them over here — without this the
   * reviewer reads a screenshot-bearing turn as the user saying nothing.
   */
  readonly getImages?: () => readonly { readonly mediaType: string; readonly data: string }[]
  /** Fired once per switch to the fallback route, for the ledger and the panel. */
  readonly onFallback?: (route: ReviewerRoute) => void
  /** Fired once per blind episode: the review route failed `afterErrors` times
   * in a row and no fallback route is configured, so this session is reviewing
   * nothing. The host turns it into a panel-only alert — blindness must be
   * visible, not just a counter in the ledger.
   */
  onBlind?: (info: { errors: number; route?: ReviewerRoute }) => void
  /** A note survived the emission guard. `categories` are the note's
   *  self-reported problem-category ids (empty when the route omitted them). */
  readonly onNote: (note: SupervisorNote, categories?: readonly string[]) => void
  readonly onStateChange?: (state: ReviewerState) => void
  /** `reply` is set for `unparseable` so callers can surface what came back;
   *  `reason` says which parse exit produced it; `failure` (for error-family
   *  outcomes) carries the kind + fingerprint the ledger groups by. */
  readonly onOutcome?: (outcome: ReviewOutcome, reply?: string, reason?: ParseFailReason, failure?: FailureInfo) => void
  readonly logger?: { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

export type ReviewerState = 'idle' | 'working' | 'no_route' | 'quota_exhausted' | 'halted' | 'disposed'

/** Why a reply failed the JSON contract — the ledger splits `unparseable` by
 *  this so the next fix targets the exit that actually leaks. */
export type ParseFailReason = 'no_frame' | 'json_error' | 'empty_note' | 'bad_shape'

/** The seven review categories, for validating self-reported ids. */
const KNOWN_CATEGORY_IDS: ReadonlySet<string> = new Set(PROBLEM_CATEGORIES.map((c) => c.id))

type ParseResult =
  | { readonly kind: 'unparseable'; readonly reason: ParseFailReason }
  | { readonly kind: 'silent' }
  | { readonly kind: 'note'; readonly note: SupervisorNote; readonly categories: readonly string[] }

/** What one model call produced, plus the raw text when it could not be parsed. */
type CallResult = { readonly outcome: ReviewOutcome; readonly reply?: string; readonly reason?: ParseFailReason; readonly categories?: readonly string[] }

const DEFAULT_CALL_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BACKLOG = 16
/** A stuck jev must not park the drain: past this the gate is skipped and the model reviews anyway. */
const GATE_TIMEOUT_MS = 20_000
/** Second-chance instruction appended when the first reply broke the JSON contract. */
const UNPARSEABLE_NUDGE =
  'Your previous reply was not the single JSON object this contract requires. Reply again with exactly one JSON object and nothing else: {"note": "<one short paragraph in Simplified Chinese>", "severity": "concern" | "blocker"}, or {"note": "Nothing to add"} when there is nothing worth saying.'

interface Frame {
  note?: unknown
  severity?: unknown
  /** Self-reported problem-category ids (contract addition, optional). */
  categories?: unknown
}

/** Locate the first balanced `{…}`, tolerating prose and markdown fences. */
function extractJsonFrame(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Consecutive failed reviews before a fallback-less session is called blind. */
const BLIND_AFTER_ERRORS = 3

/** Failure kind plus a coarse fingerprint of *what* failed, for the ledger:
 *  `error` alone told us 523 reviews died but not of what. */
export interface FailureInfo {
  readonly kind: 'transient' | 'quota' | 'permanent'
  /** Stable bucket: `timeout`, `http-429`, `invalid-request`, `network`, … */
  readonly fingerprint: string
}

function classifyFailure(error: unknown): 'transient' | 'quota' | 'permanent' {
  const text = `${(error as { message?: string })?.message ?? ''} ${(error as { code?: string })?.code ?? ''}`.toLowerCase()
  if (/quota|rate.?limit|429|insufficient/.test(text)) return 'quota'
  if (/invalid_request|model.?not.?found|unsupported|400|404|does not exist/.test(text)) return 'permanent'
  return 'transient'
}

/** Coarse, stable fingerprint of a failure, so the ledger can group them. */
function fingerprintFailure(error: unknown): string {
  const message = String((error as { message?: string })?.message ?? error ?? '')
  const text = message.toLowerCase()
  const code = String((error as { code?: string })?.code ?? '').toLowerCase()
  if (/timeout|etimedout|timed out/.test(text)) return 'timeout'
  if (/econnrefused|econnreset|enotfound|network|socket hang up|fetch failed/.test(text)) return 'network'
  if (/429|rate.?limit|quota|insufficient/.test(text) || /429/.test(code)) return 'rate-limit'
  if (/401|403|unauthor|forbidden/.test(text)) return 'auth'
  if (/invalid_request|bad request/.test(text) || /400/.test(code)) return 'invalid-request'
  if (/model.?not.?found|does not exist|404/.test(text) || /404/.test(code)) return 'model-not-found'
  if (/max.?tokens|length/.test(text)) return 'max-tokens'
  if (/abort/.test(text)) return 'aborted'
  if (/5\d\d|internal server|bad gateway|unavailable/.test(text)) return 'server-5xx'
  return 'other'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export class Reviewer {
  private readonly guard = new EmissionGuard()
  private readonly backlog: TranscriptDelta[] = []
  private readonly controller = new AbortController()
  private readonly callTimeoutMs: number
  private readonly maxBacklog: number
  private maxTokens: number
  private maxNoteChars: number
  private draining = false
  private _state: ReviewerState = 'idle'
  private route: ReviewerRoute | undefined
  private offEffort: boolean | undefined
  private offEffortKey = ''
  /** Consecutive transient failures on the session's own route. */
  private consecutiveErrors = 0
  private blindReported = false
  /** Set while reviews ride the fallback route; cleared when the main route updates. */
  private usingFallback = false

  constructor(private readonly options: ReviewerOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.maxBacklog = options.maxBacklog ?? DEFAULT_MAX_BACKLOG
    this.maxTokens = options.maxTokens
    this.maxNoteChars = options.maxNoteChars
  }

  get state(): ReviewerState {
    return this._state
  }

  private setState(next: ReviewerState): void {
    if (this._state === next) return
    this._state = next
    this.options.onStateChange?.(next)
  }

  setRoute(route: ReviewerRoute | undefined): void {
    this.route = route
    // A fresh main-route capture means the session moved on: trust it again and
    // drop any fallback switch an earlier outage caused.
    if (route) {
      this.usingFallback = false
      this.consecutiveErrors = 0
      this.blindReported = false
    }
    if (route && this._state === 'no_route') this.setState('idle')
    if (!route && this._state === 'idle') this.setState('no_route')
  }

  /** Volatile config changed: budgets apply to the next call without losing the backlog. */
  setBudgets(maxTokens: number, maxNoteChars: number): void {
    this.maxTokens = maxTokens
    this.maxNoteChars = maxNoteChars
  }

  enqueue(delta: TranscriptDelta): void {
    if (this._state === 'disposed' || this._state === 'halted' || this._state === 'quota_exhausted') return
    if (!this.route) {
      // No captured route yet: a configured fallback still lets the session
      // be reviewed instead of going blind (route capture can fail too).
      const fb = this.options.getFallback?.()
      if (fb && fb.provider && fb.model) {
        if (!this.usingFallback) {
          this.usingFallback = true
          this.options.onFallback?.({ provider: fb.provider, model: fb.model })
        }
      } else {
        this.setState('no_route')
        return
      }
    }
    // Coalesce rather than grow: only the newest work matters.
    this.backlog.push(delta)
    while (this.backlog.length > this.maxBacklog) this.backlog.shift()
    void this.drain()
  }

  resetGuard(): void {
    this.guard.reset()
    this.backlog.length = 0
  }

  dispose(): void {
    this.setState('disposed')
    this.backlog.length = 0
    this.controller.abort()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.backlog.length > 0) {
        if (this._state === 'disposed') return
        const delta = this.backlog.pop()!
        this.backlog.length = 0
        await this.processDelta(delta)
      }
    } finally {
      this.draining = false
    }
  }

  private async processDelta(delta: TranscriptDelta): Promise<void> {
    this.guard.beginReview()
    this.setState('working')
    try {
      // Cheap detector first. Accuracy comes before cost: a `clear` verdict
      // skips the model call only in the opt-in cost mode (`gateSkipClear`);
      // otherwise every delta is reviewed and the gate's hits ride along as
      // leads in the prompt. `unavailable` (no jev, or it failed) always falls
      // through to the plain LLM review — the gate can only add information,
      // never block a review.
      let gateHits: readonly { id: string; probability: number }[] | undefined
      let gateCleared = false
      let gateFlagged = false
      if (this.options.gate) {
        const gateSignal = new AbortController()
        const gateTimer = setTimeout(() => gateSignal.abort(new Error('supervisor gate timed out')), GATE_TIMEOUT_MS)
        const onParentAbort = () => gateSignal.abort(this.controller.signal.reason)
        this.controller.signal.addEventListener('abort', onParentAbort, { once: true })
        let verdict: Awaited<ReturnType<ReviewGate['screen']>> | undefined
        try {
          verdict = await this.options.gate.screen(delta.markdown, gateSignal.signal)
        } catch (error) {
          // A gate that throws must cost nothing but a warning: review anyway.
          this.options.logger?.warn?.('review gate failed; reviewing without it', { error: String(error) })
        } finally {
          clearTimeout(gateTimer)
          this.controller.signal.removeEventListener('abort', onParentAbort)
        }
        if (verdict?.kind === 'clear') {
          if (this.options.gateSkipClear) {
            this.report('gated_clear')
            return
          }
          gateCleared = true
          this.options.onGateStat?.('cleared')
        }
        if (verdict?.kind === 'hits') {
          gateHits = verdict.hits
          gateFlagged = true
          this.options.onGateStat?.('flagged')
        }
      }
      // One retry for transport hiccups, then drop: a missed review is cheap.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this._state === 'disposed') return
        if (attempt > 0) await sleep(500 * attempt, this.controller.signal)
        try {
          const result = await this.callModel(delta, gateHits)
          this.consecutiveErrors = 0
          // Route is healthy again: a later outage deserves a fresh warning.
          this.blindReported = false
          if (gateCleared && result.outcome === 'note') {
            this.options.onGateStat?.('false_clear', result.categories ?? [])
          }
          // Co-occurrence, not attribution: a note on a flagged delta confirms
          // the lead *may* have paid off; a silent one vetoes it. Either way the
          // hit side of the gate becomes measurable, which it never was.
          if (gateFlagged && result.outcome === 'note') this.options.onGateStat?.('flag_confirmed')
          this.report(result.outcome, result.reply, result.reason)
          return
        } catch (error) {
          const kind = classifyFailure(error)
          const failure: FailureInfo = { kind, fingerprint: fingerprintFailure(error) }
          if (kind === 'quota') {
            this.options.logger?.warn?.('reviewer paused: quota exhausted', { error: String(error) })
            this.setState('quota_exhausted')
            this.report('quota', undefined, undefined, failure)
            return
          }
          if (kind === 'permanent') {
            this.options.logger?.warn?.('reviewer halted: permanent model failure', { error: String(error) })
            this.setState('halted')
            this.report('halted', undefined, undefined, failure)
            return
          }
          // A throttled or slow route needs more than 500ms: back off before
          // the single retry so the window can recover. Measured: the error
          // ledger's largest bucket is the rate-limit family, and 500ms is
          // far below any real window.
          if (attempt === 0 && (failure.fingerprint === 'rate-limit' || failure.fingerprint === 'timeout')) {
            this.options.logger?.warn?.('review attempt throttled; backing off before the retry', { fingerprint: failure.fingerprint })
            await sleep(4000, this.controller.signal)
          }
          if (attempt === 1) {
            this.consecutiveErrors++
            const fb = this.options.getFallback?.()
            if (!this.usingFallback && fb && fb.provider && fb.model && this.consecutiveErrors >= fb.afterErrors) {
              this.usingFallback = true
              this.options.logger?.warn?.('review route failing; switching to the fallback route', {
                consecutiveErrors: this.consecutiveErrors,
                fallback: `${fb.provider}/${fb.model}`,
              })
              this.options.onFallback?.({ provider: fb.provider, model: fb.model })
            }
            // No fallback configured and the route keeps dying: say so out
            // loud, once per episode. A blind session must not be silent.
            if (!this.blindReported && !this.usingFallback && !(fb && fb.provider && fb.model) && this.consecutiveErrors >= BLIND_AFTER_ERRORS) {
              this.blindReported = true
              this.options.onBlind?.({ errors: this.consecutiveErrors, route: this.route })
            }
            this.options.logger?.warn?.('review dropped after retry', { error: String(error) })
            this.report('error', undefined, undefined, failure)
          }
        }
      }
    } finally {
      if (this._state === 'working') this.setState('idle')
    }
  }

  private report(outcome: ReviewOutcome, reply?: string, reason?: ParseFailReason, failure?: FailureInfo): void {
    this.options.onOutcome?.(outcome, reply, reason, failure)
  }

  /**
   * Route precedence, highest first: the configured review-model override →
   * the fallback route (after repeated failures) → the session's own route.
   * The override outranks the fallback because it is an explicit "always
   * review with this model" — a dead override still beats a live session route
   * only in the sense that the override is what the user asked for; failures
   * on it are reported, not silently retried on the session route.
   */
  private effectiveRoute(): ReviewerRoute | undefined {
    const override = this.options.getReviewRoute?.()
    if (override && override.provider && override.model) return { provider: override.provider, model: override.model }
    if (!this.usingFallback) return this.route
    const fb = this.options.getFallback?.()
    if (fb && fb.provider && fb.model) return { provider: fb.provider, model: fb.model }
    this.usingFallback = false // the fallback was withdrawn mid-flight
    return this.route
  }

  /** `reasoningEffort: 'off'` only when the adapter actually supports it. */
  private async resolveOffEffort(route: ReviewerRoute): Promise<boolean> {
    const key = route.provider + '/' + route.model
    if (this.offEffort !== undefined && this.offEffortKey === key) return this.offEffort
    const resolve = this.options.llm.resolveModelInfo?.bind(this.options.llm)
    if (!resolve) return false
    try {
      const info = await resolve(route.provider, route.model, this.controller.signal)
      const efforts = info?.reasoning?.efforts
      const supported = Array.isArray(efforts) && efforts.some((e: any) => e?.id === 'off')
      this.offEffort = supported
      this.offEffortKey = key
      return supported
    } catch {
      return false // never cache an inconclusive probe
    }
  }

  private async callModel(
    delta: TranscriptDelta,
    gateHits?: readonly { id: string; probability: number }[],
  ): Promise<CallResult> {
    const route = this.effectiveRoute()
    if (!route) {
      this.setState('no_route')
      return { outcome: 'error' }
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('supervisor review timed out')), this.callTimeoutMs)
    const onParentAbort = () => timeout.abort(this.controller.signal.reason)
    this.controller.signal.addEventListener('abort', onParentAbort, { once: true })

    try {
      const off = await this.resolveOffEffort(route)
      // Carry the reviewer contract inside the user turn, not the top-level
      // `system` slot. Measured on the live routes: qwen/* ignored `system`
      // entirely and answered as the assistant (hallucinating file contents),
      // and deepseek reasoning models spent the whole budget on hidden
      // reasoning before any text. Inlining the prompt ahead of the transcript
      // was the only channel that held on every route we tested, so the review
      // call sends one user message: contract + `### Session update` + delta.
      let promptText = `${this.options.systemPrompt}\n### Session update\n\n${delta.markdown}`
      if (gateHits && gateHits.length > 0) promptText += `\n\n${buildGateHint(gateHits)}`
      // The contract again at the very end: weak models forget the copy that
      // sits ahead of a 60-message delta (no_frame was 44/44 of parse fails).
      promptText += `\n\n${CONTRACT_REMINDER}`
      // Request-side images (user screenshots), drained so each review looks at
      // them once. Placed after the text: the same order the main agent reads.
      const images = this.options.getImages?.() ?? []
      const content: unknown[] = [{ type: 'text', text: promptText }]
      for (const image of images) {
        content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
      }
      if (images.length > 0) {
        promptText += `\n\n（附 ${images.length} 张用户截图，见消息末尾的 image 块）`
        ;(content[0] as { text: string }).text = promptText
      }
      const options: Record<string, unknown> = {
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content }],
        maxTokens: this.maxTokens,
        signal: timeout.signal,
      }
      if (off) options.reasoningEffort = 'off'

      // A contract-breaking reply gets exactly one second chance with an
      // explicit nudge: malformed frames were the biggest quality leak (half
      // of all reviews, before the retry existed).
      for (let parseAttempt = 0; ; parseAttempt++) {
        let text = ''
        let finishKind: string | undefined
        let finished = false
        for await (const chunk of this.options.llm.stream(options as never)) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (chunk?.type === 'finish') {
            finished = true
            finishKind = chunk.reason?.kind
            if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.message ?? 'model stream error')
          }
        }
        if (!finished) throw new Error('review stream ended without a finish reason')

        const parsed = this.parse(text)
        if (parsed.kind === 'silent') {
          this.options.logger?.debug?.('review produced no actionable note')
          return { outcome: 'silent' }
        }
        if (parsed.kind === 'note') {
          if (!this.guard.accept(parsed.note)) {
            this.options.logger?.debug?.('note suppressed by emission guard')
            return { outcome: 'suppressed' }
          }
          this.options.onNote(parsed.note, parsed.categories)
          return { outcome: 'note', categories: parsed.categories }
        }
        const reply = text.slice(0, 200) || `<empty reply, finish=${finishKind}>`
        if (parseAttempt === 0) {
          this.options.logger?.warn?.('review reply broke the JSON contract; asking once more', { reply, reason: parsed.reason })
          promptText += `\n\n${UNPARSEABLE_NUDGE}`
          ;(options.messages as any[])[0].content[0].text = promptText
          continue
        }
        // Warn, not debug: an unparseable reply means every review is wasted.
        this.options.logger?.warn?.('review reply was not the JSON frame asked for', { reply, reason: parsed.reason })
        return { outcome: 'unparseable', reply, reason: parsed.reason }
      }
    } finally {
      clearTimeout(timer)
      this.controller.signal.removeEventListener('abort', onParentAbort)
    }
  }

  /** Distinguish "said nothing" from "did not follow the contract" — both parse to no note. */
  private parse(text: string): ParseResult {
    const frame = extractJsonFrame(text)
    if (!frame) return { kind: 'unparseable', reason: 'no_frame' }
    let parsed: Frame
    try {
      parsed = JSON.parse(frame) as Frame
    } catch {
      return { kind: 'unparseable', reason: 'json_error' } // parse failures are never retried
    }
    const severity = parsed.severity === 'blocker' ? 'blocker' : 'concern'
    const note = typeof parsed.note === 'string' ? parsed.note.trim() : ''
    if (!note) return { kind: 'unparseable', reason: 'empty_note' }
    const clipped = note.length > this.maxNoteChars ? note.slice(0, this.maxNoteChars - 1) + '…' : note
    const candidate: SupervisorNote = { note: clipped, severity }
    if (!isNote(candidate)) return { kind: 'unparseable', reason: 'bad_shape' }
    if (CONTENT_FREE_PHRASES.has(normalizeNote(clipped))) return { kind: 'silent' }
    // Self-reported categories, filtered to the seven known ids (anything else
    // is dropped, so a hallucinated id cannot pollute the calibration ledger).
    // Absent on routes that predate the field — the ledger buckets those as
    // `unknown` rather than losing the sample.
    const categories = Array.isArray(parsed.categories)
      ? parsed.categories.filter((c: unknown): c is string => typeof c === 'string' && KNOWN_CATEGORY_IDS.has(c))
      : []
    return { kind: 'note', note: candidate, categories }
  }
}
