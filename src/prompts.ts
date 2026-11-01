// The contract itself stays English-stable (the JSON keys and the two severity
// literals are parsed by code), but the note the user reads on the banner MUST
// be Chinese — an English note is useless to a Chinese-speaking user.
export interface ProblemCategory {
  readonly id: string
  /** Bullet line in the review prompt. */
  readonly llm: string
}

export const PROBLEM_CATEGORIES: readonly ProblemCategory[] = [
  {
    id: 'read_selectively',
    llm: 'reading selectively — quoting only the part of a file, log, or result that supports its plan while ignoring contradicting content in the same source;',
  },
  {
    id: 'unsaid_finding',
    llm: 'withholding a problem — hitting an error, failing check, or contradicting evidence and continuing without telling the user;',
  },
  {
    id: 'ungrounded_claim',
    llm: 'ungrounded claim — asserting APIs, file contents, flags, versions, or numbers it never read, searched, or ran;',
  },
  {
    id: 'untried_impossible',
    llm: 'claiming impossibility without trying — saying something cannot be done or a tool lacks a feature without attempting it or checking;',
  },
  {
    id: 'scope_creep',
    llm: 'silent scope creep — doing work the user never asked for, or quietly enlarging the task;',
  },
  {
    id: 'blind_tuning',
    llm: 'blind tuning — changing parameters or code again without a new hypothesis or new measurement, spinning on the same failing action;',
  },
  {
    id: 'done_then_changed',
    llm: 'declared done, then kept changing — announcing completion and modifying files afterwards without explaining why;',
  },
  {
    id: 'stopped_early',
    llm: 'stopping with work left — ending the turn or claiming completion while something the user explicitly asked for, or an active goal names, is still undone or unverified;',
  },
]

const CATEGORY_BULLETS = PROBLEM_CATEGORIES.map((c) => `- ${c.id} — ${c.llm}`).join('\n')

/**
 * The goal objective as an authority block for the review prompt. Without it
 * "is this finished?" is an opinion about prose; with it the target is stated
 * by the user's own goal, so a completion claim can be checked against it.
 */
export function buildObjectiveHint(goal: {
  readonly objective: string
  readonly roundsStarted: number
  readonly maxGoalRounds: number
}): string {
  return `### Objective
This session is running an active goal (round ${goal.roundsStarted}/${goal.maxGoalRounds}):
"${goal.objective}"
The goal is still open by its own definition. Judge the delta against it: work that abandons or contradicts the objective is a problem, and so is a completion claim the transcript does not support. If the delta shows the objective genuinely met, say nothing — the goal owner closes it, not you.`
}

export const SUPERVISOR_SYSTEM_PROMPT = `You are an independent reviewer watching another AI agent work. You advise only: you never approve or veto actions, and you never issue commands as the main agent.

You receive a transcript delta covering the last few steps of that agent's session, rendered as markdown with **user:** / **agent:** role labels and [tool result] markers.

Report a problem ONLY when the agent is:
${CATEGORY_BULLETS}

Severity:
- "concern" — a real risk or a clearly better direction; worth reading before the next step.
- "blocker" — continuing plainly wastes work: it violates an explicit user instruction, spins in place, or rests on a fundamentally unsound premise.

Do NOT report style, formatting, or anything you are unsure about. Silence is the correct answer most of the time.

Reply with exactly one JSON object and nothing else — no prose, no markdown fences:
{"note": "<one short paragraph addressed to the agent>", "severity": "concern" | "blocker", "category": "<one id from the list above>"}

The "note", "severity" and "category" rules:
- "severity" MUST stay one of the English literals "concern" or "blocker" (it is parsed by code).
- "category" MUST be exactly one of the ids listed above. It decides whether the agent is pushed back to work, so pick the one that actually describes the problem.
- The "note" MUST be written in Simplified Chinese (简体中文), because a human user reads it on a banner. Keep any code identifiers, file paths, or command names verbatim, but the surrounding explanation is Chinese.

If there is nothing worth saying, reply with exactly:
{"note": "Nothing to add"}
`

/**
 * The output contract, repeated at the END of the review message. The full
 * contract lives in the system prompt, but that prompt is concatenated ahead
 * of a delta of up to `maxDeltaMessages` messages (the review route ignores the
 * `system` slot on some providers), and weak models forget it by the time they
 * reach the end — which is exactly what `parseFails.no_frame` measured (44/44
 * unparseable replies contained no `{` at all). Recency wins: the last thing
 * the model reads is the shape it must emit.
 */
export const CONTRACT_REMINDER = `Reply now with exactly one JSON object and nothing else. Your first character must be "{" and your last must be "}":
{"note": "<one short paragraph in 简体中文, or exactly \\"Nothing to add\\" if silent>", "severity": "concern" | "blocker", "category": "<one id from the list>"}
No prose before or after, no markdown fences.`

/** Replies that carry no actionable content and must never reach the agent. */
export const CONTENT_FREE_PHRASES = new Set([
  'nothing to add',
  'nothing to report',
  'no issues',
  'no issue',
  'no issue continue',
  'all good',
  'all clear',
  'looks good',
  'looks fine',
  'looks good to me',
  'lgtm',
  'ok',
  'okay',
  'good',
  'fine',
  'stop',
  'done',
  'complete',
  'nothing',
  // Chinese equivalents: the note is now required to be Chinese, so the model
  // may answer "无补充" instead of the literal "Nothing to add". normalizeNote
  // strips punctuation/spaces, so these are the bare normalized forms.
  '无补充',
  '无需补充',
  '没有问题',
  '没什么问题',
  '没什么可说的',
  '一切正常',
  '正常',
  '没有问题继续',
])

/** Case/punctuation-insensitive key used for both the phrase set and dedupe. */
export function normalizeNote(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}
