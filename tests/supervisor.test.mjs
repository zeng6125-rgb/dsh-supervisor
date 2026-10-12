// Verification for the parts that can hurt the host if wrong: the emission
// guard, the step counter / delta renderer, the reviewer failure policy, and
// above all the intercept path (re-queue order + resume), where a bug would
// either lose the user's queued messages or stall the agent.
//
// Run: node --test tests/
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EmissionGuard } from '../lib/guard.js'
import { SessionTranscript } from '../lib/transcript.js'
import { Reviewer } from '../lib/review.js'
import { SupervisorDelivery } from '../lib/delivery.js'
import { Config as ConfigSchema, resolveConfig } from '../lib/config.js'
import { SupervisorState } from '../lib/state.js'
import { SUPERVISOR_SYSTEM_PROMPT, PROBLEM_CATEGORIES, buildGateQuestions } from '../lib/prompts.js'
import { JevGate, parseGateReply, JEV_TOOL_NAME } from '../lib/jev-gate.js'

const sid = 'session-test'

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeAgent(sessionId = sid) {
  const inbox = []
  return {
    id: sessionId,
    status: 'running',
    inbox,
    steered: [],
    injected: [],
    get hasPending() {
      return inbox.length > 0
    },
  }
}

/** Wrap a fake agent into the shape SupervisorDelivery expects. */
function deliveryAgent(agent) {
  return {
    id: agent.id,
    status: agent.status,
    inbox: {
      get hasPending() {
        return agent.inbox.length > 0
      },
      prepend(target, message) {
        assert.equal(target, 'next-step')
        agent.inbox.unshift(message)
      },
    },
    steer(message) {
      agent.steered.push(message)
      agent.inbox.push(message)
    },
    inject(message) {
      agent.injected.push(message)
      agent.inbox.push(message)
    },
    whenIdle() {
      return Promise.resolve()
    },
  }
}

function fakeLlm(script) {
  return {
    calls: [],
    stream(options) {
      this.calls.push(options)
      const next = script.shift()
      if (!next) throw new Error('fake llm: script exhausted')
      if (next instanceof Error) {
        return {
          async *[Symbol.asyncIterator]() {
            throw next
          },
        }
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (const piece of next) yield { type: 'text-delta', text: piece }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

function delivery(intercept = true, agent) {
  const warnings = []
  const d = new SupervisorDelivery({
    intercept,
    lookupAgent: () => (agent ? deliveryAgent(agent) : undefined),
    createUserMessage: (input) => ({ role: 'user', ...input }),
    boundContextSummary: (summary) => summary,
    logger: { debug() {}, warn(...args) { warnings.push(args) } },
  })
  return { d, warnings }
}

/** Inbox contents as `id` for re-queued user messages, note text for ours. */
const inboxIds = (agent) => agent.inbox.map((m) => m.id ?? m.content[0].text)

const note = (text, severity = 'concern') => ({ note: text, severity })

// ── config ───────────────────────────────────────────────────────────────────

test('resolveConfig never throws and clamps', () => {
  assert.equal(resolveConfig(undefined).stepsBetweenReviews, 6)
  assert.equal(resolveConfig({ stepsBetweenReviews: -5 }).stepsBetweenReviews, 1)
  assert.equal(resolveConfig({ stepsBetweenReviews: '9' }).stepsBetweenReviews, 9)
  assert.equal(resolveConfig({ stepsBetweenReviews: NaN }).stepsBetweenReviews, 6)
  assert.equal(resolveConfig({ intercept: null }).intercept, false)
  assert.equal(resolveConfig({ maxNoteChars: 1 }).maxNoteChars, 80)
})

test('resolveConfig unwraps volatile references', () => {
  // The host validates `Config` before calling apply(), and a volatile field
  // resolves to `{ get() }` rather than the value. Reading it raw would make
  // every field look absent and silently fall back to its default.
  const volatile = (value) => ({ get: () => value })
  const cfg = resolveConfig({
    enabled: volatile(false),
    stepsBetweenReviews: volatile(3),
    intercept: volatile(false),
    maxDeltaMessages: volatile(0),
    maxNoteChars: volatile(1200),
    reviewMaxTokens: volatile(256),
    jevGate: volatile(false),
    gateSkipClear: volatile(true),
    fallbackProvider: volatile('hy3'),
    fallbackModel: volatile('qwen3.6'),
    fallbackAfterErrors: volatile(5),
    reviewProvider: volatile('qwen'),
    reviewModel: volatile('qwen3.8-max'),
  })
  assert.deepEqual(cfg, {
    enabled: false,
    stepsBetweenReviews: 3,
    intercept: false,
    maxDeltaMessages: 0,
    maxNoteChars: 1200,
    reviewMaxTokens: 256,
    jevGate: false,
    gateSkipClear: true,
    fallbackProvider: 'hy3',
    fallbackModel: 'qwen3.6',
    fallbackAfterErrors: 5,
    reviewProvider: 'qwen',
    reviewModel: 'qwen3.8-max',
  })
})

test('a volatile reference holding undefined still falls back', () => {
  // `.default()` runs inside the schema, but a `set` of an empty value can leave
  // the reference holding undefined; that must not become 0 or NaN.
  const cfg = resolveConfig({ stepsBetweenReviews: { get: () => undefined } })
  assert.equal(cfg.stepsBetweenReviews, 6)
})

test('the exported schema declares every field volatile', () => {
  // The settings service skips namespaces with no volatile field, so losing one
  // silently removes the row's configure form from the Plugins page.
  // An object schema keeps its fields under `dict`, each already a Schema.
  const fields = ['enabled', 'stepsBetweenReviews', 'intercept', 'maxDeltaMessages', 'maxNoteChars', 'reviewMaxTokens']
  for (const field of fields) {
    assert.equal(ConfigSchema.dict[field].meta.volatile, true, `${field} is not volatile`)
  }
})

// ── emission guard ───────────────────────────────────────────────────────────

test('guard drops empty and content-free replies', () => {
  const g = new EmissionGuard()
  g.beginReview()
  assert.equal(g.accept(note('   ')), false)
  assert.equal(g.accept(note('Nothing to add')), false)
  assert.equal(g.accept(note('LGTM.')), false)
  assert.equal(g.accept(note('no issues!')), false)
})

test('guard admits one note per review', () => {
  const g = new EmissionGuard()
  g.beginReview()
  assert.equal(g.accept(note('you are guessing the flag exists')), true)
  assert.equal(g.accept(note('a second, different problem')), false)
  g.beginReview()
  assert.equal(g.accept(note('a second, different problem')), true)
})

test('guard suppresses equal-or-lower repeats but admits escalation', () => {
  const g = new EmissionGuard()
  g.beginReview()
  assert.equal(g.accept(note('same problem')), true)
  g.beginReview()
  assert.equal(g.accept(note('same problem')), false, 'identical repeat suppressed')
  g.beginReview()
  assert.equal(g.accept(note('Same problem!')), false, 'normalized repeat suppressed')
  g.beginReview()
  assert.equal(g.accept(note('same problem', 'blocker')), true, 'escalation admitted')
})

// ── transcript observer ──────────────────────────────────────────────────────

function harness(options) {
  const deltas = []
  const rewrites = []
  const steps = []
  const t = new SessionTranscript({
    stepsBetweenReviews: 6,
    maxDeltaMessages: 60,
    onDelta: (sessionId, delta) => deltas.push([sessionId, delta]),
    onRewrite: (sessionId) => rewrites.push(sessionId),
    onStepEnd: (sessionId, turn, step) => steps.push([sessionId, turn, step]),
    ...options,
  })
  return { t, deltas, rewrites, steps }
}

const stepEnd = (turn, step) => ({ type: 'step/end', seq: step, data: { turn, step } })

test('transcript reviews every N steps and renders roles', () => {
  const { t, deltas, steps } = harness({ stepsBetweenReviews: 2 })
  t.handleEvent(sid, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'fix the build' }], source: { kind: 'user' } },
  })
  t.handleEvent(sid, stepEnd(1, 1))
  assert.equal(deltas.length, 0, 'one step is not enough')
  t.handleEvent(sid, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' }] } },
  })
  t.handleEvent(sid, {
    type: 'tool/result',
    data: { message: { content: [{ type: 'text', text: 'ok' }], toolCallId: 'c1' } },
  })
  t.handleEvent(sid, stepEnd(1, 2))

  assert.equal(steps.length, 2)
  assert.equal(deltas.length, 1)
  const [sessionId, delta] = deltas[0]
  assert.equal(sessionId, sid)
  assert.equal(delta.steps, 2)
  assert.match(delta.markdown, /\*\*user:\*\* fix the build/)
  assert.match(delta.markdown, /\*\*agent:\*\*.*\[calls pwsh/)
  assert.match(delta.markdown, /\[tool result\] ok/)
})

test('transcript excludes its own injections and resets the counter', () => {
  const { t, deltas, steps } = harness({ stepsBetweenReviews: 2 })
  t.handleEvent(sid, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '[supervisor:concern] stop guessing' }], source: { kind: 'supervisor', form: 'notice', summary: 'stop guessing' } },
  })
  t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: 'real work' }], source: { kind: 'user' } } })
  t.handleEvent(sid, stepEnd(1, 1))
  t.handleEvent(sid, stepEnd(1, 2))
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0][1].markdown, '**user:** real work')
  assert.equal(deltas[0][1].steps, 2)

  t.handleEvent(sid, stepEnd(1, 3))
  t.handleEvent(sid, stepEnd(1, 4))
  assert.equal(deltas.length, 1, 'nothing new: the review is skipped, not sent empty')
  assert.equal(steps.length, 4, 'the counter still runs through a skipped flush')

  t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: 'more work' }], source: { kind: 'user' } } })
  t.handleEvent(sid, stepEnd(1, 5))
  t.handleEvent(sid, stepEnd(1, 6))
  assert.equal(deltas.length, 2, 'the next review fires on its own cadence')
  assert.equal(deltas[1][1].markdown, '**user:** more work')
  assert.equal(deltas[1][1].steps, 2)
})

test('a surface rewrite clears the buffer and reports onRewrite', () => {
  const { t, deltas, rewrites } = harness({ stepsBetweenReviews: 2 })
  t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: 'pre-compaction' }], source: { kind: 'user' } } })
  t.handleEvent(sid, stepEnd(1, 1))
  t.handleEvent(sid, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'summary of everything' }], source: { kind: 'user' } },
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 9 },
  })
  assert.deepEqual(rewrites, [sid])
  t.handleEvent(sid, stepEnd(2, 1))
  t.handleEvent(sid, stepEnd(2, 2))
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0][1].markdown, '**user:** summary of everything')
  assert.equal(deltas[0][1].steps, 2, 'step counter reset by the rewrite')
})

test('maxDeltaMessages keeps the newest and marks the omission', () => {
  const { t, deltas } = harness({ stepsBetweenReviews: 2, maxDeltaMessages: 2 })
  for (let i = 1; i <= 5; i += 1) {
    t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: `line ${i}` }], source: { kind: 'user' } } })
  }
  t.handleEvent(sid, stepEnd(1, 1))
  t.handleEvent(sid, stepEnd(1, 2))
  const markdown = deltas[0][1].markdown
  assert.match(markdown, /^… <earlier messages omitted>/)
  assert.match(markdown, /line 4/)
  assert.match(markdown, /line 5/)
  assert.doesNotMatch(markdown, /line 2/)
})

test('live setters retune the cadence without losing the buffer', () => {
  // The Plugins page writes volatile config; the observer must follow without
  // dropping the messages already collected for the next review.
  const { t, deltas } = harness({ stepsBetweenReviews: 4 })
  t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: 'earlier work' }], source: { kind: 'user' } } })
  t.handleEvent(sid, stepEnd(1, 1))
  t.handleEvent(sid, stepEnd(1, 2))
  assert.equal(deltas.length, 0)

  t.setStepsBetweenReviews(1)
  t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: 'later work' }], source: { kind: 'user' } } })
  t.handleEvent(sid, stepEnd(1, 3))
  assert.equal(deltas.length, 1, 'the retuned cadence fires on the very next step')
  assert.match(deltas[0][1].markdown, /earlier work/, 'retuning does not discard pending work')
  assert.match(deltas[0][1].markdown, /later work/)

  t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: 'third' }], source: { kind: 'user' } } })
  t.handleEvent(sid, stepEnd(1, 4))
  assert.equal(deltas.length, 2)
  assert.doesNotMatch(deltas[1][1].markdown, /earlier work|later work/, 'each review carries only new work')
})

test('setMaxDeltaMessages applies to the next flush', () => {
  const { t, deltas } = harness({ stepsBetweenReviews: 1 })
  for (let i = 1; i <= 4; i += 1) {
    t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: `line ${i}` }], source: { kind: 'user' } } })
  }
  t.setMaxDeltaMessages(1)
  t.handleEvent(sid, stepEnd(1, 1))
  const markdown = deltas[0][1].markdown
  assert.match(markdown, /^… <earlier messages omitted>/)
  assert.match(markdown, /line 4/)
  assert.doesNotMatch(markdown, /line 3/)
})

// ── reviewer ─────────────────────────────────────────────────────────────────

function reviewer(llm, options = {}) {
  const notes = []
  const states = []
  const warnings = []
  const outcomes = []
  const r = new Reviewer({
    llm,
    systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
    maxTokens: 768,
    maxNoteChars: 600,
    callTimeoutMs: 5000,
    onNote: (n) => notes.push(n),
    onStateChange: (s) => states.push(s),
    onOutcome: (o) => outcomes.push(o),
    logger: { debug() {}, warn(...args) { warnings.push(args.join(' ')) } },
    ...options,
  })
  r.setRoute({ provider: 'p', model: 'm' })
  return { r, notes, states, warnings, outcomes }
}

const delta = (markdown) => ({ markdown, steps: 6 })

test('reviewer parses a bare JSON frame and emits the note', async () => {
  const llm = fakeLlm([['{"note": "you asserted the flag exists without checking", "severity": "concern"}']])
  const { r, notes } = reviewer(llm)
  r.enqueue(delta('**user:** add --force'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].severity, 'concern')
  assert.match(notes[0].note, /without checking/)
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'p')
  assert.equal(llm.calls[0].model, 'm')
  assert.equal(llm.calls[0].purpose, undefined, 'an ordinary request leaves purpose unset')
  assert.equal(llm.calls[0].messages[0].role, 'user')
  assert.equal(llm.calls[0].messages[0].source, undefined)
  // The contract rides in the *user* turn: measured against live routes, the top
  // level `system` field was ignored (qwen answered in prose and hallucinated a
  // file) and a `system` role message burned a reasoning model's whole token
  // budget on hidden thinking. Inlining is the only channel that held everywhere.
  assert.equal(llm.calls[0].system, undefined, 'no top-level system field')
  assert.equal(llm.calls[0].messages.length, 1, 'a single user turn')
  const text = llm.calls[0].messages[0].content[0].text
  assert.ok(text.startsWith(SUPERVISOR_SYSTEM_PROMPT), 'the contract precedes the transcript')
  assert.match(text, /add --force/, 'the transcript follows it')
})

test('reviewer tolerates prose and fences around the frame', async () => {
  const llm = fakeLlm([['Sure!\n```json\n{"note":"off task: the user asked for tests","severity":"blocker"}\n```\nDone.']])
  const { r, notes } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].severity, 'blocker')
})

test('reviewer downgrades a missing or unknown severity', async () => {
  const llm = fakeLlm([['{"note":"mild"}'], ['{"note":"weird","severity":"nit"}']])
  const { r, notes } = reviewer(llm)
  r.enqueue(delta('a'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  r.enqueue(delta('b'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(notes.map((n) => n.severity), ['concern', 'concern'])
})

test('reviewer drops a silent review without emitting', async () => {
  const llm = fakeLlm([['{"note": "Nothing to add"}']])
  const { r, notes } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(notes.length, 0)
  assert.equal(r.state, 'idle')
})

test('reviewer retries a contract-breaking reply once, then drops it', async () => {
  const llm = fakeLlm([['I think it looks fine overall.'], ['still not a JSON frame']])
  const { r, notes, outcomes } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(notes.length, 0)
  assert.equal(llm.calls.length, 2, 'a contract breach gets exactly one second chance')
  assert.deepEqual(outcomes, ['unparseable'])
  assert.equal(r.state, 'idle')
})

// ── review outcomes ──────────────────────────────────────────────────────────
// `reviews` alone cannot distinguish a working reviewer from a broken one, so
// every finished call reports exactly one outcome. These pin the mapping.

test('outcomes: a delivered note reports "note"', async () => {
  const llm = fakeLlm([['{"note":"guessing at the flag","severity":"concern"}']])
  const { r, notes, outcomes } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(outcomes, ['note'])
  assert.equal(notes.length, 1)
})

test('outcomes: "Nothing to add" reports "silent", not "unparseable"', async () => {
  const llm = fakeLlm([['{"note":"Nothing to add"}']])
  const { r, outcomes, notes } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(outcomes, ['silent'])
  assert.equal(notes.length, 0)
})

test('outcomes: an empty note field is unparseable, not silent', async () => {
  const llm = fakeLlm([['{"note":"   "}'], ['{"note":"   "}']])
  const { r, outcomes, warnings } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(outcomes, ['unparseable'])
  assert.equal(warnings.length, 2, 'the breach and the failed retry are both warned')
})

test('outcomes: prose instead of JSON reports "unparseable" and warns', async () => {
  const llm = fakeLlm([['Everything looks good to me here.'], ['Also fine, honestly.']])
  const { r, outcomes, warnings } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(outcomes, ['unparseable'])
  assert.match(warnings[0], /asking once more/)
  assert.match(warnings[1], /not the JSON frame/)
  assert.equal(llm.calls.length, 2, 'one retry, then drop')
})

test('outcomes: a suppressed duplicate reports "suppressed"', async () => {
  const llm = fakeLlm([
    ['{"note":"you are guessing the key exists","severity":"concern"}'],
    ['{"note":"you are guessing the key exists","severity":"concern"}'],
  ])
  const { r, notes, outcomes } = reviewer(llm)
  r.enqueue(delta('a'))
  await new Promise((resolve) => setTimeout(resolve, 25))
  r.enqueue(delta('b'))
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(notes.length, 1, 'the repeat is not delivered twice')
  assert.deepEqual(outcomes, ['note', 'suppressed'])
})

test('outcomes: an escalation past a prior severity is delivered, not suppressed', async () => {
  const llm = fakeLlm([
    ['{"note":"still guessing","severity":"concern"}'],
    ['{"note":"still guessing","severity":"blocker"}'],
  ])
  const { r, notes, outcomes } = reviewer(llm)
  r.enqueue(delta('a'))
  await new Promise((resolve) => setTimeout(resolve, 25))
  r.enqueue(delta('b'))
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(notes.length, 2)
  assert.deepEqual(notes.map((n) => n.severity), ['concern', 'blocker'])
  assert.deepEqual(outcomes, ['note', 'note'])
})

test('outcomes: exhausted transient retries report "error" once', async () => {
  const llm = fakeLlm([new Error('socket hang up'), new Error('socket hang up')])
  const { r, outcomes, warnings } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 1200)) // retry backoff is 500ms
  assert.deepEqual(outcomes, ['error'])
  assert.equal(warnings.length, 1, 'only the final drop is warned about')
  assert.equal(llm.calls.length, 2)
})

test('outcomes: quota and permanent failures report their own kind', async () => {
  const quota = fakeLlm([Object.assign(new Error('rate limit exceeded'), { code: '429' })])
  const quotaRun = reviewer(quota)
  quotaRun.r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(quotaRun.outcomes, ['quota'])
  assert.equal(quotaRun.r.state, 'quota_exhausted')

  const dead = fakeLlm([Object.assign(new Error('model not found'), { code: 'invalid_request_error' })])
  const deadRun = reviewer(dead)
  deadRun.r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(deadRun.outcomes, ['halted'])
  assert.equal(deadRun.r.state, 'halted')
})

test('outcomes: state.recordReview keeps reviews and outcomes in agreement', async () => {
  const state = new SupervisorState()
  const llm = fakeLlm([['{"note":"Nothing to add"}'], ['{"note":"guessing","severity":"concern"}']])
  const { r } = reviewer(llm, {
    onOutcome: (outcome) => state.recordReview('s1', outcome),
  })
  r.enqueue(delta('a'))
  await new Promise((resolve) => setTimeout(resolve, 25))
  r.enqueue(delta('b'))
  await new Promise((resolve) => setTimeout(resolve, 25))

  const totals = state.totals()
  assert.equal(totals.reviews, 2)
  assert.equal(totals.notes, 1)
  assert.equal(totals.unhealthy, 0)
  assert.deepEqual(totals.outcomes, { silent: 1, note: 1 })
  assert.equal(
    Object.values(totals.outcomes).reduce((sum, n) => sum + n, 0),
    totals.reviews,
    'outcomes must sum to reviews',
  )
})

test('outcomes: an unhealthy reviewer is visible in totals', async () => {
  const state = new SupervisorState()
  const llm = fakeLlm([['I think this is fine'], ['still prose'], ['prose again'], ['prose forever']])
  const { r } = reviewer(llm, { onOutcome: (o, reply, reason) => state.recordReview('s1', o, reply, reason) })
  r.enqueue(delta('a'))
  await new Promise((resolve) => setTimeout(resolve, 25))
  r.enqueue(delta('b'))
  await new Promise((resolve) => setTimeout(resolve, 25))

  const totals = state.totals()
  assert.equal(totals.reviews, 2)
  assert.equal(totals.notes, 0)
  assert.equal(totals.unhealthy, 2, 'a reviewer that understands nothing must not look healthy')
  assert.deepEqual(totals.parseFails, { no_frame: 2 }, 'one entry per finished review, split by final parse exit')
  assert.equal(
    state.snapshot().sessions[0].badReply,
    'prose forever',
    'the newest unreadable reply is kept, because ctx.logger never reaches disk here',
  )
})

test('outcomes: an empty reply is unparseable and says so', async () => {
  // A reasoning model can burn the whole budget on hidden thinking and emit no
  // text at all; that must read as "reviewer dead", not as silence.
  const state = new SupervisorState()
  const llm = fakeLlm([[], []])
  const { r, warnings } = reviewer(llm, { onOutcome: (o, reply) => state.recordReview('s1', o, reply) })
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(state.totals().unhealthy, 1)
  assert.match(state.snapshot().sessions[0].badReply, /^<empty reply, finish=stop>$/)
  assert.match(warnings[1], /not the JSON frame/)
})

test('reviewer retries a transient failure once, then drops', async () => {
  const llm = fakeLlm([new Error('socket hang up'), ['{"note":"still guessing","severity":"concern"}']])
  const { r, notes } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(llm.calls.length, 2)
  assert.equal(notes.length, 1)
  assert.equal(r.state, 'idle')
})

test('reviewer halts on quota and stops reviewing', async () => {
  const llm = fakeLlm([Object.assign(new Error('rate limit exceeded'), { code: '429' })])
  const { r, notes, states, warnings } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(r.state, 'quota_exhausted')
  assert.equal(notes.length, 0)
  assert.ok(states.includes('quota_exhausted'))
  assert.ok(warnings.some((w) => /quota/i.test(w)))
  const before = llm.calls.length
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(llm.calls.length, before, 'no further model calls once paused')
})

test('reviewer halts permanently on an invalid request', async () => {
  const llm = fakeLlm([Object.assign(new Error('model not found'), { code: 'invalid_request_error' })])
  const { r } = reviewer(llm)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(r.state, 'halted')
  assert.equal(llm.calls.length, 1, 'a permanent failure is not retried')
})

test('reviewer with no route never calls the model', async () => {
  const llm = fakeLlm([])
  const { r } = reviewer(llm)
  r.setRoute(undefined)
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(llm.calls.length, 0)
  assert.equal(r.state, 'no_route')
})

test('reviewer merges a backlog down to the newest work', async () => {
  const llm = fakeLlm([['{"note":"first"}'], ['{"note":"second"}']])
  const { r, notes } = reviewer(llm)
  for (let i = 0; i < 5; i += 1) r.enqueue(delta(`chunk ${i}`))
  await new Promise((resolve) => setTimeout(resolve, 60))
  // The first delta starts a review before anything can coalesce; the four that
  // pile up behind it collapse into one call carrying only the newest work.
  assert.equal(llm.calls.length, 2, 'the backlog collapses instead of growing')
  const texts = llm.calls.map((call) => call.messages[0].content[0].text)
  assert.match(texts[0], /chunk 0/)
  assert.match(texts[1], /chunk 4/)
  assert.doesNotMatch(texts[1], /chunk 1|chunk 2|chunk 3/)
  assert.equal(notes.length, 2)
})

test('truncates an over-long note', async () => {
  const llm = fakeLlm([[`{"note":"${'x'.repeat(900)}","severity":"concern"}`]])
  const { r, notes } = reviewer(llm, { maxNoteChars: 100 })
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(notes.length, 1)
  assert.ok(notes[0].note.length <= 102)
  assert.ok(notes[0].note.endsWith('…'))
})

test('setBudgets retunes the reviewer in place', async () => {
  // Volatile config changes must not rebuild the reviewer: a rebuild would drop
  // whatever is already queued behind an in-flight call.
  const first = 'a'.repeat(900)
  const second = 'b'.repeat(900)
  const llm = fakeLlm([
    [`{"note":"${first}","severity":"concern"}`],
    [`{"note":"${second}","severity":"concern"}`],
  ])
  const { r, notes } = reviewer(llm, { maxNoteChars: 600 })
  r.enqueue(delta('first'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(llm.calls[0].maxTokens, 768)

  r.setBudgets(256, 100)
  r.enqueue(delta('second'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(llm.calls[1].maxTokens, 256, 'the new token budget reaches the next call')
  assert.ok(notes[0].note.length > 100, 'the first note used the old cap')
  assert.ok(notes[1].note.length <= 102, 'the second note used the new cap')
  assert.ok(notes[1].note.endsWith('…'))
})

test('dispose aborts and stops emitting', async () => {
  const llm = fakeLlm([['{"note":"late"}']])
  const { r, notes } = reviewer(llm)
  r.dispose()
  r.enqueue(delta('...'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(llm.calls.length, 0)
  assert.equal(notes.length, 0)
  assert.equal(r.state, 'disposed')
})

// ── fallback route ──────────────────────────────────────────────────────────

test('a failing review route switches to the fallback after enough consecutive errors', async () => {
  const boom = () => new Error('connection refused')
  const llm = fakeLlm([boom(), boom(), boom(), boom(), boom(), boom(), [JSON.stringify({ note: 'Nothing to add' })]])
  const fallbacks = []
  const { r, outcomes } = reviewer(llm, {
    getFallback: () => ({ provider: 'fb', model: 'fm', afterErrors: 3 }),
    onFallback: (route) => fallbacks.push(route),
  })
  for (let i = 0; i < 4; i += 1) {
    r.enqueue(delta(`**agent:** work ${i}`))
    await new Promise((resolve) => setTimeout(resolve, 1250))
  }
  assert.equal(llm.calls.length, 7, 'three failed reviews (2 calls each) plus one on the fallback')
  assert.deepEqual(llm.calls.slice(0, 6).map((c) => c.provider), ['p', 'p', 'p', 'p', 'p', 'p'])
  assert.equal(llm.calls[6].provider, 'fb', 'the fourth review rides the fallback')
  assert.equal(llm.calls[6].model, 'fm')
  assert.deepEqual(outcomes, ['error', 'error', 'error', 'silent'])
  assert.deepEqual(fallbacks, [{ provider: 'fb', model: 'fm' }], 'the switch is announced exactly once')
})

test('a fresh main-route capture returns the reviewer to the session route', async () => {
  const boom = () => new Error('connection refused')
  const llm = fakeLlm([boom(), boom(), boom(), boom(), boom(), boom(), [JSON.stringify({ note: 'Nothing to add' })], [JSON.stringify({ note: 'Nothing to add' })]])
  const { r } = reviewer(llm, { getFallback: () => ({ provider: 'fb', model: 'fm', afterErrors: 3 }) })
  for (let i = 0; i < 3; i += 1) {
    r.enqueue(delta(`**agent:** work ${i}`))
    await new Promise((resolve) => setTimeout(resolve, 1250))
  }
  r.enqueue(delta('**agent:** on the fallback'))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(llm.calls[6].provider, 'fb')
  r.setRoute({ provider: 'p2', model: 'm2' })
  r.enqueue(delta('**agent:** route moved on'))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(llm.calls[7].provider, 'p2', 'the updated main route wins again')
})

test('without a configured fallback the failing route just keeps erroring', async () => {
  const boom = () => new Error('connection refused')
  const llm = fakeLlm([boom(), boom(), boom(), boom()])
  const fallbacks = []
  const { r, outcomes } = reviewer(llm, { onFallback: (route) => fallbacks.push(route) })
  for (let i = 0; i < 2; i += 1) {
    r.enqueue(delta(`**agent:** work ${i}`))
    await new Promise((resolve) => setTimeout(resolve, 1250))
  }
  assert.deepEqual(outcomes, ['error', 'error'])
  assert.deepEqual(fallbacks, [], 'nothing to switch to, nothing announced')
  assert.deepEqual(llm.calls.map((c) => c.provider), ['p', 'p', 'p', 'p'])
})

test('a fallback-less session that keeps failing reports itself blind, once', async () => {
  const boom = () => new Error('connection refused')
  const llm = fakeLlm([boom(), boom(), boom(), boom(), boom(), boom(), boom()])
  const blinds = []
  const { r, outcomes } = reviewer(llm, { onBlind: (info) => blinds.push(info) })
  for (let i = 0; i < 4; i += 1) {
    r.enqueue(delta(`**agent:** work ${i}`))
    await new Promise((resolve) => setTimeout(resolve, 1250))
  }
  assert.deepEqual(outcomes, ['error', 'error', 'error', 'error'])
  assert.deepEqual(blinds, [{ errors: 3, route: { provider: 'p', model: 'm' } }], 'one warning per episode, at the threshold')
  // A healthy review clears the episode: the next outage warns again.
  r.setRoute({ provider: 'p', model: 'm' })
})

test('a configured fallback suppresses the blind warning', async () => {
  const boom = () => new Error('connection refused')
  const llm = fakeLlm([boom(), boom(), boom(), boom(), boom(), boom(), 'ok'])
  const blinds = []
  const { r } = reviewer(llm, {
    getFallback: () => ({ provider: 'fb', model: 'fm', afterErrors: 3 }),
    onBlind: (info) => blinds.push(info),
  })
  for (let i = 0; i < 3; i += 1) {
    r.enqueue(delta(`**agent:** work ${i}`))
    await new Promise((resolve) => setTimeout(resolve, 1250))
  }
  assert.deepEqual(blinds, [], 'the fallback owns the outage; silence is correct')
})

test('a session with no captured route still reviews on the fallback', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })]])
  const fallbacks = []
  const notes = []
  const r = new Reviewer({
    llm,
    systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
    maxTokens: 768,
    maxNoteChars: 600,
    callTimeoutMs: 5000,
    onNote: (n) => notes.push(n),
    onOutcome: () => {},
    logger: { debug() {}, warn() {} },
    getFallback: () => ({ provider: 'fb', model: 'fm', afterErrors: 3 }),
    onFallback: (route) => fallbacks.push(route),
  })
  r.enqueue(delta('**agent:** work with no route captured'))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(llm.calls.length, 1, 'route capture failing must not blind the session')
  assert.equal(llm.calls[0].provider, 'fb')
  assert.deepEqual(fallbacks, [{ provider: 'fb', model: 'fm' }])
})

test('resolveConfig carries the fallback route fields', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.fallbackProvider, '')
  assert.equal(cfg.fallbackModel, '')
  assert.equal(cfg.fallbackAfterErrors, 3)
  const set = resolveConfig({ fallbackProvider: ' hy3 ', fallbackModel: 'qwen3.6', fallbackAfterErrors: 7 })
  assert.equal(set.fallbackProvider, 'hy3', 'trimmed')
  assert.equal(set.fallbackModel, 'qwen3.6')
  assert.equal(set.fallbackAfterErrors, 7)
})

// ── delivery: the intercept path ─────────────────────────────────────────────

test('raise arms a gate instead of interrupting', () => {
  const agent = fakeAgent()
  const { d, warnings } = delivery(true, agent)
  const channel = d.raise(sid, note('you are guessing the API shape'))
  assert.equal(channel, 'armed')
  assert.equal(d.isArmed(sid), true)
  assert.equal(agent.steered.length, 0, 'arming says nothing to the agent yet')
  assert.equal(agent.injected.length, 0)
  assert.equal(warnings.length, 0)
})

test('without interception, raise delivers straight away', () => {
  const agent = fakeAgent()
  const { d } = delivery(false, agent)
  assert.equal(d.raise(sid, note('heads up')), 'delivered')
  assert.equal(d.isArmed(sid), false)
  assert.equal(agent.injected.length, 1, 'a running agent gets context, not a wake')
  assert.equal(agent.steered.length, 0)
})

test('an idle agent is injected into, never woken (silent by default)', () => {
  const agent = fakeAgent()
  agent.status = 'idle'
  const { d } = delivery(false, agent)
  d.raise(sid, note('heads up'))
  assert.equal(agent.injected.length, 1, 'the note waits for the next wake instead of opening a turn')
  assert.equal(agent.steered.length, 0)
})

test('the delivered message is tagged, prefixed and summarised', () => {
  const agent = fakeAgent()
  const { d } = delivery(false, agent)
  d.raise(sid, note('you are guessing the flag exists', 'blocker'))
  const message = agent.injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'supervisor')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.content[0].text, '[supervisor:blocker] you are guessing the flag exists')
  assert.equal(message.source.summary, 'blocker] you are guessing the flag exists')
})

test('a missing agent drops the note without throwing', () => {
  const { d, warnings } = delivery(false, undefined)
  assert.equal(d.raise(sid, note('nobody home')), 'dropped')
  assert.equal(warnings.length, 1)
})

test('interceptStep re-queues the claimed batch in order and resumes', async () => {
  const agent = fakeAgent()
  const { d } = delivery(true, agent)
  d.raise(sid, note('you are guessing the flag exists'))
  assert.equal(d.isArmed(sid), true)

  const claimed = [{ id: 'u1', text: 'first' }, { id: 'u2', text: 'second' }, { id: 'u3', text: 'third' }]
  const held = d.interceptStep(sid, deliveryAgent(agent), claimed)
  assert.equal(held, true, 'the caller must reject this step')

  // The user's own messages come back, in order, ahead of the note.
  assert.deepEqual(agent.inbox.map((m) => m.id ?? m.content[0].text), ['u1', 'u2', 'u3'])
  assert.equal(d.isArmed(sid), false, 'the gate is consumed by the hold')

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(agent.steered.length, 1, 'resume wakes the driver with the note attached')
  assert.match(agent.steered[0].content[0].text, /^\[supervisor:concern\] you are guessing/)
  assert.deepEqual(agent.inbox.map((m) => m.id ?? m.content[0].text), ['u1', 'u2', 'u3', '[supervisor:concern] you are guessing the flag exists'])
})

test('the second pass is not held again', async () => {
  const agent = fakeAgent()
  const { d } = delivery(true, agent)
  d.raise(sid, note('problem A'))
  assert.equal(d.interceptStep(sid, deliveryAgent(agent), [{ id: 'u1' }]), true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  agent.inbox.length = 0
  agent.steered.length = 0
  // Same session, next step: nothing is armed, so the step passes.
  assert.equal(d.interceptStep(sid, deliveryAgent(agent), [{ id: 'u2' }]), false)
  assert.equal(agent.inbox.length, 0)
})

test('a second note while armed delivers instead of double-arming', () => {
  const agent = fakeAgent()
  const { d } = delivery(true, agent)
  assert.equal(d.raise(sid, note('problem A')), 'armed')
  assert.equal(d.raise(sid, note('problem B')), 'delivered')
  assert.equal(agent.injected.length, 1)
})

test('interceptStep is a no-op when nothing is armed', () => {
  const agent = fakeAgent()
  const { d } = delivery(true, agent)
  assert.equal(d.interceptStep(sid, deliveryAgent(agent), [{ id: 'u1' }]), false)
  assert.equal(agent.inbox.length, 0)
})

test('re-queue failure does not lose the note', async () => {
  const agent = fakeAgent()
  const { d, warnings } = delivery(true, agent)
  d.raise(sid, note('problem A'))
  const broken = deliveryAgent(agent)
  broken.inbox.prepend = () => {
    throw new Error('message "u1" is already pending')
  }
  assert.equal(d.interceptStep(sid, broken, [{ id: 'u1' }]), true)
  assert.ok(warnings.some((args) => /re-queue skipped/.test(args[0])))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(agent.steered.length, 1, 'the note still reaches the agent')
})

test('unregister clears the armed gate', () => {
  const agent = fakeAgent()
  const { d } = delivery(true, agent)
  d.raise(sid, note('problem A'))
  d.unregisterAgent(sid)
  assert.equal(d.isArmed(sid), false)
})

test('setIntercept(false) releases any held gate', () => {
  const agent = fakeAgent()
  const { d } = delivery(true, agent)
  d.raise(sid, note('problem A'))
  d.setIntercept(false)
  assert.equal(d.isArmed(sid), false)
  assert.equal(d.raise(sid, note('problem B')), 'delivered')
})

// ── end to end: counting → review → arm → hold ───────────────────────────────

test('six steps produce one armed gate that holds the next step', async () => {
  const llm = fakeLlm([['{"note":"you are asserting the config key exists without reading it","severity":"concern"}']])
  const notes = []
  const agent = fakeAgent()
  const d = new SupervisorDelivery({
    intercept: true,
    lookupAgent: () => deliveryAgent(agent),
    createUserMessage: (input) => ({ role: 'user', ...input }),
    boundContextSummary: (s) => s,
    logger: { debug() {}, warn() {} },
  })
  const r = new Reviewer({
    llm,
    systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
    maxTokens: 768,
    maxNoteChars: 600,
    onNote: (n) => {
      notes.push(n)
      d.raise(sid, n)
    },
    logger: { debug() {}, warn() {} },
  })
  r.setRoute({ provider: 'p', model: 'm' })
  const t = new SessionTranscript({
    stepsBetweenReviews: 6,
    maxDeltaMessages: 60,
    onDelta: (sessionId, delta_) => r.enqueue(delta_),
    onRewrite: () => {},
    onStepEnd: () => {},
  })

  t.handleEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: 'add a retry flag' }], source: { kind: 'user' } } })
  for (let step = 1; step <= 5; step += 1) t.handleEvent(sid, stepEnd(1, step))
  assert.equal(llm.calls.length, 0, 'five steps: no review yet')
  t.handleEvent(sid, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the flag is --retry, I am sure' }] } } })
  t.handleEvent(sid, stepEnd(1, 6))

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(llm.calls.length, 1)
  assert.equal(notes.length, 1)
  assert.equal(d.isArmed(sid), true, 'the note is held for the next step boundary')
  assert.equal(agent.steered.length + agent.injected.length, 0, 'nothing said to the agent yet')

  assert.equal(d.interceptStep(sid, deliveryAgent(agent), [{ id: 'u9', text: 'queued work' }]), true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(agent.steered.length, 1, 'the hold is followed by the note')
  assert.deepEqual(inboxIds(agent), ['u9', '[supervisor:concern] you are asserting the config key exists without reading it'])
})

// ── jev gate ─────────────────────────────────────────────────────────────────

test('the problem list is seven categories and each becomes one gate question', () => {
  assert.equal(PROBLEM_CATEGORIES.length, 7)
  const questions = buildGateQuestions()
  assert.equal(questions.length, 7)
  for (const q of questions) {
    assert.equal(q.type, 'noul')
    assert.ok(q.instructions.length > 10)
    assert.ok(q.criteria.true && q.criteria.false)
  }
  assert.deepEqual(questions.map((q) => q.name), PROBLEM_CATEGORIES.map((c) => c.id))
})

test('parseGateReply reads noul lines and ignores everything else', () => {
  const probs = parseGateReply(
    [
      'read_selectively: noul=0.9841',
      'unsaid_finding: noul=0.02',
      '[usage] in=140 out=1 model=SemIf',
      'some prose line',
    ].join('\n'),
  )
  assert.equal(probs.get('read_selectively'), 0.9841)
  assert.equal(probs.get('unsaid_finding'), 0.02)
  assert.equal(probs.size, 2)
})

test('a gate with no tools is unavailable and never throws', async () => {
  const gate = new JevGate(undefined)
  assert.equal(gate.available, false)
  const verdict = await gate.screen('**agent:** hello', new AbortController().signal)
  assert.equal(verdict.kind, 'unavailable')
})

test('the gate flags only categories at or above the threshold', async () => {
  const warnings = []
  const gate = new JevGate(
    {
      get: (n) => (n === JEV_TOOL_NAME ? {} : undefined),
      execute: async () => ({
        value: 'read_selectively: noul=0.9\nscope_creep: noul=0.6\nblind_tuning: noul=0.59\n',
      }),
    },
    { debug() {}, warn(...args) { warnings.push(args.join(' ')) } },
  )
  assert.equal(gate.available, true)
  const verdict = await gate.screen('**agent:** x', new AbortController().signal)
  assert.equal(verdict.kind, 'hits')
  assert.deepEqual(verdict.hits.map((h) => h.id), ['read_selectively', 'scope_creep'])
  assert.equal(warnings.length, 0)
})

test('a failing or erroring gate degrades to unavailable', async () => {
  const warnings = []
  const logger = { debug() {}, warn(...args) { warnings.push(args.join(' ')) } }
  const errored = new JevGate(
    { get: () => ({}), execute: async () => ({ isError: true, error: { message: 'boom' } }) },
    logger,
  )
  assert.equal((await errored.screen('x', new AbortController().signal)).kind, 'unavailable')
  const threw = new JevGate(
    { get: () => ({}), execute: async () => { throw new Error('transport down') } },
    logger,
  )
  assert.equal((await threw.screen('x', new AbortController().signal)).kind, 'unavailable')
  assert.match(warnings[0], /jev gate failed/)
})

test('a clear gate skips the model call only in the opt-in cost mode', async () => {
  const llm = fakeLlm([])
  const { r, notes, outcomes } = reviewer(llm, {
    gate: { screen: async () => ({ kind: 'clear' }) },
    gateSkipClear: true,
  })
  r.enqueue(delta('**agent:** all verified'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(llm.calls.length, 0, 'the gate saved the review call')
  assert.equal(notes.length, 0)
  assert.deepEqual(outcomes, ['gated_clear'])
  assert.equal(r.state, 'idle')
})

test('a clear gate still pays for the review by default (accuracy first)', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })]])
  const stats = []
  const { r, outcomes } = reviewer(llm, {
    gate: { screen: async () => ({ kind: 'clear' }) },
    onGateStat: (s) => stats.push(s),
  })
  r.enqueue(delta('**agent:** all verified'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(llm.calls.length, 1, 'skipping is opt-in; the default always reviews')
  assert.deepEqual(outcomes, ['silent'])
  assert.deepEqual(stats, ['cleared'])
})

test('a gate miss is measured: clear gate + note from the model = false_clear', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: '你在猜测文件存在', severity: 'concern' })]])
  const stats = []
  const { r, outcomes } = reviewer(llm, {
    gate: { screen: async () => ({ kind: 'clear' }) },
    onGateStat: (s) => stats.push(s),
  })
  r.enqueue(delta('**agent:** done'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(outcomes, ['note'])
  assert.deepEqual(stats, ['cleared', 'false_clear'], 'the miss is counted, not guessed')
})

test('gate hits ride into the review prompt as leads', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })]])
  const { r } = reviewer(llm, {
    gate: { screen: async () => ({ kind: 'hits', hits: [{ id: 'scope_creep', probability: 0.83 }] }) },
  })
  r.enqueue(delta('**agent:** also rewrote the layout'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(llm.calls.length, 1)
  const prompt = llm.calls[0].messages[0].content[0].text
  assert.match(prompt, /### Jev pre-screen/)
  assert.match(prompt, /scope_creep \(P=0\.83\)/)
  assert.match(prompt, /lead to verify/, 'a flag is a lead, never a finding')
})

test('the hit side of the gate is measured: flagged, and confirmed when the review agrees', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: '你在悄悄扩大范围', severity: 'concern' })]])
  const stats = []
  const { r, outcomes } = reviewer(llm, {
    gate: { screen: async () => ({ kind: 'hits', hits: [{ id: 'scope_creep', probability: 0.83 }] }) },
    onGateStat: (s) => stats.push(s),
  })
  r.enqueue(delta('**agent:** also rewrote the layout'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(outcomes, ['note'])
  assert.deepEqual(stats, ['flagged', 'flag_confirmed'], 'a note on a flagged delta confirms the lead')
})

test('a flagged gate whose review stays silent is flagged but not confirmed', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })]])
  const stats = []
  const { r, outcomes } = reviewer(llm, {
    gate: { screen: async () => ({ kind: 'hits', hits: [{ id: 'blind_tuning', probability: 0.7 }] }) },
    onGateStat: (s) => stats.push(s),
  })
  r.enqueue(delta('**agent:** tuned it again'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(outcomes, ['silent'])
  assert.deepEqual(stats, ['flagged'], 'the review vetoed the lead; co-occurrence, not attribution')
})

test('a flagged gate still pays for the model call', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: '你在猜测', severity: 'concern' })]])
  const { r, notes, outcomes } = reviewer(llm, {
    gate: { screen: async () => ({ kind: 'hits', hits: [{ id: 'ungrounded_claim', probability: 0.9 }] }) },
  })
  r.enqueue(delta('**agent:** the flag is --retry, I am sure'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(llm.calls.length, 1)
  assert.equal(notes.length, 1)
  assert.deepEqual(outcomes, ['note'])
})

test('an unavailable gate falls through to the plain review', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })]])
  const { r, outcomes } = reviewer(llm, {
    gate: { screen: async () => ({ kind: 'unavailable', reason: 'no jev' }) },
  })
  r.enqueue(delta('**agent:** hello'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(llm.calls.length, 1)
  assert.deepEqual(outcomes, ['silent'])
})

test('a throwing gate falls through to the plain review with a warning', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })]])
  const { r, outcomes, warnings } = reviewer(llm, {
    gate: { screen: async () => { throw new Error('gate exploded') } },
  })
  r.enqueue(delta('**agent:** hello'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(llm.calls.length, 1, 'a broken gate must never block a review')
  assert.deepEqual(outcomes, ['silent'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /review gate failed/)
})

test('resolveConfig carries the jevGate switch', () => {
  assert.equal(resolveConfig(undefined).jevGate, true)
  assert.equal(resolveConfig({ jevGate: false }).jevGate, false)
  assert.equal(resolveConfig({ jevGate: 'yes' }).jevGate, true)
})

test('resolveConfig carries the gateSkipClear switch, off by default', () => {
  assert.equal(resolveConfig(undefined).gateSkipClear, false, 'accuracy first: skipping is opt-in')
  assert.equal(resolveConfig({ gateSkipClear: true }).gateSkipClear, true)
  assert.equal(resolveConfig({ gateSkipClear: 'yes' }).gateSkipClear, false)
})

test('counters survive a restart through the persisted state file', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(mkdtempSync(join(tmpdir(), 'dsv-state-')), 'state.json')
  try {
    const first = new SupervisorState(path)
    first.bump('s1', 'steps', 7)
    first.recordReview('s1', 'note')
    first.recordGate('s1', 'cleared')
    first.recordGate('s1', 'false_clear')
    first.setSession('s1', { route: { provider: 'qwen', model: 'qwen3-max' } })
    first.recordReview('s1', 'unparseable', 'prose forever', 'no_frame')
    first.flush()

    const second = new SupervisorState(path)
    second.bump('s1', 'steps', 1)
    const totals = second.totals()
    assert.equal(totals.steps, 8, 'restored steps plus new ones')
    assert.equal(totals.reviews, 2)
    assert.deepEqual(totals.gate, { cleared: 1, falseClears: 1, flagged: 0, confirmed: 0 })
    assert.deepEqual(totals.parseFails, { no_frame: 1 })
    assert.deepEqual(
      totals.parseFailsByRoute,
      { 'qwen/qwen3-max': { no_frame: 1 } },
      'parse fails are attributed to the route the session reviewed on',
    )
  } finally {
    rmSync(path, { force: true })
  }
})

test('a corrupt state file degrades to zero instead of crashing', async () => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const path = join(mkdtempSync(join(tmpdir(), 'dsv-state-')), 'state.json')
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ not json')
    const state = new SupervisorState(path)
    assert.equal(state.totals().steps, 0)
  } finally {
    rmSync(path, { force: true })
  }
})
