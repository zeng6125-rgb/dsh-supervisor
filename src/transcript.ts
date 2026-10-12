// Per-session transcript buffer + step counting.
//
// Fed from the `session/event` post-commit feed (never from the deprecated
// `session.snapshotEvents()`), rendered to role-labelled markdown, and flushed
// as a delta every N `step/end` events.

import { isSupervisorMessage } from './kinds.js'

export interface TranscriptDelta {
  readonly markdown: string
  readonly steps: number
}

export interface TranscriptObserverOptions {
  stepsBetweenReviews: number
  maxDeltaMessages: number
  /** A review-sized delta is ready for this session. */
  onDelta: (sessionId: string, delta: TranscriptDelta) => void
  /** Every committed step, for delivery bookkeeping. */
  onStepEnd: (sessionId: string, turn: number, step: number) => void
  /** The surface was rewritten (compaction): everything buffered is stale. */
  onRewrite: (sessionId: string) => void
  logger?: { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

interface SessionBuffer {
  /** Rendered lines not yet sent to a reviewer. */
  pending: string[]
  /** Committed steps since the last flush. */
  steps: number
}

const MAX_LINE_CHARS = 2000
const MAX_DELTA_CHARS = 24_000
const OMISSION_MARK = '… <earlier messages omitted>'

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

/** Content blocks → one line of markdown. Reasoning is deliberately excluded. */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type } = block as { type?: string }
    if (type === 'text') {
      const text = (block as { text?: string }).text
      if (typeof text === 'string' && text.trim()) parts.push(truncate(text, MAX_LINE_CHARS))
    } else if (type === 'tool-call') {
      const { name, arguments: args } = block as { name?: string; arguments?: string }
      parts.push(`[calls ${String(name ?? '?')} ${truncate(String(args ?? ''), 240)}]`)
    }
  }
  return parts.join(' ')
}

export class SessionTranscript {
  private readonly buffers = new Map<string, SessionBuffer>()
  private stepsBetweenReviews: number
  private maxDeltaMessages: number

  constructor(private readonly options: TranscriptObserverOptions) {
    this.stepsBetweenReviews = options.stepsBetweenReviews
    this.maxDeltaMessages = options.maxDeltaMessages
  }

  setStepsBetweenReviews(value: number): void {
    this.stepsBetweenReviews = value
  }

  setMaxDeltaMessages(value: number): void {
    this.maxDeltaMessages = value
  }

  private buffer(sessionId: string): SessionBuffer {
    let entry = this.buffers.get(sessionId)
    if (!entry) {
      entry = { pending: [], steps: 0 }
      this.buffers.set(sessionId, entry)
    }
    return entry
  }

  /** Handle one committed session event. */
  handleEvent(sessionId: string, event: any): void {
    if (typeof event?.type !== 'string') return
    const entry = this.buffer(sessionId)

    switch (event.type) {
      case 'user/message': {
        const message = event.data
        // A surface replace means compaction rewrote history: drop what we had
        // and start from the summary that replaces it, so the next review still
        // knows what came before.
        if (event.surfaceOp?.op === 'replace') {
          entry.pending = []
          entry.steps = 0
          this.options.onRewrite(sessionId)
          const summary = renderContent(message?.content)
          if (summary) entry.pending.push(`**user:** ${summary}`)
          return
        }
        // Our own injected notices never re-enter the reviewer's view.
        if (isSupervisorMessage(message)) return
        const text = renderContent(message?.content)
        if (text) entry.pending.push(`**user:** ${text}`)
        return
      }
      case 'assistant/message': {
        const text = renderContent(event.data?.message?.content)
        if (text) entry.pending.push(`**agent:** ${text}`)
        return
      }
      case 'tool/result': {
        const text = renderContent(event.data?.message?.content)
        if (text) entry.pending.push(`[tool result] ${text}`)
        return
      }
      case 'step/end': {
        const turn = Number(event.data?.turn ?? 0)
        const step = Number(event.data?.step ?? 0)
        entry.steps += 1
        this.options.onStepEnd(sessionId, turn, step)
        if (entry.steps >= this.stepsBetweenReviews) this.flush(sessionId)
        return
      }
      default:
        return
    }
  }

  /** Send whatever accumulated, if it is worth a reviewer call. */
  private flush(sessionId: string): void {
    const entry = this.buffers.get(sessionId)
    if (!entry) return
    const steps = entry.steps
    entry.steps = 0
    if (entry.pending.length === 0) return

    let lines = entry.pending
    entry.pending = []
    if (this.maxDeltaMessages > 0 && lines.length > this.maxDeltaMessages) {
      lines = [...lines.slice(-this.maxDeltaMessages)]
      lines.unshift(OMISSION_MARK)
    }

    // Hard char budget, kept from the tail so the newest work always survives.
    let markdown = ''
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = markdown ? `${lines[i]}\n${markdown}` : lines[i]
      if (candidate.length > MAX_DELTA_CHARS) {
        lines = lines.slice(i + 1)
        lines.unshift(OMISSION_MARK)
        break
      }
      markdown = candidate
    }
    if (!markdown) {
      markdown = [OMISSION_MARK, lines[lines.length - 1] ?? ''].join('\n')
    }

    this.options.logger?.debug?.('transcript delta ready', { sessionId, steps, lines: lines.length })
    this.options.onDelta(sessionId, { markdown, steps })
  }

  /** Flush whatever is left even though the step threshold was not reached. */
  flushNow(sessionId: string): void {
    const entry = this.buffers.get(sessionId)
    if (!entry) return
    entry.steps = this.stepsBetweenReviews
    this.flush(sessionId)
  }

  disposeSession(sessionId: string): void {
    this.buffers.delete(sessionId)
  }
}
