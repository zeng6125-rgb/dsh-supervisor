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
import { SUPERVISOR_SYSTEM_PROMPT, PROBLEM_CATEGORIES } from '../lib/prompts.js'

const sid = 'session-test'

// ── helpers ──────────────────────────────────────────────────────────────────

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

function delivery(intercept = false, attachCooldownMs = 0, now = () => Date.now()) {
  const warnings = []
  const d = new SupervisorDelivery({
    intercept,
    attachCooldownMs: () => attachCooldownMs,
    now,
    createUserMessage: (input) => ({ role: 'user', ...input }),
    boundContextSummary: (summary) => summary,
    logger: { debug() {}, warn(...args) { warnings.push(args) } },
  })
  return { d, warnings }
}

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
    fallbackProvider: volatile('hy3'),
    fallbackModel: volatile('qwen3.6'),
    fallbackAfterErrors: volatile(5),
    reviewProvider: volatile('qwen'),
    reviewModel: volatile('qwen3.8-max'),
    attachIntervalSec: volatile(60),
    wakeGuard: volatile(false),
  })
  assert.deepEqual(cfg, {
    enabled: false,
    stepsBetweenReviews: 3,
    intercept: false,
    maxDeltaMessages: 0,
    maxNoteChars: 1200,
    reviewMaxTokens: 256,
    fallbackProvider: 'hy3',
    fallbackModel: 'qwen3.6',
    fallbackAfterErrors: 5,
    reviewProvider: 'qwen',
    reviewModel: 'qwen3.8-max',
    attachIntervalSec: 60,
    wakeGuard: false,
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
  const fields = ['enabled', 'stepsBetweenReviews', 'intercept', 'maxDeltaMessages', 'maxNoteChars', 'reviewMaxTokens', 'fallbackProvider', 'fallbackModel', 'fallbackAfterErrors', 'reviewProvider', 'reviewModel', 'attachIntervalSec', 'wakeGuard']
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

test('transcript reports turn ends with the host reason kind', () => {
  const turns = []
  const { t } = harness({
    stepsBetweenReviews: 1,
    onTurnEnd: (sessionId, turn, reason) => turns.push([sessionId, turn, reason]),
  })
  t.handleEvent(sid, stepEnd(1, 1))
  t.handleEvent(sid, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
  t.handleEvent(sid, stepEnd(2, 1))
  t.handleEvent(sid, { type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'legacy' } } } })
  assert.deepEqual(turns, [[sid, 1, 'completed'], [sid, 2, 'aborted']])
})

test('transcript notes request-side images the event feed never carries', () => {
  // Measured on the live stream: session/event user messages contain only text
  // parts — GUI-attached images travel in the model request alone. The
  // `agent/request` capture reports them through noteLines so the reviewer
  // learns the turn had a screenshot instead of reading it as silence.
  const { t, deltas } = harness({ stepsBetweenReviews: 1 })
  t.noteLines(sid, ['[image: screenshot.png]'])
  t.handleEvent(sid, stepEnd(1, 1))
  assert.equal(deltas.length, 1)
  assert.match(deltas[0][1].markdown, /\[image: screenshot\.png\]/, 'the note reaches the delta')
})

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

test('a note carries its category, which is what decides a wake', async () => {
  // The category is not decoration: `stopped_early` is the only class allowed
  // to push an idle agent back to work, so an unknown or missing id must not
  // be mistaken for it.
  const llm = fakeLlm([[JSON.stringify({ note: '还有两步没做完就停了', severity: 'concern', category: 'stopped_early' })]])
  const seen = []
  const { r, notes } = reviewer(llm, { onNote: (n, c) => { notes.push(n); seen.push(c) } })
  r.enqueue(delta('**agent:** done, I think'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(seen.length, 1)
  assert.equal(seen[0], 'stopped_early')
  assert.equal(r.state, 'idle')
})

test('an unknown category is dropped instead of trusted', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: '问题', severity: 'concern', category: 'invented_id' })]])
  const seen = []
  const { r } = reviewer(llm, { onNote: (n, c) => seen.push(c) })
  r.enqueue(delta('**agent:** x'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(seen.length, 1)
  assert.equal(seen[0], undefined, 'an id outside the closed set never reaches the wake decision')
})

test('an active goal rides into the review prompt as the objective', async () => {
  // "Is this finished?" is an opinion about prose until the target is stated.
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })]])
  const { r } = reviewer(llm, {
    getObjective: () => ({ objective: 'migrate the runner to eight arms', roundsStarted: 3, maxGoalRounds: 20 }),
  })
  r.enqueue(delta('**agent:** done'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const prompt = llm.calls[0].messages[0].content[0].text
  assert.match(prompt, /### Objective/)
  assert.match(prompt, /migrate the runner to eight arms/)
  assert.match(prompt, /round 3\/20/)
  assert.match(prompt, /the goal owner closes it, not you/, 'the reviewer never closes a goal')
})

test('no active goal means no objective block at all', async () => {
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })]])
  const { r } = reviewer(llm, { getObjective: () => undefined })
  r.enqueue(delta('**agent:** done'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.doesNotMatch(llm.calls[0].messages[0].content[0].text, /### Objective/)
})

test('taking the queue leaves nothing for a later step to attach', () => {
  // A wake speaks the note itself; the same reminder must not ride a step too.
  const { d } = delivery()
  d.raise(sid, note('A'))
  d.raise(sid, note('B'))
  assert.deepEqual(d.takePending(sid).map((n) => n.note), ['A', 'B'])
  assert.equal(d.hasPending(sid), false)
  const decision = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u1' }] }, 1)
  assert.equal(decision.messages.length, 1, 'nothing left to append')
})

test('the wake guard is on by default and can be turned off', () => {
  assert.equal(resolveConfig(undefined).wakeGuard, true)
  assert.equal(resolveConfig({ wakeGuard: false }).wakeGuard, false)
  // Only a real boolean is trusted; junk falls back to the default rather than
  // being read as truthy, which would silently re-arm the guard.
  assert.equal(resolveConfig({ wakeGuard: 'no' }).wakeGuard, true)
})

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

test('reviewer sends captured images with the review and drains them once', async () => {
  // The session/event feed carries no image blocks, so the host hands request
  // side images over through getImages; the review call must actually look at
  // them, and must not re-send them on the next review.
  const queue = [{ mediaType: 'image/png', data: 'aGVsbG8=' }]
  const llm = fakeLlm([[JSON.stringify({ note: 'Nothing to add' })], [JSON.stringify({ note: 'Nothing to add' })]])
  const { r } = reviewer(llm, { getImages: () => queue.splice(0, queue.length) })
  r.enqueue(delta('a'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  r.enqueue(delta('b'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[0].messages[0].content.length, 2, 'text + image')
  assert.deepEqual(
    { type: llm.calls[0].messages[0].content[1].type, mediaType: llm.calls[0].messages[0].content[1].mediaType },
    { type: 'image', mediaType: 'image/png' },
  )
  assert.match(llm.calls[0].messages[0].content[0].text, /附 1 张用户截图/)
  assert.equal(llm.calls[1].messages[0].content.length, 1, 'drained: the second review is text-only')
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

test('outcomes: failures are ledgered by fingerprint', async () => {
  // `error` alone could not tell a throttled route from a dead one; the
  // fingerprint splits them, so the next fix targets the kind that dominates.
  const state = new SupervisorState()
  state.recordReview('s1', 'error', undefined, undefined, { fingerprint: 'rate-limit' })
  state.recordReview('s1', 'error', undefined, undefined, { fingerprint: 'rate-limit' })
  state.recordReview('s1', 'error', undefined, undefined, { fingerprint: 'timeout' })
  assert.deepEqual(state.totals().errorKinds, { 'rate-limit': 2, timeout: 1 })
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

// ── delivery: queued notes ride a step the agent already enters ─────────────

test('raise queues the note without waking, injecting or holding anything', () => {
  const { d, warnings } = delivery()
  assert.equal(d.raise(sid, note('you are guessing the API shape')), 'pending')
  assert.equal(d.hasPending(sid), true)
  assert.equal(warnings.length, 0)
})

test('attach cooldown holds a second note inside the window', () => {
  // The rate limit that answers "why back-to-back supervision": with a 60s
  // cooldown, a note that matures one step after the last attach waits.
  let t = 0
  const { d } = delivery(false, 60_000, () => t)
  d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u1' }] }, 1)
  d.raise(sid, note('first'))
  t = 1000
  const first = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u2' }] }, 2)
  assert.equal(first.messages.length, 2, 'the first note rides turn 2')
  d.raise(sid, note('second'))
  t = 2000 // 1s later, inside the window
  const held = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u3' }] }, 3)
  assert.equal(held.messages.length, 1, 'the second note waits out the cooldown')
  assert.equal(d.hasPending(sid), true)
  t = 61_000 // window expired
  const late = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u4' }] }, 4)
  assert.equal(late.messages.length, 2, 'it rides a step once the cooldown matures')
})

test('a matured cooldown attaches the newest note and parks the older ones', () => {
  // Supervision is about the freshest read: older queued notes park on the
  // panel (visible, ackable) instead of all firing at once.
  let t = 0
  const attached = []
  const parked = []
  const { d } = delivery(false, 60_000, () => t)
  d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u1' }] }, 1)
  d.raise(sid, note('stale A'))
  d.raise(sid, note('stale B'))
  d.raise(sid, note('fresh C'))
  t = 61_000
  const decision = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u2' }] }, 2, (notes) => attached.push(...notes), (notes) => parked.push(...notes))
  assert.deepEqual(attached.map((n) => n.note), ['fresh C'], 'only the newest attaches')
  assert.deepEqual(parked.map((n) => n.note), ['stale A', 'stale B'], 'the rest park, in order')
  assert.equal(decision.messages.length, 2, 'one note appended')
  assert.equal(d.hasPending(sid), false, 'the queue drains')
})

test('cooldown 0 keeps the old attach-everything-in-order behaviour', () => {
  // The rate limit is opt-out: with 0 every queued note still rides the step.
  let t = 0
  const attached = []
  const { d } = delivery(true, 0, () => t)
  d.raise(sid, note('A'))
  d.raise(sid, note('B'))
  const decision = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u1' }] }, 1, (notes) => attached.push(...notes))
  assert.equal(decision.messages.length, 3)
  assert.deepEqual(attached.map((n) => n.note), ['A', 'B'])
})

test('the default attach interval is three minutes, and resolveConfig floors it at 0', () => {
  assert.equal(resolveConfig({}).attachIntervalSec, 180)
  assert.equal(resolveConfig({ attachIntervalSec: -5 }).attachIntervalSec, 0)
  assert.equal(resolveConfig({ attachIntervalSec: '60' }).attachIntervalSec, 60)
})

test('a note waits for a later turn: same-turn steps pass untouched, the next turn carries it', () => {
  const { d } = delivery()
  d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u1' }] }, 1) // turn 1 in flight
  d.raise(sid, note('heads up')) // anchored to turn 1
  const sameTurn = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u2' }] }, 1)
  assert.equal(sameTurn.messages.length, 1, 'in-flight work is not interrupted mid-turn')
  const nextTurn = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u3' }] }, 2)
  assert.equal(nextTurn.messages.length, 2, 'the user already asked for the next turn: it rides it')
  const message = nextTurn.messages[1]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'supervisor')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.content[0].text, '[supervisor:concern] heads up')
  assert.equal(message.source.summary, 'concern] heads up')
  assert.equal(d.hasPending(sid), false)
})

test('the attached decision keeps startsRequestSeries so the cached prefix survives', () => {
  const { d } = delivery()
  d.attachToStep(sid, { kind: 'enter', messages: [] }, 1)
  d.raise(sid, note('heads up'))
  const attached = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u2' }], startsRequestSeries: true }, 2)
  assert.equal(attached.kind, 'enter')
  assert.equal(attached.startsRequestSeries, true, 'the request series — and the provider prefix cache — survive the attach')
})

test('intercept attaches on the very next step, without stopping the work', () => {
  const { d } = delivery(true)
  d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u1' }] }, 1)
  d.raise(sid, note('urgent'))
  const attached = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u2' }] }, 1)
  assert.equal(attached.messages.length, 2, 'the note rides the next step of the same turn')
})

test('a reject decision is never rewritten; queued notes append in order', () => {
  const { d } = delivery(true)
  d.attachToStep(sid, { kind: 'enter', messages: [] }, 1)
  assert.equal(d.attachToStep(sid, { kind: 'reject' }, 2).kind, 'reject')
  d.raise(sid, note('a'))
  d.raise(sid, note('b'))
  const attached = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u1' }] }, 2)
  assert.deepEqual(
    attached.messages.map((m) => m.id ?? m.content[0].text),
    ['u1', '[supervisor:concern] a', '[supervisor:concern] b'],
  )
})

test('onAttached reports exactly the notes that rode the step', () => {
  const { d } = delivery(true)
  d.attachToStep(sid, { kind: 'enter', messages: [] }, 1)
  d.raise(sid, note('x'))
  const attached = []
  d.attachToStep(sid, { kind: 'enter', messages: [] }, 1, (notes) => attached.push(...notes))
  assert.equal(attached.length, 1)
  assert.equal(attached[0].note, 'x')
  // Nothing pending: the callback must not fire.
  d.attachToStep(sid, { kind: 'enter', messages: [] }, 2, () => assert.fail('nothing pending, nothing attached'))
})

test('clear forgets queued notes (compaction or teardown)', () => {
  const { d } = delivery()
  d.attachToStep(sid, { kind: 'enter', messages: [] }, 1)
  d.raise(sid, note('stale'))
  d.clear(sid)
  assert.equal(d.hasPending(sid), false)
  const passed = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u' }] }, 2)
  assert.equal(passed.messages.length, 1)
})

test('setIntercept flips the attach cadence without losing queued notes', () => {
  const { d } = delivery()
  d.attachToStep(sid, { kind: 'enter', messages: [] }, 3)
  d.raise(sid, note('later')) // anchored to turn 3: would wait for turn 4
  d.setIntercept(true)
  const attached = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u' }] }, 3)
  assert.equal(attached.messages.length, 2, 'with intercept on, the same turn carries it')
})

// ── end to end: counting → review → queue → attach ───────────────────────────

test('six steps produce one queued note that rides the next turn', async () => {
  const llm = fakeLlm([['{"note":"you are asserting the config key exists without reading it","severity":"concern"}']])
  const notes = []
  const { d } = delivery()
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
  for (let step = 1; step <= 5; step += 1) {
    // The real pre-step listener records every turn entering a step; without
    // this the note would anchor to turn 0 and fire on the first step.
    d.attachToStep(sid, { kind: 'enter', messages: [{ id: `u${step}` }] }, 1)
    t.handleEvent(sid, stepEnd(1, step))
  }
  assert.equal(llm.calls.length, 0, 'five steps: no review yet')
  t.handleEvent(sid, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the flag is --retry, I am sure' }] } } })
  d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u6' }] }, 1)
  t.handleEvent(sid, stepEnd(1, 6))

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(llm.calls.length, 1)
  assert.equal(notes.length, 1)
  // The agent enters step boundaries of its own turn (the pre-step listener
  // records them); the note must not ride THIS turn.
  d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u6' }] }, 1)
  assert.equal(d.hasPending(sid), true, 'the note waits for a later turn')
  const decision = d.attachToStep(sid, { kind: 'enter', messages: [{ id: 'u7' }] }, 2)
  assert.deepEqual(
    decision.messages.map((m) => m.id ?? m.content[0].text),
    ['u7', '[supervisor:concern] you are asserting the config key exists without reading it'],
  )
  assert.equal(d.hasPending(sid), false)
})

// ── problem categories ──────────────────────────────────────────────────────

test('the problem list is a closed set of eight categories', () => {
  // The reviewer may only speak about these; growing the list silently widens
  // what the supervisor is allowed to complain about. `stopped_early` is the
  // one that can wake an idle agent, so its id is load-bearing.
  assert.equal(PROBLEM_CATEGORIES.length, 8)
  assert.equal(new Set(PROBLEM_CATEGORIES.map((c) => c.id)).size, 8, 'ids are unique')
  assert.ok(PROBLEM_CATEGORIES.some((c) => c.id === 'stopped_early'))
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
    first.setSession('s1', { route: { provider: 'qwen', model: 'qwen3-max' } })
    first.recordReview('s1', 'unparseable', 'prose forever', 'no_frame')
    first.flush()

    const second = new SupervisorState(path)
    second.bump('s1', 'steps', 1)
    const totals = second.totals()
    assert.equal(totals.steps, 8, 'restored steps plus new ones')
    assert.equal(totals.reviews, 2)
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
