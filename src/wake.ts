// When a review note may push an idle agent back to work.
//
// Everything here is a pure decision over explicit inputs so the only claim
// that cannot be exercised in tests is the `followup` call itself. Kept out of
// the plugin body because "may I wake this session?" is exactly the kind of
// rule that silently drifts if it only exists inline.

/** The one category allowed to open a turn. */
export const WAKE_CATEGORY = 'stopped_early'

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

export interface WakeInput {
  /** The note's self-reported category; absent when the route omitted it. */
  readonly category: string | undefined
  /** Both switches, already resolved: the guard is on and reviewing is enabled. */
  readonly guardEnabled: boolean
  /** Shared with the attach rate limit; 0 disables the window. */
  readonly cooldownMs: number
  /** Epoch ms of this session's previous wake, if any. */
  readonly lastWakeAt: number | undefined
  readonly now: number
  /** The session's goal phase, or undefined when it has no open goal. */
  readonly goalPhase: GoalPhase | undefined
}

/**
 * Four independent gates, all of which must pass. The failure direction is
 * deliberate: an unknown category, a closed goal, or a missing report all mean
 * "do not wake", so a weak model that drops `category` costs a nudge rather
 * than opening turns nobody asked for.
 */
export function shouldWake(input: WakeInput): boolean {
  if (input.category !== WAKE_CATEGORY) return false
  if (!input.guardEnabled) return false
  // A goal that is not active belongs to its owner's verdict — the host has
  // already decided the work is done, paused, or blocked.
  if (input.goalPhase !== undefined && input.goalPhase !== 'active') return false
  if (input.cooldownMs > 0 && input.lastWakeAt !== undefined) {
    if (input.now - input.lastWakeAt < input.cooldownMs) return false
  }
  return true
}