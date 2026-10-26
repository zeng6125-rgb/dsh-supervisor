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
  /** Gate-vs-LLM agreement: how often jev screened clear, and how often the
   *  LLM then disagreed with a note (a measured gate miss). `flagged` counts
   *  deltas the gate hit on, `confirmed` the subset where the review then
   *  raised a note — the hit side of the ledger, co-occurrence not attribution. */
  readonly gate?: { readonly cleared: number; readonly falseClears: number; readonly flagged: number; readonly confirmed: number }
  /** Which categories the false clears were about (note self-report; `unknown`
   *  when the route did not report any). Answers "which problem class does the
   *  gate systematically miss" without a contract break on older routes. */
  readonly falseClearsByCat?: Readonly<Record<string, number>>
  /** A queued note is waiting to ride the next step the agent enters. */
  readonly pending: boolean
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
  falseClearsByCat?: Record<string, number>
  gate?: { cleared: number; falseClears: number; flagged?: number; confirmed?: number }
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
   * evidence of how the gate has been calibrating). Alerts stay in memory:
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
          ...(saved.falseClearsByCat ? { falseClearsByCat: { ...saved.falseClearsByCat } } : {}),
          ...(saved.gate
            ? {
                gate: {
                  cleared: saved.gate.cleared ?? 0,
                  falseClears: saved.gate.falseClears ?? 0,
                  flagged: saved.gate.flagged ?? 0,
                  confirmed: saved.gate.confirmed ?? 0,
                },
              }
            : {}),
          pending: false,
        })
      }
    } catch {
      // Missing or corrupt file: start from zero rather than crash the plugin.
    }
  }

  recordAlert(sessionId: string, note: SupervisorNote, channel: DeliveryChannel): SupervisorAlert {
    const alert: SupervisorAlert = {
      id: `s${++this.seq}`,
      sessionId,
      severity: note.severity,
      note: note.note,
      at: Date.now(),
      channel,
      acked: false,
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

  /** One gate-vs-LLM agreement sample, for threshold calibration. */
  recordGate(sessionId: string, stat: 'cleared' | 'false_clear' | 'flagged' | 'flag_confirmed', categories?: readonly string[]): void {
    const current = this.base(sessionId)
    const gate = current.gate ?? { cleared: 0, falseClears: 0, flagged: 0, confirmed: 0 }
    // A false clear's categories show which problem class the gate missed.
    // An unreported (or hallucinated-to-empty) list lands in `unknown` so the
    // sample still counts.
    let falseClearsByCat = current.falseClearsByCat
    if (stat === 'false_clear') {
      const keys = categories && categories.length > 0 ? categories : ['unknown']
      const next = { ...(falseClearsByCat ?? {}) }
      for (const key of keys) next[key] = (next[key] ?? 0) + 1
      falseClearsByCat = next
    }
    this.sessions.set(sessionId, {
      ...current,
      ...(falseClearsByCat ? { falseClearsByCat } : {}),
      gate: {
        cleared: gate.cleared + (stat === 'cleared' ? 1 : 0),
        falseClears: gate.falseClears + (stat === 'false_clear' ? 1 : 0),
        flagged: gate.flagged + (stat === 'flagged' ? 1 : 0),
        confirmed: gate.confirmed + (stat === 'flag_confirmed' ? 1 : 0),
      },
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
    /** Categories the gate's false clears were about (`unknown` when the
     *  reviewing route did not self-report). */
    falseClearsByCat: Record<string, number>
    /** Gate agreement keyed by route, each bucket carrying its `reviews`
     *  denominator: a 1/1 miss is not a 100% miss rate. A rising miss rate
     *  concentrated on one route is a prompt problem; spread evenly it is a
     *  threshold problem. */
    gateByRoute: Record<string, { cleared: number; falseClears: number; flagged: number; confirmed: number; reviews: number }>
    gate: { cleared: number; falseClears: number; flagged: number; confirmed: number }
  } {
    const outcomes: Record<string, number> = {}
    const parseFails: Record<string, number> = {}
    const parseFailsByRoute: Record<string, Record<string, number>> = {}
    const errorKinds: Record<string, number> = {}
    const falseClearsByCat: Record<string, number> = {}
    const gateByRoute: Record<string, { cleared: number; falseClears: number; flagged: number; confirmed: number; reviews: number }> = {}
    const gate = { cleared: 0, falseClears: 0, flagged: 0, confirmed: 0 }
    let steps = 0
    let reviews = 0
    for (const session of this.all()) {
      steps += session.steps
      reviews += session.reviews
      const route = session.route ? `${session.route.provider}/${session.route.model}` : 'unknown'
      const routeGate = (gateByRoute[route] ??= { cleared: 0, falseClears: 0, flagged: 0, confirmed: 0, reviews: 0 })
      gate.cleared += session.gate?.cleared ?? 0
      gate.falseClears += session.gate?.falseClears ?? 0
      gate.flagged += session.gate?.flagged ?? 0
      gate.confirmed += session.gate?.confirmed ?? 0
      routeGate.cleared += session.gate?.cleared ?? 0
      routeGate.falseClears += session.gate?.falseClears ?? 0
      routeGate.flagged += session.gate?.flagged ?? 0
      routeGate.confirmed += session.gate?.confirmed ?? 0
      routeGate.reviews += session.reviews
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
      for (const [cat, count] of Object.entries(session.falseClearsByCat ?? {})) {
        falseClearsByCat[cat] = (falseClearsByCat[cat] ?? 0) + count
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
      falseClearsByCat,
      gateByRoute,
      gate,
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
        ...(session.falseClearsByCat ? { falseClearsByCat: { ...session.falseClearsByCat } } : {}),
        ...(session.gate ? { gate: { ...session.gate } } : {}),
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
