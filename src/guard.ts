// Duplicate / empty-note suppression. One note per review, and a repeat of a
// problem we already raised at equal-or-higher severity stays silent.

import { CONTENT_FREE_PHRASES, normalizeNote } from './prompts.js'
import type { SupervisorNote } from './kinds.js'

const SEVERITY_RANK: Record<SupervisorNote['severity'], number> = { concern: 0, blocker: 1 }
const DEFAULT_MAX_HISTORY = 512

export class EmissionGuard {
  private readonly history = new Map<string, SupervisorNote['severity']>()
  private readonly maxHistory: number
  private acceptedThisReview = false

  constructor(maxHistory = DEFAULT_MAX_HISTORY) {
    this.maxHistory = maxHistory
  }

  /** Call once per reviewer update, before `accept`. */
  beginReview(): void {
    this.acceptedThisReview = false
  }

  accept(note: SupervisorNote): boolean {
    const key = normalizeNote(note.note)
    if (!key) return false
    if (CONTENT_FREE_PHRASES.has(key)) return false
    if (this.acceptedThisReview) return false

    const prior = this.history.get(key)
    // A genuine escalation still gets through; an equal-or-weaker repeat does not.
    if (prior !== undefined && SEVERITY_RANK[note.severity] <= SEVERITY_RANK[prior]) return false

    this.history.set(key, note.severity)
    if (this.history.size > this.maxHistory) {
      const oldest = this.history.keys().next().value
      if (oldest !== undefined) this.history.delete(oldest)
    }
    this.acceptedThisReview = true
    return true
  }

  reset(): void {
    this.history.clear()
    this.acceptedThisReview = false
  }
}
