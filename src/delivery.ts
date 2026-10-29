// Advice delivery.
//
// A surviving note waits, then rides a step the agent is ALREADY entering: it
// is appended to `agent/pre-step`'s messages, spreading the decision so
// `startsRequestSeries` and the provider's prefix cache survive. It is never
// pushed into the agent's inbox (`inject`/`steer`): an inbox notice arrives as
// a user turn of its own, which stopped the agent mid-work and made it answer
// only the supervision — the discontinuity the user reported. And it never
// rejects a step: the old reject/re-queue discarded `startsRequestSeries` and
// restarted the request, which is what broke the cache.
//
// Cadence: by default a note attaches on the first step of a LATER turn (the
// user's next message), so work already in flight is never interrupted. Setting
// `intercept` attaches on the very next step instead. On top of that, a global
// attach cooldown (`attachIntervalSec`, default 180s) rate-limits how often the
// agent is spoken to at all: while cooling, notes stay queued; when the
// cooldown matures only the NEWEST note attaches (the point of supervision is
// the freshest read), older queued ones park on the panel — still visible and
// acked, never silently lost. Advisory only — we never decide for the agent.

import { SUPERVISOR_SOURCE_KIND, type SupervisorNote } from './kinds.js'

export interface DeliveryOptions {
  intercept: boolean
  /** Milliseconds between two attaches for one session (0 disables the rate limit). */
  attachCooldownMs: () => number
  createUserMessage: (input: any) => any
  boundContextSummary: (summary: string) => string
  /** Injectable clock for tests. */
  now?: () => number
  logger?: { debug?(...args: unknown[]): void; warn?(...args: unknown[]): void }
}

/** Text the agent sees; the prefix is its only cue that this is advice. */
export function renderNoteText(note: SupervisorNote): string {
  return `[supervisor:${note.severity}] ${note.note}`
}

export class SupervisorDelivery {
  /** Notes waiting to ride a step, per session. */
  private readonly pending = new Map<string, SupervisorNote[]>()
  /** Turn the pending notes belong to, so the default path waits for a later one. */
  private readonly raisedTurn = new Map<string, number>()
  /** Latest turn observed entering a step, per session. */
  private readonly lastTurn = new Map<string, number>()
  /** When this session was last spoken to, for the attach cooldown. */
  private readonly lastAttach = new Map<string, number>()
  private readonly now: () => number
  private intercept: boolean

  constructor(private readonly options: DeliveryOptions) {
    this.intercept = options.intercept
    this.now = options.now ?? Date.now
  }

  setIntercept(value: boolean): void {
    this.intercept = value
  }

  /** Forget queued notes (compaction rewrote history, or the session ended). */
  clear(sessionId: string): void {
    this.pending.delete(sessionId)
    this.raisedTurn.delete(sessionId)
    this.lastAttach.delete(sessionId)
  }

  hasPending(sessionId: string): boolean {
    return (this.pending.get(sessionId)?.length ?? 0) > 0
  }

  private buildMessage(note: SupervisorNote): any {
    const text = renderNoteText(note)
    return this.options.createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: SUPERVISOR_SOURCE_KIND,
        form: 'notice',
        summary: this.options.boundContextSummary(text.slice('[supervisor:'.length)),
      },
    })
  }

  /** A note survived the emission guard: it waits for a step to ride. */
  raise(sessionId: string, note: SupervisorNote): 'pending' {
    const queue = this.pending.get(sessionId) ?? []
    queue.push(note)
    this.pending.set(sessionId, queue)
    if (!this.raisedTurn.has(sessionId)) {
      // Anchor to the turn these notes were reviewed in; the default path then
      // waits for a strictly later turn, so it never interrupts current work.
      this.raisedTurn.set(sessionId, this.lastTurn.get(sessionId) ?? 0)
    }
    this.options.logger?.debug?.('note queued for a later step', { sessionId, severity: note.severity })
    return 'pending'
  }

  /**
   * `agent/pre-step` hook body. Records the turn entering a step and, when a
   * note is due, returns a new decision with the note appended to `messages`.
   *
   * Spreading the decision preserves `startsRequestSeries`, so the request
   * series and the provider's prefix cache survive; only the tail grows.
   *
   * Two gates decide when a queued note is spoken to:
   *   1. turn gate — with `intercept` off (default), a note attaches on the
   *      first step of a turn LATER than the one it reviewed (the user's next
   *      message); with it on, the very next step;
   *   2. attach cooldown (`attachCooldownMs`, 0 disables it) — at most one
   *      attach per window per session, so an active conversation does not
   *      hear from the supervisor every turn.
   *
   * While the cooldown is armed and several notes have queued up, only the
   * NEWEST attaches (supervision is about the freshest read) and the older
   * ones park on the panel via `onParked` — visible and ackable, never
   * silently lost. With the cooldown disabled, every queued note rides the
   * step in order, the way it did before rate limiting existed.
   *
   * `onAttached` lets the caller re-channel the attached alerts to `delivered`.
   */
  attachToStep(
    sessionId: string,
    decision: any,
    turn: number,
    onAttached?: (notes: SupervisorNote[]) => void,
    onParked?: (notes: SupervisorNote[]) => void,
  ): any {
    this.lastTurn.set(sessionId, turn)
    if (!decision || decision.kind !== 'enter') return decision
    const queue = this.pending.get(sessionId)
    if (!queue || queue.length === 0) return decision
    if (!this.intercept) {
      const anchor = this.raisedTurn.get(sessionId) ?? 0
      if (turn <= anchor) return decision // wait for a later turn
    }
    const cooldown = this.options.attachCooldownMs()
    const rateLimited = cooldown > 0
    if (rateLimited) {
      const last = this.lastAttach.get(sessionId)
      if (last !== undefined && this.now() - last < cooldown) return decision // stay queued
      this.lastAttach.set(sessionId, this.now())
    }
    this.pending.delete(sessionId)
    this.raisedTurn.delete(sessionId)
    const attached = rateLimited ? [queue[queue.length - 1]] : queue
    const parked = rateLimited ? queue.slice(0, -1) : []
    if (parked.length > 0) onParked?.(parked)
    onAttached?.(attached)
    const extra = attached.map((note) => this.buildMessage(note))
    return { ...decision, messages: [...(decision.messages ?? []), ...extra] }
  }
}
