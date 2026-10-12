import z from '@deepseek-ai/schemastery'

export interface Config {
  enabled: boolean
  stepsBetweenReviews: number
  intercept: boolean
  maxDeltaMessages: number
  maxNoteChars: number
  reviewMaxTokens: number
  /** Use the jev tool as a cheap detection gate before each LLM review. */
  jevGate: boolean
  /** Opt-in cost mode: let a clear gate verdict skip the LLM review entirely. */
  gateSkipClear: boolean
  /**
   * Fallback review route, used after `fallbackAfterErrors` consecutive
   * transient failures on the session's own route (the blind-spot fix: a dead
   * review route no longer silences the supervisor for the whole session).
   * Empty strings mean "no fallback".
   */
  fallbackProvider: string
  fallbackModel: string
  fallbackAfterErrors: number
  /**
   * Optional review-model override. Empty strings (the default) keep the
   * reviewer on the session's own route — each session reviews with whatever
   * model its main agent uses. Fill both to pin the reviewer to one model
   * across all sessions: live data shows a strong main-agent model can be a
   * contract-breaking reviewer (hy3/step-5-preview: 7/7 no_frame), and the
   * two roles reward different models.
   */
  reviewProvider: string
  reviewModel: string
}

/**
 * Host-facing schema. Every field is `volatile`, which is what makes it appear
 * on the Plugins page at all: the settings service only exposes namespaces whose
 * schema has at least one volatile field, and a volatile-only write hot-swaps the
 * value without remounting the plugin.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  stepsBetweenReviews: z.number().min(1).max(60).default(6).volatile(),
  intercept: z.boolean().default(false).volatile(),
  maxDeltaMessages: z.number().min(0).max(500).default(60).volatile(),
  maxNoteChars: z.number().min(80).max(4000).default(600).volatile(),
  reviewMaxTokens: z.number().min(128).max(8192).default(2048).volatile(),
  jevGate: z.boolean().default(true).volatile(),
  gateSkipClear: z.boolean().default(false).volatile(),
  fallbackProvider: z.string().default('').volatile(),
  fallbackModel: z.string().default('').volatile(),
  fallbackAfterErrors: z.number().min(1).max(20).default(3).volatile(),
  reviewProvider: z.string().default('').volatile(),
  reviewModel: z.string().default('').volatile(),
})

const DEFAULTS: Required<Config> = {
  enabled: true,
  stepsBetweenReviews: 6,
  // Off by default: rejecting a step ends the running turn, which reads to the
  // user like the conversation being cut and restarted. Silent inject instead.
  intercept: false,
  maxDeltaMessages: 60,
  maxNoteChars: 600,
  // `maxTokens` bounds *reasoning + text* on thinking models. Observed live:
  // deepseek-v4.1-flash spent all 768 on hidden reasoning and returned an empty
  // body (`finish=max-tokens`), so every review was wasted. It is a cap, not a
  // cost — a short reply bills the same either way — so leave room.
  reviewMaxTokens: 2048,
  jevGate: true,
  // Accuracy first: off by default, a clear gate verdict still pays for the
  // LLM review, so a gate miss can never drop a review on the floor — and
  // every clear delta doubles as a measured false-clear sample for free.
  gateSkipClear: false,
  fallbackProvider: '',
  fallbackModel: '',
  fallbackAfterErrors: 3,
  // Follow the session's own model by default; the override is opt-in.
  reviewProvider: '',
  reviewModel: '',
}

/**
 * A volatile field resolves to a live reference (`{ get() }`), not the value —
 * so `typeof ctx.config.stepsBetweenReviews` is `'object'` and every coercion
 * below would silently fall back to the default. Unwrap by shape rather than by
 * importing cosmokit, which is not a declared peer.
 */
function unwrap(value: unknown): unknown {
  const candidate = value as { get?: () => unknown } | null
  if (typeof candidate === 'object' && candidate !== null && typeof candidate.get === 'function') {
    return candidate.get()
  }
  return value
}

function num(value: unknown, fallback: number, min: number): number {
  const raw = unwrap(value)
  const parsed = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.floor(parsed))
}

function bool(value: unknown, fallback: boolean): boolean {
  const raw = unwrap(value)
  return typeof raw === 'boolean' ? raw : fallback
}

function str(value: unknown, fallback: string): string {
  const raw = unwrap(value)
  return typeof raw === 'string' ? raw.trim() : fallback
}

/**
 * Single source of truth for the effective configuration; never throws.
 * `raw` is what the host handed to `apply()` — with volatile fields still
 * wrapped in live references — or a snapshot re-read from `ctx.config`.
 */
export function resolveConfig(raw: unknown): Required<Config> {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    enabled: bool(source.enabled, DEFAULTS.enabled),
    stepsBetweenReviews: num(source.stepsBetweenReviews, DEFAULTS.stepsBetweenReviews, 1),
    intercept: bool(source.intercept, DEFAULTS.intercept),
    maxDeltaMessages: num(source.maxDeltaMessages, DEFAULTS.maxDeltaMessages, 0),
    maxNoteChars: num(source.maxNoteChars, DEFAULTS.maxNoteChars, 80),
    reviewMaxTokens: num(source.reviewMaxTokens, DEFAULTS.reviewMaxTokens, 128),
    jevGate: bool(source.jevGate, DEFAULTS.jevGate),
    gateSkipClear: bool(source.gateSkipClear, DEFAULTS.gateSkipClear),
    fallbackProvider: str(source.fallbackProvider, DEFAULTS.fallbackProvider),
    fallbackModel: str(source.fallbackModel, DEFAULTS.fallbackModel),
    fallbackAfterErrors: num(source.fallbackAfterErrors, DEFAULTS.fallbackAfterErrors, 1),
    reviewProvider: str(source.reviewProvider, DEFAULTS.reviewProvider),
    reviewModel: str(source.reviewModel, DEFAULTS.reviewModel),
  }
}
