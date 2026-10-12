// Identity + the message-source kind we stamp on our own injected notices.
//
// `MessageSourceMap` is merge-extensible on purpose: every producer declares
// its own `kind` in its own module, there is no shared catch-all `plugin` kind.

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    supervisor: { kind: 'supervisor' } & ContextFormed
  }
}

export const SUPERVISOR_PLUGIN_ID = 'dsh-supervisor'

/** Persistent key written into the session log; do not rename casually. */
export const SUPERVISOR_SOURCE_KIND = 'supervisor'

/** Same string as `source.kind`, kept here so callers never typo it. */
export const REVIEWER_CLAIM_KEY = '__dshSupervisorReviewer__'

export interface SupervisorNote {
  readonly note: string
  readonly severity: 'concern' | 'blocker'
}

/**
 * True for messages we injected earlier. Used twice: to skip our own notices
 * when building the next transcript delta (so the reviewer never reads itself),
 * and to recognise them if they come back through the session event feed.
 */
export function isSupervisorMessage(message: unknown): boolean {
  const source = (message as { source?: { kind?: string } } | null | undefined)?.source
  return source?.kind === SUPERVISOR_SOURCE_KIND
}

export function isNote(value: unknown): value is SupervisorNote {
  if (typeof value !== 'object' || value === null) return false
  const { note, severity } = value as { note?: unknown; severity?: unknown }
  if (typeof note !== 'string' || note.trim().length === 0) return false
  return severity === 'concern' || severity === 'blocker'
}
