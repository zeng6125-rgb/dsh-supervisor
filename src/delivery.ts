// Advice delivery + the opt-in "intercept once" gate.
//
// Default path is silent: a surviving note is injected into the running
// session (`agent.inject`), where it rides the next claimed batch without
// waking the agent or opening a turn of its own. With `intercept` enabled the
// semantics change to: on the first problem hold the next step
// (`agent/pre-step` → reject), put the claimed messages back exactly as they
// were, and hand the agent our notice; the step after that passes normally
// with the same problems attached. Advisory only — we never decide for the
// agent.

import { SUPERVISOR_SOURCE_KIND, type SupervisorNote } from './kinds.js'

export interface DeliveryAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly inbox: {
    readonly hasPending: boolean
    prepend(target: 'next-turn' | 'next-step', message: any): void
  }
  steer(message: any): void
  inject(message: any): void
  whenIdle(): Promise<void>
}

export interface DeliveryOptions {
  intercept: boolean
  lookupAgent?: (sessionId: string) => DeliveryAgent | undefined
  createUserMessage: (input: any) => any
  boundContextSummary: (summary: string) => string
  logger?: { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/** Text the agent sees; the prefix is its only cue that this is advice. */
export function renderNoteText(note: SupervisorNote): string {
  return `[supervisor:${note.severity}] ${note.note}`
}

export class SupervisorDelivery {
  private readonly agents = new Map<string, DeliveryAgent>()
  /** Sessions whose next proposed step is held once, with the note to carry. */
  private readonly gates = new Map<string, SupervisorNote>()
  private intercept: boolean

  constructor(private readonly options: DeliveryOptions) {
    this.intercept = options.intercept
  }

  setIntercept(value: boolean): void {
    this.intercept = value
    if (!value) this.gates.clear()
  }

  registerAgent(agent: DeliveryAgent): void {
    this.agents.set(agent.id, agent)
  }

  unregisterAgent(sessionId: string): void {
    this.agents.delete(sessionId)
    this.armed.delete(sessionId)
    this.gates.delete(sessionId)
  }

  /** Forget a held gate (compaction rewrote history, or the session ended). */
  disarm(sessionId: string): void {
    this.gates.delete(sessionId)
  }

  /**
   * The turn completed: a held gate must not fold the final output into an
   * extra turn. Instead of dropping the note (silent loss) or holding the
   * step (the fold the user reported), hand it to the running work as a
   * silent inject — the summary stays whole and the advice still lands.
   * Returns the released note and the channel it rode, or undefined when
   * nothing was armed (the caller records the alert under the real channel).
   */
  releaseAtTurnEnd(sessionId: string): { note: SupervisorNote; channel: 'delivered' | 'dropped' } | undefined {
    const note = this.gates.get(sessionId)
    if (!note) return undefined
    this.gates.delete(sessionId)
    this.options.logger?.debug?.('gate released at turn end', { sessionId, severity: note.severity })
    return { note, channel: this.deliver(sessionId, note) ? 'delivered' : 'dropped' }
  }

  isArmed(sessionId: string): boolean {
    return this.gates.has(sessionId)
  }

  private get armed(): Map<string, SupervisorNote> {
    return this.gates
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

  /**
   * The turn this note reviews has already completed: inject it as a silent
   * notice regardless of the intercept setting. Arming would hold a step of
   * the *next* turn — an extra output the user never asked for. Returns the
   * channel it rode (`dropped` when no agent is reachable).
   */
  deliverClosedTurn(sessionId: string, note: SupervisorNote): 'delivered' | 'dropped' {
    this.options.logger?.debug?.('note delivered for a closed turn', { sessionId, severity: note.severity })
    return this.deliver(sessionId, note) ? 'delivered' : 'dropped'
  }

  /**
   * A note survived the emission guard. With interception on, hold the next
   * step for it; otherwise route the notice straight into the running work.
   */
  raise(sessionId: string, note: SupervisorNote): 'armed' | 'delivered' | 'dropped' {
    if (this.intercept && !this.gates.has(sessionId)) {
      this.gates.set(sessionId, note)
      this.options.logger?.debug?.('step gate armed', { sessionId, severity: note.severity })
      return 'armed'
    }
    return this.deliver(sessionId, note) ? 'delivered' : 'dropped'
  }

  private deliver(sessionId: string, note: SupervisorNote): boolean {
    const agent = this.agents.get(sessionId) ?? this.options.lookupAgent?.(sessionId)
    if (!agent) {
      // Advisory only: never throw and never stall the loop over a lost note.
      this.options.logger?.warn?.('note dropped — no agent for session', { sessionId, severity: note.severity })
      return false
    }
    const message = this.buildMessage(note)
    // Silent by default: inject only rides the next claimed batch and never
    // opens a turn of its own. A steer wake made an idle session start a fresh
    // turn out of nowhere, which read to the user as the conversation
    // restarting itself; the opt-in intercept path resumes with steer instead.
    agent.inject(message)
    return true
  }

  /**
   * `agent/pre-step` hook body: hold the proposed step once and re-queue it.
   */
  interceptStep(sessionId: string, agent: DeliveryAgent, claimed: readonly unknown[]): boolean {
    const note = this.gates.get(sessionId)
    if (!note) return false
    this.gates.delete(sessionId)

    // A rejected step keeps its claimed batch out of the inbox and closes the
    // turn without ever surfacing those messages, so put them back verbatim.
    // prepend() inserts at the head, hence the reverse walk preserves order.
    for (let i = claimed.length - 1; i >= 0; i--) {
      try {
        agent.inbox.prepend('next-step', claimed[i])
      } catch (error) {
        this.options.logger?.warn?.('re-queue skipped', { sessionId, error: String(error) })
      }
    }

    // Rejecting closes the turn and the driver parks in `idle` with pending
    // work but no wake requested, so we resume it ourselves once it settles.
    void this.resume(agent, sessionId, note)
    return true
  }

  private async resume(agent: DeliveryAgent, sessionId: string, note: SupervisorNote): Promise<void> {
    try {
      if (agent.status === 'running') await agent.whenIdle()
      if (!agent.inbox.hasPending) {
        // The re-queue never landed, so there is no batch for the note to ride.
        // Wake the driver anyway: we already cost this session a step by
        // holding it, and dropping the note now would make that hold pointless.
        this.options.logger?.warn?.('resuming with the note alone', { sessionId })
      }
      // The notice joins the re-queued batch: the second step passes normally
      // and carries the problems with it.
      agent.steer(this.buildMessage(note))
    } catch (error) {
      this.options.logger?.warn?.('resume after reject failed', { sessionId, error: String(error) })
    }
  }
}
