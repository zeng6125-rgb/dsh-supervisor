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
// `intercept` attaches on the very next step instead. Advisory only — we never
// decide for the agent.

import { SUPERVISOR_SOURCE_KIND, type SupervisorNote } from './kinds.js'

export interface DeliveryOptions {
  intercept: boolean
  createUserMessage: (input: any) => any
  boundContextSummary: (summary: string) => string
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
  private intercept: boolean

  constructor(private readonly options: DeliveryOptions) {
    this.intercept = options.intercept
  }

  setIntercept(value: boolean): void {
    this.intercept = value
  }

  /** Forget queued notes (compaction rewrote history, or the session ended). */
  clear(sessionId: string): void {
    this.pending.delete(sessionId)
    this.raisedTurn.delete(sessionId)
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
   * With `intercept` off (default) a note attaches on the first step of a turn
   * LATER than the one it reviewed — the user's next message — so in-flight
   * work is never cut off. With `intercept` on it attaches on the next step.
   * `onAttached` lets the caller re-channel the parked alerts to `delivered`.
   */
  attachToStep(sessionId: string, decision: any, turn: number, onAttached?: (notes: SupervisorNote[]) => void): any {
    this.lastTurn.set(sessionId, turn)
    if (!decision || decision.kind !== 'enter') return decision
    const queue = this.pending.get(sessionId)
    if (!queue || queue.length === 0) return decision
    if (!this.intercept) {
      const anchor = this.raisedTurn.get(sessionId) ?? 0
      if (turn <= anchor) return decision // wait for a later turn
    }
    this.pending.delete(sessionId)
    this.raisedTurn.delete(sessionId)
    onAttached?.(queue)
    const extra = queue.map((note) => this.buildMessage(note))
    return { ...decision, messages: [...(decision.messages ?? []), ...extra] }
  }
}
