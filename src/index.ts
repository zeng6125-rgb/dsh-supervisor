// dsh-supervisor — a bystander reviewer attached to the main agent.
//
// Every ~6 committed steps it reads the recent transcript delta in the
// background and speaks up only about the problem classes in
// `PROBLEM_CATEGORIES` (selective reading, withheld findings, ungrounded
// claims, untried impossibility, scope creep, blind tuning, done-then-changed).
// A note never interrupts the work it reviews: it queues and rides a step the
// agent is already entering (a later turn by default, the next step with the
// opt-in `intercept`), rate-limited by a per-session cooldown, and is surfaced
// to the user on the status dot. Advisory only — it never authorises anything
// and never decides for the agent.

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'

import { Config, resolveConfig } from './config.js'
import { SupervisorDelivery } from './delivery.js'
import { REVIEWER_CLAIM_KEY, SUPERVISOR_PLUGIN_ID, SUPERVISOR_SOURCE_KIND, type SupervisorNote } from './kinds.js'
import { SUPERVISOR_SYSTEM_PROMPT } from './prompts.js'
import { Reviewer, type ReviewerRoute } from './review.js'
import { SupervisorState } from './state.js'
import { SessionTranscript } from './transcript.js'

export { Config }
export const name = SUPERVISOR_PLUGIN_ID
export const inject = ['agents', 'llm', 'webServer', 'configEditor', 'attachments']

const API = '/dsh-supervisor/api'

type Logger = { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }

type HostContext = Context & {
  agents?: { get(id: never): unknown; list(): unknown[] }
  llm?: unknown
  webServer?: {
    register(entry: { kind: string; path: string; handler: (req: any, res: any) => any }): () => void
  }
}

/**
 * The dsh event map is contributed by packages we deliberately do not depend on
 * (`dsh-agent`, `dsh-session`), so `ctx.on` does not know these keys here. Every
 * listener still opts out of scope filtering with `{ global: true }`.
 */
type AnyOn = (event: string, listener: (...args: any[]) => any, options?: unknown) => () => void

/**
 * Provider adapters live on the application root's LlmRuntime; a plugin context
 * can sit in an isolated scope whose local `llm` has none, which surfaces as a
 * bare NO_ADAPTER. Always reach for the root service.
 */
function appRootLlm(ctx: HostContext): any {
  return (ctx.root as any)?.get?.('llm') ?? ctx.llm
}

/** Cheap value fingerprint, used to tell our own config write from everyone else's. */
function signature(cfg: Config): string {
  return [
    cfg.enabled,
    cfg.intercept,
    cfg.stepsBetweenReviews,
    cfg.maxDeltaMessages,
    cfg.maxNoteChars,
    cfg.reviewMaxTokens,
    cfg.fallbackProvider,
    cfg.fallbackModel,
    cfg.fallbackAfterErrors,
    cfg.reviewProvider,
    cfg.reviewModel,
    // Both are read live off `cfg`, so a change to either is only real once
    // this function notices it and the plugin swaps the reference.
    cfg.attachIntervalSec,
    cfg.wakeGuard,
  ].join('\u0000')
}

/**
 * The settings page's own write path. The `settings.section` seat does not
 * hand out the host form, so the card talks to our API and we persist through
 * the configEditor service — the same Loader path the host form uses, which
 * means `loader/volatile-update` fires and `cfg` re-resolves live.
 */
const CONFIG_VALUE_KINDS: Record<string, 'boolean' | 'number' | 'string' | 'route'> = {
  enabled: 'boolean',
  stepsBetweenReviews: 'number',
  intercept: 'boolean',
  maxDeltaMessages: 'number',
  maxNoteChars: 'number',
  reviewMaxTokens: 'number',
  // Combined route pickers: one dropdown writes provider+model atomically.
  reviewRoute: 'route',
  fallbackRoute: 'route',
  fallbackAfterErrors: 'number',
  attachIntervalSec: 'number',
  wakeGuard: 'boolean',
}

/** Route keys a combined picker writes, and the config fields they map to. */
const ROUTE_KEYS: Record<string, [string, string]> = {
  reviewRoute: ['reviewProvider', 'reviewModel'],
  fallbackRoute: ['fallbackProvider', 'fallbackModel'],
}

function findOwnEntry(editor: any): any {
  const entries = editor?.entries?.() ?? []
  return entries.find((e: any) => e && (e.name === SUPERVISOR_PLUGIN_ID || e.id === SUPERVISOR_PLUGIN_ID || String(e?.id ?? '').includes(SUPERVISOR_PLUGIN_ID)))
}

async function writeConfigValue(ctx0: any, key: unknown, value: unknown): Promise<{ ok: boolean; error?: string }> {
  if (typeof key !== 'string' || !(key in CONFIG_VALUE_KINDS)) return { ok: false, error: `未知的配置键：${String(key)}` }
  const kind = CONFIG_VALUE_KINDS[key]
  let coerced: unknown = value
  if (kind === 'boolean') coerced = value === true || value === 'true' || value === 1
  else if (kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return { ok: false, error: `${key} 需要一个有限数字` }
    coerced = n
  } else coerced = value === undefined || value === null ? '' : String(value)
  const editor = (ctx0 ?? ({} as any)).configEditor
  if (!editor?.edit) return { ok: false, error: 'configEditor 服务不可用' }
  const entry = findOwnEntry(editor)
  if (!entry) return { ok: false, error: 'Config 服务里没有本插件的条目' }
  await editor.edit(entry, (current: Record<string, unknown>) => {
    const next = { ...(current ?? {}) }
    if (kind === 'route') {
      // `provider\u0000model` → the two raw fields; empty side unsets it.
      const [providerField, modelField] = ROUTE_KEYS[key]
      const [provider, model] = String(coerced).split('\u0000')
      if (provider) next[providerField] = provider
      else delete next[providerField]
      if (model) next[modelField] = model
      else delete next[modelField]
      return next
    }
    if (coerced === '') delete next[key]
    else next[key] = coerced
    return next
  })
  return { ok: true }
}

export function apply(ctx0: Context, config?: unknown): void {
  const ctx = ctx0 as HostContext
  // Volatile fields resolve to live references on this very object, and the
  // loader updates them in place on a volatile-only write — so re-resolving the
  // same `config` later yields fresh values. Never read `ctx.config`: cordis has
  // no such property, and the proxy throws `cannot get property "config"
  // without inject`, which kills the fiber before any listener is attached.
  const readConfig = (): unknown => config
  let cfg = resolveConfig(readConfig())
  const log = ctx.logger('supervisor') as Logger
  const on = ctx.on as unknown as AnyOn

  // The host composes several fibers per profile; only one may review, or every
  // step would be reviewed N times. The first to apply claims the role.
  const globals = globalThis as Record<string, unknown>
  if (globals[REVIEWER_CLAIM_KEY] === true) {
    log.debug('another fiber already reviews; standing down')
    return
  }
  globals[REVIEWER_CLAIM_KEY] = true
  ctx.effect(() => () => {
    delete globals[REVIEWER_CLAIM_KEY]
  }, 'dsh-supervisor: reviewer claim')

  if (!cfg.enabled) log.debug('disabled by configuration; watching nothing')

  const llm = appRootLlm(ctx)
  // Counters survive host restarts (the ledger is the only calibration evidence);
  // alerts deliberately do not. The instance is a process-wide singleton: a
  // hot reload leaves the previous fiber's web-server routes registered, and
  // those stale closures would otherwise serve a *different*, frozen state
  // object than the live fiber writes — two ledgers for one plugin.
  const STATE_KEY = 'dsh-supervisor:state'
  const existing = globals[STATE_KEY]
  const state =
    existing instanceof SupervisorState ? existing : new SupervisorState(join(homedir(), '.dsh', 'dsh-supervisor', 'state.json'), log)
  if (!existing) globals[STATE_KEY] = state
  ctx.effect(() => () => {
    state.flush()
  }, 'dsh-supervisor: persist counters on teardown')
  const reviewers = new Map<string, Reviewer>()
  /** provider/model actually in use per session, captured from `agent/request`. */
  const routes = new Map<string, ReviewerRoute>()
  /** Image notes already folded into the transcript, per session (one request
   *  per step repeats the whole history, so notes must be de-duplicated). */
  const imageNotes = new Map<string, Set<string>>()
  const pendingImages = new Map<string, Array<{ mediaType: string; data: string }>>()
  /** Live agents by session id: the goal service and the wake both need the
   *  real instance, not an id (`goals.get` rejects anything else). */
  const liveAgents = new Map<string, any>()
  /** Notes that earned a wake, held until the agent actually reaches idle. */
  const awakePending = new Map<string, SupervisorNote>()
  /** Last wake per session, so the cooldown bounds the pushes too. */
  const lastWake = new Map<string, number>()

  const delivery = new SupervisorDelivery({
    intercept: cfg.intercept,
    // Live-read: a settings-page change hot-swaps the window without remount.
    attachCooldownMs: () => cfg.attachIntervalSec * 1000,
    createUserMessage,
    boundContextSummary,
    logger: log,
  })

  const syncPending = (sessionId: string): void => {
    state.setSession(sessionId, { pending: delivery.hasPending(sessionId) })
  }

  /**
   * The session's open goal, read through the service without declaring it in
   * `inject`: the goal packages are optional in a profile and a hard
   * dependency would make the supervisor unmountable without them.
   */
  const objectiveOf = (
    sessionId: string,
  ): { objective: string; roundsStarted: number; maxGoalRounds: number } | undefined => {
    try {
      const goals = (ctx0 as any).get?.('goals')
      const agent = liveAgents.get(sessionId)
      if (!goals?.get || !agent) return undefined
      const view = goals.get(agent)
      // A closed goal is the goal owner's verdict, not a work item: only an
      // active one may be held against the agent.
      if (!view || view.phase !== 'active' || typeof view.objective !== 'string') return undefined
      return {
        objective: view.objective,
        roundsStarted: Number(view.roundsStarted ?? 0),
        maxGoalRounds: Number(view.maxGoalRounds ?? 0),
      }
    } catch {
      return undefined // a disarmed or absent goal service is not an error
    }
  }

  /** Reviewers are created lazily; the route may not be known yet. */
  function ensureReviewer(sessionId: string): Reviewer | undefined {
    if (!cfg.enabled) return undefined
    const existing = reviewers.get(sessionId)
    if (existing) return existing

    const reviewer = new Reviewer({
      llm: llm as never,
      systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
      maxTokens: cfg.reviewMaxTokens,
      maxNoteChars: cfg.maxNoteChars,
      // Blind-spot fix: a dead review route no longer silences the session —
      // after enough consecutive failures the reviewer rides this route.
      getFallback: () =>
        cfg.fallbackProvider && cfg.fallbackModel
          ? { provider: cfg.fallbackProvider, model: cfg.fallbackModel, afterErrors: cfg.fallbackAfterErrors }
          : undefined,
      // Optional pin: when both are set, every session reviews on this model
      // instead of following its own route. Live-read so the settings page can
      // pin or unpin mid-session.
      getReviewRoute: () =>
        cfg.reviewProvider && cfg.reviewModel
          ? { provider: cfg.reviewProvider, model: cfg.reviewModel }
          : undefined,
      // Drained per call: each review looks at the images captured since the
      // previous one, then they clear (a re-request replays the whole history
      // and would otherwise re-send the same screenshot every step).
      getImages: () => {
        const queue = pendingImages.get(sessionId)
        if (!queue || queue.length === 0) return []
        const drained = queue.splice(0, queue.length)
        return drained.slice(0, 4) // cap: a review with a wall of images is noise
      },
      onFallback: (route) => {
        state.setSession(sessionId, { fallback: route })
        log.warn('reviewer switched to the fallback route', { sessionId, ...route })
      },
      // Blindness must be visible, not just a counter: a panel-only alert
      // (never injected into the agent — this is plugin health, not agent
      // behaviour) naming the dead route and the config that would fix it.
      onBlind: (info) => {
        const where = info.route ? `${info.route.provider}/${info.route.model}` : '未捕获到路由'
        state.recordAlert(
          sessionId,
          {
            severity: 'blocker',
            note: `审查路由（${where}）连续 ${info.errors} 次失败且未配置回退路由，本会话的审查已失明。请在插件设置里配置 fallbackProvider / fallbackModel，或检查该路由是否存活。`,
          },
          'panel',
        )
        log.warn('review session blind: route failing with no fallback configured', { sessionId, ...info })
      },
      getObjective: () => objectiveOf(sessionId),
      onNote: (note: SupervisorNote, category?: string) => {
        // The note waits (see SupervisorDelivery) for a step the agent is
        // already entering: no inbox turn of its own, no held step.
        const channel = delivery.raise(sessionId, note)
        state.recordAlert(sessionId, note, channel)
        syncPending(sessionId)
        // Only "you stopped with work left" earns a push, and only while the
        // agent is still busy: if it goes idle, the status listener below
        // speaks; if it keeps working, the note rides a step as usual.
        if (category === 'stopped_early' && cfg.wakeGuard) awakePending.set(sessionId, note)
        log.debug('note raised', { sessionId, severity: note.severity, channel, category })
      },
      onStateChange: (next) => {
        state.setSession(sessionId, { reviewer: next })
      },
      // Count finished reviews, not initiations, and record *how* each ended —
      // otherwise `reviews: 5` cannot be told apart from five silent failures.
      onOutcome: (outcome, reply, reason, failure) => {
        state.recordReview(sessionId, outcome, reply, reason, failure)
        if (outcome !== 'silent' && outcome !== 'note' && outcome !== 'suppressed') {
          log.warn('review ended unhealthy', { sessionId, outcome, fingerprint: failure?.fingerprint })
        }
      },
      logger: log,
    })
    reviewers.set(sessionId, reviewer)
    reviewer.setRoute(routes.get(sessionId))
    state.setSession(sessionId, { reviewer: reviewer.state, route: routes.get(sessionId) })
    return reviewer
  }

  const transcript = new SessionTranscript({
    stepsBetweenReviews: cfg.stepsBetweenReviews,
    maxDeltaMessages: cfg.maxDeltaMessages,
    onStepEnd: (sessionId) => {
      state.bump(sessionId, 'steps')
    },
    onRewrite: (sessionId) => {
      // Compaction rewrote the surface: buffered transcript and any queued
      // notes both refer to history that no longer exists.
      delivery.clear(sessionId)
      syncPending(sessionId)
      reviewers.get(sessionId)?.resetGuard()
    },
    // A completed turn flushes the pending delta now — waiting for the step
    // threshold would push the review into the NEXT turn (the old source of the
    // "extra supervision turn"). The note then queues normally: by default it
    // attaches on the first step of a LATER turn, so the finished summary is
    // never answered as its own turn, and no inbox message is ever injected.
    onTurnEnd: (sessionId, _turn, reason) => {
      if (reason !== 'completed') return
      transcript.flushNow(sessionId)
    },
    onDelta: (sessionId, delta) => {
      ensureReviewer(sessionId)?.enqueue(delta)
    },
    logger: log,
  })

  function disposeSession(sessionId: string): void {
    transcript.disposeSession(sessionId)
    reviewers.get(sessionId)?.dispose()
    reviewers.delete(sessionId)
    routes.delete(sessionId)
    imageNotes.delete(sessionId)
    pendingImages.delete(sessionId)
    liveAgents.delete(sessionId)
    awakePending.delete(sessionId)
    lastWake.delete(sessionId)
    delivery.clear(sessionId)
    state.dropSession(sessionId)
  }

  // ── live configuration ───────────────────────────────────────────────────────
  // Every field is `volatile`, so the loader writes the new value into the live
  // reference and emits `loader/volatile-update` instead of remounting us — the
  // plugin has to pick the change up itself or the settings page would look
  // broken while the fibre keeps running on the old numbers.
  on(
    'loader/volatile-update',
    () => {
      try {
        const next = resolveConfig(readConfig())
        const before = cfg
        if (signature(before) === signature(next)) return // somebody else's config write
        cfg = next
        delivery.setIntercept(next.intercept)
        transcript.setStepsBetweenReviews(next.stepsBetweenReviews)
        transcript.setMaxDeltaMessages(next.maxDeltaMessages)
        for (const reviewer of reviewers.values()) {
          reviewer.setBudgets(next.reviewMaxTokens, next.maxNoteChars)
        }
        if (before.enabled !== next.enabled) {
          if (!next.enabled) {
            // Stopping must not leave queued notes or paused reviewers behind.
            for (const sessionId of [...reviewers.keys()]) {
              delivery.clear(sessionId)
              syncPending(sessionId)
            }
            log.debug('disabled by configuration; watching nothing')
          } else {
            log.debug('enabled by configuration')
          }
        }
        log.debug('configuration updated', { ...next })
      } catch (error: any) {
        log.warn('configuration update failed; keeping previous values', { error: String(error?.message ?? error) })
      }
    },
    // `global` because the loader emits this on a *derived* context carrying a
    // `Context.filter`, and a scoped listener never gets admitted (observed: the
    // hook fires with another entry's fiber as owner, so our values stay stale).
    // Global fires on every entry's config write, hence the signature guard above.
    { global: true },
  )

  // ── session feed ────────────────────────────────────────────────────────────
  // `global` because the dsh scope carrier tags these emissions and a plugin
  // composed into an isolated scope would otherwise be filtered out.
  on(
    'session/event',
    (session: any, event: any) => {
      try {
        transcript.handleEvent(String(session?.id), event)
      } catch (error) {
        log.warn('transcript update failed', { error: String(error) })
      }
    },
    { global: true } as never,
  )

  // ── agent lifecycle ─────────────────────────────────────────────────────────
  // `agent/created` is serial and a throw fails agent creation, so swallow.
  on(
    'agent/created',
    ({ agent }: any) => {
      try {
        const sessionId = String(agent?.id)
        if (sessionId && sessionId !== 'undefined') {
          liveAgents.set(sessionId, agent)
          ensureReviewer(sessionId)
          const route = routes.get(sessionId)
          if (route) state.setSession(sessionId, { route })
        }
      } catch (error) {
        log.warn('agent registration failed', { error: String(error) })
      }
      return undefined
    },
    { global: true } as never,
  )

  for (const event of ['agent/disposed', 'session/disposed'] as const) {
    on(
      event,
      (payload: any) => {
        const id = String(payload?.agent?.id ?? payload?.id ?? '')
        if (id) disposeSession(id)
      },
      { global: true } as never,
    )
  }

  // ── push a stopped-but-unfinished session back to work ──────────────────────
  // The note path can only ride a step the agent already enters; a session that
  // went idle needs a turn of its own, which is exactly what `followup` opens.
  // Three things bound it: only a `stopped_early` note, only at whole-agent
  // idle, and only once per attach cooldown — a review that flags the same stop
  // twice cannot loop the conversation.
  on(
    'agent/status',
    ({ agent, status }: any) => {
      try {
        if (status !== 'idle') return
        const sessionId = String(agent?.id)
        if (!sessionId || sessionId === 'undefined') return
        if (!cfg.wakeGuard || !cfg.enabled) return
        const note = awakePending.get(sessionId)
        if (!note) return
        awakePending.delete(sessionId)
        const cooldown = cfg.attachIntervalSec * 1000
        if (cooldown > 0) {
          const last = lastWake.get(sessionId)
          if (last !== undefined && Date.now() - last < cooldown) return
        }
        // A goal that is no longer active belongs to its owner's verdict: the
        // host already decided the work is done, paused, or blocked.
        const goals = (ctx0 as any).get?.('goals')
        try {
          const view = goals?.get?.(agent)
          if (view && view.phase !== 'active') return
        } catch {
          // Goal service asleep or the agent is no longer live: not a reason
          // to skip a push the transcript itself earned.
        }
        // The note must not also ride a step later: hand it over here.
        delivery.takePending(sessionId)
        delivery.stampWake(sessionId)
        syncPending(sessionId)
        lastWake.set(sessionId, Date.now())
        const wakeText =
          `[supervisor:${note.severity}] ${note.note}` +
          '\n\n你停了下来，但上面的问题说明还有没做完的部分——请继续把它做完。如果确实已经完成，说明理由再停。'
        agent.followup?.(
          createUserMessage({
            content: [{ type: 'text', text: wakeText }],
            source: {
              kind: SUPERVISOR_SOURCE_KIND,
              form: 'notice',
              summary: boundContextSummary(wakeText.slice('[supervisor:'.length)),
            },
          }),
        )
        log.debug('agent pushed back to work after stopping early', { sessionId })
      } catch (error) {
        // Advisory only: a failed push must never break the session.
        log.warn('wake after idle failed', { error: String(error) })
      }
    },
    { global: true } as never,
  )

  // ── route capture ───────────────────────────────────────────────────────────
  // No provider/model configuration of our own: the reviewer uses whatever the
  // session is already running, which is also the point ("the watcher is the
  // same model"). The waterfall must hand the config back untouched.
  on(
    'agent/request',
    async ({ agent }: any, next: () => Promise<any>) => {
      const callConfig = await next()
      try {
        const provider = callConfig?.provider
        const model = callConfig?.model
        const sessionId = String(agent?.id)
        if (sessionId && typeof provider === 'string' && typeof model === 'string') {
          const previous = routes.get(sessionId)
          if (!previous || previous.provider !== provider || previous.model !== model) {
            const route = { provider, model }
            routes.set(sessionId, route)
            ensureReviewer(sessionId)?.setRoute(route)
            // The ledger records the route the review actually ran on: the
            // override when pinned, otherwise the session's own model. That
            // keeps parseFailsByRoute attributed to the reviewing model.
            const pinned = cfg.reviewProvider && cfg.reviewModel
            state.setSession(sessionId, { route: pinned ? { provider: cfg.reviewProvider, model: cfg.reviewModel } : route })
          }
        }
        // GUI-attached images never enter the session/event feed (measured on
        // the live stream), so the reviewer would read a screenshot-bearing
        // turn as the user saying nothing. Scan the request's user turns for
        // image parts: note them into the transcript delta AND keep the bytes
        // so the review call can actually look at them.
        if (sessionId && Array.isArray(callConfig?.messages)) {
          const notes: string[] = []
          const attachments = (ctx0 as HostContext)?.attachments
          for (const message of callConfig.messages) {
            if (message?.role !== 'user' || !Array.isArray(message?.content)) continue
            for (const part of message.content) {
              if (part?.type === 'image') {
                const label = part.name || part.mediaType || 'screenshot'
                notes.push(`[image: ${label}]`)
                // Wire form carries base64 inline; admitted form carries a
                // durable ref whose bytes need one service call.
                if (typeof part.data === 'string' && part.data) {
                  pendingImages.get(sessionId)?.push({ mediaType: part.mediaType || 'image/png', data: part.data })
                } else if (part.attachment && attachments?.readImage) {
                  void attachments
                    .readImage(part.attachment)
                    .then((stored: any) => {
                      if (stored?.data) {
                        pendingImages.get(sessionId)?.push({
                          mediaType: part.mediaType || 'image/png',
                          data: Buffer.from(stored.data).toString('base64'),
                        })
                      }
                    })
                    .catch(() => { /* a missing image must not fail the capture */ })
                }
              } else if (part?.type === 'file') {
                notes.push(`[file: ${part.attachment?.name || 'attachment'}]`)
              }
            }
          }
          if (notes.length > 0) {
            // One request per turn step repeats the whole history: only note
            // images the reviewer has not already been told about.
            const seen = imageNotes.get(sessionId) ?? new Set<string>()
            const fresh = notes.filter((n) => !seen.has(n))
            for (const n of fresh) seen.add(n)
            imageNotes.set(sessionId, seen)
            if (fresh.length > 0) transcript.noteLines(sessionId, fresh)
          }
        }
      } catch (error) {
        log.warn('route capture failed', { error: String(error) })
      }
      return callConfig
    },
    { global: true } as never,
  )

  // ── attach advice to a step the agent is already entering ──────────────────
  on(
    'agent/pre-step',
    async ({ agent, turn }: any, next: () => Promise<any>) => {
      const decision = await next()
      if (!cfg.enabled) return decision
      if (decision?.kind === 'reject') return decision
      try {
        const sessionId = String(agent?.id)
        // Append any queued note to a step the agent is already entering,
        // spreading the decision so `startsRequestSeries` (and the provider's
        // prefix cache) survives. The old reject/re-queue/steer path discarded
        // it and restarted the request, and the inject path turned the note
        // into its own user turn — both defects the user reported.
        const withNote = delivery.attachToStep(
          sessionId,
          decision,
          Number(turn ?? 0),
          (notes) => {
            for (const note of notes) state.updateAlertChannel(sessionId, note, 'delivered')
            syncPending(sessionId)
            log.debug('note attached to a step', { sessionId, turn })
          },
          (notes) => {
            // Superseded while the cooldown held: park them on the panel —
            // visible and ackable, but never interrupting the conversation.
            for (const note of notes) state.updateAlertChannel(sessionId, note, 'panel')
            syncPending(sessionId)
            log.debug('older queued notes parked on the panel', { sessionId, turn, count: notes.length })
          },
        )
        return withNote
      } catch (error) {
        // Advisory only: a failed attach must never break the step.
        log.warn('note attach failed, step passes', { error: String(error) })
      }
      return decision
    },
    { global: true } as never,
  )

  // ── banner API ──────────────────────────────────────────────────────────────
  ctx.effect(
    () => {
      const unregister = ctx.webServer?.register({
        kind: 'prefix',
        path: API,
        handler: async (req: any, res: any) => {
          const url: string = req?.url || '/'
          const pathname = url.split('?')[0]
          const query = url.slice(pathname.length)
          // req.url may or may not carry the registered prefix; accept both.
          const sub = pathname.startsWith(API) ? pathname.slice(API.length) : pathname

          // POST /config — the settings page's write path (see writeConfigValue).
          if (sub === '/config' && req?.method === 'POST') {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => {
              void (async () => {
                try {
                  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { key?: unknown; value?: unknown }
                  const result = await writeConfigValue(ctx0, body.key, body.value)
                  res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                  res.end(JSON.stringify(result))
                } catch (error: any) {
                  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                  res.end(JSON.stringify({ ok: false, error: error?.message ?? 'internal error' }))
                }
              })()
            })
            return
          }

          let payload: unknown
          try {
            if (sub === '/state') {
              payload = {
                ok: true,
                enabled: cfg.enabled,
                intercept: cfg.intercept,
                stepsBetweenReviews: cfg.stepsBetweenReviews,
                totals: state.totals(),
                ...state.snapshot(),
              }
            } else if (sub === '/config') {
              // Current values for the settings page's own editor. Writability
              // is probed server-side: the configEditor service must exist and
              // know this plugin's entry.
              const editor = (ctx0 as any)?.configEditor
              const entry = findOwnEntry(editor)
              payload = {
                ok: true,
                writable: !!editor?.edit && !!entry,
                values: {
                  enabled: cfg.enabled,
                  stepsBetweenReviews: cfg.stepsBetweenReviews,
                  intercept: cfg.intercept,
                  maxDeltaMessages: cfg.maxDeltaMessages,
                  maxNoteChars: cfg.maxNoteChars,
                  reviewMaxTokens: cfg.reviewMaxTokens,
                  // Combined route pickers (`provider\u0000model`), the shape
                  // the settings page's single dropdowns read and write.
                  reviewRoute: cfg.reviewProvider + '\u0000' + cfg.reviewModel,
                  fallbackRoute: cfg.fallbackProvider + '\u0000' + cfg.fallbackModel,
                  fallbackAfterErrors: cfg.fallbackAfterErrors,
                  attachIntervalSec: cfg.attachIntervalSec,
                  wakeGuard: cfg.wakeGuard,
                },
              }
            } else if (sub === '/models') {
              // Provider/model directory for the settings page's review-model
              // picker, read from the live llm service inside the host (the
              // browser's own /api/modelCatalog needs credentials we never see).
              const llm = (ctx0 as any)?.llm
              const providers: Array<{ id: string; name: string }> = llm?.listProviders ? llm.listProviders() : []
              const models: Array<{ provider: string; id: string; name: string }> = []
              for (const p of providers) {
                try {
                  const list = (await llm.listModels(p.id)) as Array<{ id: string; name?: string }>
                  for (const m of list ?? []) models.push({ provider: p.id, id: m.id, name: m.name || m.id })
                } catch { /* a provider with no reachable catalog simply offers nothing */ }
              }
              payload = { ok: true, providers: providers.map((p) => ({ id: p.id, name: p.name || p.id })), models }
            } else if (sub === '/ack') {
              const id = /[?&]id=([^&]+)/.exec(query)?.[1]
              payload = { ok: true, acked: state.ack(id ? decodeURIComponent(id) : undefined) }
            } else if (sub === '/demo') {
              // Debug only: records a synthetic alert into our own state so the
              // banner can be seen without waiting for a real review to speak up.
              // Touches nothing else — no agent, no inbox, no model call.
              const held = /[?&]held=1/.test(query)
              const noteParam = /[?&]note=([^&]*)/.exec(query)?.[1]
              payload = {
                ok: true,
                alert: state.recordAlert(
                  'demo-session',
                  {
                    severity: /[?&]severity=blocker/.test(query) ? 'blocker' : 'concern',
                    note: noteParam ? decodeURIComponent(noteParam.replace(/\+/g, ' ')) : '演示提醒：检查状态圆点与展开面板，点「已读」关闭。',
                  },
                  held ? 'pending' : 'delivered',
                ),
              }
            } else {
              payload = {
                ok: true,
                service: name,
                endpoints: [
                  '/state — alerts + per-session reviewer state',
                  '/config — current settings values (GET) / set one value (POST {key, value})',
                  '/models — live provider/model directory for the settings pickers',
                  '/ack[?id=] — mark alert(s) read',
                  '/demo[?severity=blocker][&held=1][&note=…] — record a synthetic alert (UI check)',
                ],
              }
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(payload))
          } catch (error: any) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, error: error?.message ?? 'internal error' }))
          }
        },
      })
      return unregister ?? (() => {})
    },
    'dsh-supervisor: api',
  )
}
