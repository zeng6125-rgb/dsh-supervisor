// Bounded, JSON-serialisable state shared by the banner API and the status tool.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ParseFailReason, ReviewerState, ReviewOutcome } from './review.js'
import type { SupervisorNote } from './kinds.js'

/** `panel` = plugin-health warning shown to the user only; never injected.
 *  `pending` = a note waiting to ride a step the agent enters on its own. */
export type DeliveryChannel = 'pending' | 'delivered' | 'dropped' | 'panel'

export interface SupervisorAlert {
  readonly id: string
  readonly sessionId: string
  readonly severity: SupervisorNote['severity']
  readonly note: string
  readonly at: number
  readonly channel: DeliveryChannel
  readonly acked: boolean
  /** The note's self-reported category; absent when the route omitted it. */
  readonly category?: string
}

export interface SupervisorSessionState {
  readonly sessionId: string
  readonly reviewer: ReviewerState
  readonly route?: { readonly provider: string; readonly model: string }
  /** Set while the reviewer rides the fallback route after repeated failures. */
  readonly fallback?: { readonly provider: string; readonly model: string }
  readonly steps: number
  readonly reviews: number
  /** How each of those `reviews` ended. Sums to `reviews`. */
  readonly outcomes: Readonly<Partial<Record<ReviewOutcome, number>>>
  /**
   * Reply of the most recent `unparseable` review, truncated. `ctx.logger` does
   * not reach disk in this build, so without this a reviewer that never follows
   * the contract is indistinguishable from one that simply had nothing to say —
   * which is how 25 wasted reviews went unnoticed.
   */
  readonly badReply?: string
  /** Which parse exit each failed reply hit, per attempt (a retried review
   *  counts twice). Tells `no_frame` (model never emitted JSON) apart from
   *  `empty_note` (frame fine, nothing inside) — different fixes. */
  readonly parseFails?: Readonly<Record<string, number>>
  /** How each failed review died, by fingerprint (`timeout`, `rate-limit`, …).
   *  `error` alone could not tell a dead route from a throttled one. */
  readonly errorKinds?: Readonly<Record<string, number>>
  /** A queued note is waiting to ride the next step the agent enters. */
  readonly pending: boolean
  /**
   * Notes by self-reported category, `unreported` included. Measures whether
   * the contract's `category` field is actually produced in real traffic —
   * without it, a wake that never fires is indistinguishable from a quiet one.
   * In-memory only: pre-existing history has no category to backfill.
   */
  readonly noteCategories?: Readonly<Record<string, number>>
}

/** Outcomes that mean the reviewer is not doing its job; surfaced as a warning. */
export const UNHEALTHY_OUTCOMES: readonly ReviewOutcome[] = ['unparseable', 'error', 'quota', 'halted']

const MAX_ALERTS = 50
const MAX_BAD_REPLY = 200
const FLUSH_DEBOUNCE_MS = 1500

interface PersistedSession {
  steps: number
  reviews: number
  outcomes: Record<string, number>
  route?: { provider: string; model: string }
  parseFails?: Record<string, number>
  errorKinds?: Record<string, number>
}

export class SupervisorState {
  private readonly alerts: SupervisorAlert[] = []
  private readonly sessions = new Map<string, SupervisorSessionState>()
  /** Counters restored from disk; a session starts from these, not from zero. */
  private readonly restored = new Map<string, SupervisorSessionState>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private seq = 0

  /**
   * `persistPath` makes the counters survive a host restart (they are the only
   * evidence of how the reviewer has been behaving). Alerts stay in memory:
   * they are ephemeral UI, and a stale banner after a restart would mislead.
   */
  constructor(
    private readonly persistPath?: string,
    private readonly logger?: { warn?(message: string, context?: unknown): void },
  ) {
    if (!persistPath) return
    try {
      const file = JSON.parse(readFileSync(persistPath, 'utf8')) as { sessions?: Record<string, PersistedSession> }
      for (const [sessionId, saved] of Object.entries(file.sessions ?? {})) {
        if (!saved || typeof saved !== 'object') continue
        this.restored.set(sessionId, {
          sessionId,
          reviewer: 'idle',
          steps: saved.steps ?? 0,
          reviews: saved.reviews ?? 0,
          outcomes: saved.outcomes ?? {},
          ...(saved.route ? { route: { ...saved.route } } : {}),
          ...(saved.parseFails ? { parseFails: { ...saved.parseFails } } : {}),
          ...(saved.errorKinds ? { errorKinds: { ...saved.errorKinds } } : {}),
          pending: false,
        })
      }
    } catch {
      // Missing or corrupt file: start from zero rather than crash the plugin.
    }
  }

  /**
   * One note's self-reported category. `undefined` means the route omitted the
   * field, which is counted rather than hidden: that rate decides whether the
   * wake guard can ever fire.
   */
  recordNoteCategory(sessionId: string, category: string | undefined): void {
    const current = this.sessions.get(sessionId)
    if (!current) return
    const key = category ?? 'unreported'
    const next = { ...(current.noteCategories ?? {}) }
    next[key] = (next[key] ?? 0) + 1
    this.setSession(sessionId, { noteCategories: next })
    this.scheduleFlush()
  }

  recordAlert(
    sessionId: string,
    note: SupervisorNote,
    channel: DeliveryChannel,
    category?: string,
  ): SupervisorAlert {
    const alert: SupervisorAlert = {
      id: `s${++this.seq}`,
      sessionId,
      severity: note.severity,
      note: note.note,
      at: Date.now(),
      channel,
      acked: false,
      ...(category ? { category } : {}),
    }
    this.alerts.unshift(alert)
    while (this.alerts.length > MAX_ALERTS) this.alerts.pop()
    return alert
  }

  ack(id?: string): number {
    let count = 0
    for (const alert of this.alerts) {
      if (!alert.acked && (id === undefined || alert.id === id)) {
        ;(alert as { acked: boolean }).acked = true
        count++
      }
    }
    return count
  }

  /**
   * Re-channel the most recent matching `pending` alert instead of appending a
   * second one: a note that was waiting to ride a step and whose turn then
   * completed is one piece of advice, and the ledger must not bill it twice.
   */
  updateAlertChannel(sessionId: string, note: SupervisorNote, channel: DeliveryChannel): void {
    for (const alert of this.alerts) {
      if (alert.sessionId === sessionId && alert.channel === 'pending' && alert.note === note.note) {
        ;(alert as { channel: DeliveryChannel }).channel = channel
        return
      }
    }
  }

  setSession(sessionId: string, patch: Partial<Omit<SupervisorSessionState, 'sessionId'>>): void {
    this.sessions.set(sessionId, { ...this.base(sessionId), ...patch })
  }

  /** Count committed steps, for the banner and status line. */
  bump(sessionId: string, key: 'steps', by = 1): void {
    const current = this.base(sessionId)
    this.sessions.set(sessionId, { ...current, [key]: current[key] + by })
    this.scheduleFlush()
  }

  /**
   * Record one finished review and how it ended. `reviews` counts *finished*
   * calls, and `outcomes` sums to it — so `reviews: 5, unparseable: 5` reads as
   * "the reviewer ran five times and understood nothing", which `reviews: 5`
   * alone could never express.
   */
  recordReview(
    sessionId: string,
    outcome: ReviewOutcome,
    reply?: string,
    reason?: ParseFailReason,
    failure?: { readonly fingerprint: string },
  ): void {
    const current = this.base(sessionId)
    this.sessions.set(sessionId, {
      ...current,
      reviews: current.reviews + 1,
      outcomes: { ...current.outcomes, [outcome]: (current.outcomes[outcome] ?? 0) + 1 },
      ...(outcome === 'unparseable' && reply ? { badReply: reply.slice(0, MAX_BAD_REPLY) } : {}),
      ...(outcome === 'unparseable' && reason
        ? { parseFails: { ...current.parseFails, [reason]: (current.parseFails?.[reason] ?? 0) + 1 } }
        : {}),
      // Error-family outcomes carry a fingerprint (`timeout`, `rate-limit`, …):
      // `error` alone could not tell a dead route from a throttled one.
      ...(failure?.fingerprint
        ? { errorKinds: { ...current.errorKinds, [failure.fingerprint]: (current.errorKinds?.[failure.fingerprint] ?? 0) + 1 } }
        : {}),
    })
    this.scheduleFlush()
  }

  private base(sessionId: string): SupervisorSessionState {
    return (
      this.sessions.get(sessionId) ??
      this.restored.get(sessionId) ?? {
        sessionId,
        reviewer: 'idle' as ReviewerState,
        steps: 0,
        reviews: 0,
        outcomes: {},
        pending: false,
      }
    )
  }

  /**
   * Live sessions plus restored entries this generation never touched. Without
   * them a reload would silently shrink the ledger: totals would under-report
   * and the next flush would drop every session that had no activity since the
   * restart — exactly the history the file exists to keep.
   */
  private all(): SupervisorSessionState[] {
    const merged = [...this.sessions.values()]
    for (const [sessionId, session] of this.restored) {
      if (!this.sessions.has(sessionId)) merged.push(session)
    }
    return merged
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  snapshot(): { alerts: SupervisorAlert[]; sessions: SupervisorSessionState[] } {
    return {
      alerts: this.alerts.map((a) => ({ ...a })),
      sessions: this.all().map((s) => ({ ...s, outcomes: { ...s.outcomes } })),
    }
  }

  /** One-line health answer for `/state`: is it running, and did it ever speak? */
  totals(): {
    sessions: number
    steps: number
    reviews: number
    notes: number
    unhealthy: number
    outcomes: Record<string, number>
    parseFails: Record<string, number>
    /** parseFails keyed by `provider/model`, so a contract-breaking route is
     *  visible instead of hiding inside the global average. Sessions restored
     *  from before route persistence land under `unknown`. */
    parseFailsByRoute: Record<string, Record<string, number>>
    /** Failed reviews by fingerprint (`timeout`, `rate-limit`, …). */
    errorKinds: Record<string, number>
    /** Notes by reported category; `unreported` counts notes that omitted it. */
    noteCategories: Record<string, number>
  } {
    const outcomes: Record<string, number> = {}
    const parseFails: Record<string, number> = {}
    const parseFailsByRoute: Record<string, Record<string, number>> = {}
    const errorKinds: Record<string, number> = {}
    const noteCategories: Record<string, number> = {}
    let steps = 0
    let reviews = 0
    for (const session of this.all()) {
      steps += session.steps
      reviews += session.reviews
      const route = session.route ? `${session.route.provider}/${session.route.model}` : 'unknown'
      for (const [outcome, count] of Object.entries(session.outcomes)) {
        outcomes[outcome] = (outcomes[outcome] ?? 0) + count
      }
      for (const [reason, count] of Object.entries(session.parseFails ?? {})) {
        parseFails[reason] = (parseFails[reason] ?? 0) + count
        const bucket = (parseFailsByRoute[route] ??= {})
        bucket[reason] = (bucket[reason] ?? 0) + count
      }
      for (const [kind, count] of Object.entries(session.errorKinds ?? {})) {
        errorKinds[kind] = (errorKinds[kind] ?? 0) + count
      }
      for (const [category, count] of Object.entries(session.noteCategories ?? {})) {
        noteCategories[category] = (noteCategories[category] ?? 0) + count
      }
    }
    const unhealthy = UNHEALTHY_OUTCOMES.reduce((sum, outcome) => sum + (outcomes[outcome] ?? 0), 0)
    return {
      sessions: this.all().length,
      steps,
      reviews,
      notes: outcomes.note ?? 0,
      unhealthy,
      outcomes,
      parseFails,
      parseFailsByRoute,
      errorKinds,
      noteCategories,
    }
  }

  /** Debounced write of the counters; a burst of reviews costs one write. */
  private scheduleFlush(): void {
    if (!this.persistPath) return
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, FLUSH_DEBOUNCE_MS)
    this.flushTimer.unref?.()
  }

  /** Write the counters now (also cancels any pending debounced write). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (!this.persistPath) return
    const sessions: Record<string, PersistedSession> = {}
    for (const session of this.all()) {
      sessions[session.sessionId] = {
        steps: session.steps,
        reviews: session.reviews,
        outcomes: { ...session.outcomes },
        ...(session.route ? { route: { ...session.route } } : {}),
        ...(session.parseFails ? { parseFails: { ...session.parseFails } } : {}),
        ...(session.errorKinds ? { errorKinds: { ...session.errorKinds } } : {}),
              }
    }
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      writeFileSync(this.persistPath, JSON.stringify({ sessions }, null, 2))
    } catch (error) {
      this.logger?.warn?.('supervisor state persist failed', { error: String(error) })
    }
  }
}
