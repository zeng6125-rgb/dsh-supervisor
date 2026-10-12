// The jev detection gate.
//
// jev (`@dsh-external/dsh-jev`) exposes exactly one public capability for
// typed judgement: the `_dsh_external_dsh_jev_ask` tool (noul / choice / score
// primitives over a state blob). We use it as a cheap detector in front of the
// expensive LLM review: one call, one noul question per problem category, and
// only a flagged delta pays for a model call. jev is never modified — this file
// only ever calls the registered tool through the host's public ToolRuntime
// contract (`execute({ callId, name, arguments, signal })`).
//
// When jev is absent, unregistered, or errors, the gate reports `unavailable`
// and the reviewer falls back to a plain LLM review. The gate can only save
// money, never block a review.

import { buildGateQuestions, PROBLEM_CATEGORIES } from './prompts.js'

export const JEV_TOOL_NAME = '_dsh_external_dsh_jev_ask'

/** A noul probability at or above this counts as a hit. Calibrated on live probes: clean deltas score ~0.0-0.3, planted guessing ~0.98. */
export const GATE_THRESHOLD = 0.6

export interface GateHit {
  readonly id: string
  readonly probability: number
}

export type GateVerdict =
  | { readonly kind: 'clear' } // every category below threshold: skip the model call
  | { readonly kind: 'hits'; readonly hits: readonly GateHit[] } // at least one category flagged
  | { readonly kind: 'unavailable'; readonly reason: string } // no jev, or it failed: review anyway

/** The slice of the host ToolRuntime this gate needs (public contract only). */
export interface GateTools {
  get?(name: string): unknown
  execute(exec: {
    callId: string
    name: string
    arguments: unknown
    signal: AbortSignal
  }): Promise<{ isError?: boolean; error?: { message?: string }; value?: unknown; content?: unknown }>
}

type Logger = { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }

let callSeq = 0

/**
 * Parse the tool's text reply, one `name: noul=0.9841` line per question.
 * Anything else (`[usage] …`, prose) is ignored. Exported for tests.
 */
export function parseGateReply(text: string): Map<string, number> {
  const probs = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*noul\s*=\s*([0-9]*\.?[0-9]+)/.exec(line)
    if (!match) continue
    const value = Number(match[2])
    if (Number.isFinite(value)) probs.set(match[1], value)
  }
  return probs
}

function resultText(result: { value?: unknown; content?: unknown }): string {
  if (typeof result.value === 'string') return result.value
  const blocks = Array.isArray(result.content) ? result.content : []
  return blocks
    .map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

export class JevGate {
  constructor(
    private readonly tools: GateTools | undefined,
    private readonly logger?: Logger,
  ) {}

  /** jev is installed and its tool is registered right now. */
  get available(): boolean {
    return this.tools?.get?.(JEV_TOOL_NAME) !== undefined
  }

  async screen(deltaMarkdown: string, signal: AbortSignal): Promise<GateVerdict> {
    if (!this.available) return { kind: 'unavailable', reason: 'jev tool not registered' }
    try {
      const result = await this.tools!.execute({
        callId: `dsv-gate-${++callSeq}`,
        name: JEV_TOOL_NAME,
        arguments: { state: { delta: deltaMarkdown }, questions: buildGateQuestions() },
        signal,
      })
      if (result?.isError) {
        return { kind: 'unavailable', reason: String(result?.error?.message ?? 'jev gate errored') }
      }
      const probs = parseGateReply(resultText(result ?? {}))
      const hits: GateHit[] = []
      for (const category of PROBLEM_CATEGORIES) {
        const probability = probs.get(category.id)
        if (probability !== undefined && probability >= GATE_THRESHOLD) hits.push({ id: category.id, probability })
      }
      if (hits.length === 0) return { kind: 'clear' }
      this.logger?.debug?.('jev gate flagged', { hits })
      return { kind: 'hits', hits }
    } catch (error) {
      // A broken gate must never stall or block the review.
      this.logger?.warn?.('jev gate failed; reviewing without it', { error: String(error) })
      return { kind: 'unavailable', reason: String(error) }
    }
  }
}
