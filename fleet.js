import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Squad — cross-workspace worker sessions.
 *
 * DSH already knows how to create an ordinary Session against any `cwd` or
 * workspace, prompt it in `queue` or `steer` mode, cancel it, and read any
 * session log. What it does not have is a layer that names those sessions,
 * remembers who owns them, and turns "send it a task and tell me when it is
 * done" into a small set of tools.
 *
 * This plugin is that layer and nothing more. The worker's own durable log stays
 * the source of truth for anything it actually did; the roster is only a set of
 * named pointers plus the reports and escalations workers submitted.
 *
 * The roster IS persisted, because a process-local one proved actively harmful:
 * every `dsh` restart and every bundle patch reload (which disposes and re-applies
 * this plugin) silently emptied it, so a long unattended campaign lost its fleet
 * mid-flight. Records reload as `dormant` and are re-adopted on next use.
 */
const name = 'squad'

/**
 * Worker sessions carry a durable title of the form `squad:<name>`.
 *
 * Two jobs: it makes the fleet readable in the sidebar (otherwise every worker
 * looks alike), and it is a second, roster-independent record of identity. If
 * the state file is lost or the roster is rebuilt, `squad_spawn` finds the
 * existing session by this title and adopts it instead of creating a duplicate.
 * That duplicate-on-respawn behaviour is what produced 7 stray sessions per
 * project during the first campaign.
 */
const TITLE_PREFIX = 'squad:'

/** The durable title marking one worker's session. */
function titleFor(workerName) {
	return `${TITLE_PREFIX}${workerName}`
}

/** Roster state lives beside the rest of the harness's user data. */
function resolveStatePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
	return join(home, 'squad', 'roster.json')
}

const inject = [
	'tools',
	'agents',
	'sessionController',
	'sessionQuery',
	'workspaceRegistry'
]

/** Schemastery config for the squad roster and the worker model route. */
const Config = z.object({
	/**
	 * Worker model route. Left empty, workers inherit the session default — the
	 * right behaviour for a shared plugin, since a hardcoded route would name a
	 * provider the installer may not have. Set both to PIN every worker to one
	 * route, so a later change of the Host default cannot silently move a running
	 * worker onto a model that cannot do the job (reading images, for one).
	 */
	defaultProvider: z.string().default(''),
	defaultModel: z.string().default(''),
	defaultReasoningEffort: z.string().default(''),
	/** Preset applied to spawned workers; omitted entirely when empty. */
	workerPreset: z.string().default(''),
	/** A worker running with no log growth for this long is reported as `stuck`. */
	stuckAfterMs: z.number().step(1).min(30_000).default(900_000),
	/**
	 * Wake the orchestrator's session when a worker reports or escalates. Without
	 * this a report only lands in the roster, so an idle orchestrator never learns
	 * that a worker finished until it happens to poll.
	 */
	notifyOnReport: z.boolean().default(true),
	/** How often the background poller refreshes worker activity stamps. */
	pollMs: z.number().step(1).min(5_000).default(20_000),
	/** Cap on any text block this plugin hands back to a model. */
	maxTextChars: z.number().step(1).min(200).default(4000),
	/** Upper bound on `squad_wait`, so a wait can never outlive its tool call. */
	maxWaitMs: z.number().step(1).min(1_000).default(600_000)
})

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config) {
	const defaults = {
		defaultProvider: '',
		defaultModel: '',
		defaultReasoningEffort: '',
		workerPreset: '',
		stuckAfterMs: 900_000,
		notifyOnReport: true,
		pollMs: 20_000,
		maxTextChars: 4000,
		maxWaitMs: 600_000
	}
	const resolved = { ...defaults, ...(config ?? {}) }
	for (const key of Object.keys(defaults)) {
		const value = resolved[key]
		if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
			throw new TypeError(`${key} must be a non-negative safe integer`)
		}
	}
	return resolved
}

/** Whether a value is meaningful text rather than an empty or non-string filler. */
function hasText(value) {
	return typeof value === 'string' && value.trim().length > 0
}

/**
 * Render one reported artifact as text.
 *
 * `String(value)` on an object yields "[object Object]", which destroyed every
 * structured artifact a worker reported (paths grouped with descriptions, test
 * results, diffs) and shipped the literal string to the orchestrator. Strings
 * pass through; anything structured is serialised so nothing is lost.
 */
function artifactText(value) {
	if (typeof value === 'string') return value
	if (value === null || value === undefined) return ''
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/** Join the text blocks of a content-block array, truncated to `limit`. */
function blocksToText(blocks, limit) {
	if (!Array.isArray(blocks)) return ''
	const parts = []
	for (const block of blocks) {
		if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text)
		}
	}
	const text = parts.join('\n').trim()
	return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** One structured error the model can act on, rendered as a plain Error. */
function refuse(message) {
	return new Error(message)
}

/**
 * Shared output declaration. Every squad tool returns a free-form object whose
 * `summary` is the model-facing text, so one loose schema and one renderer keep
 * the ten tools consistent instead of ten near-identical schema blocks.
 */
const RESULT_OUTPUT = {
	schema: { type: 'object', additionalProperties: true },
	render: (_args, value) => [{
		type: 'text',
		text: typeof value?.summary === 'string' && value.summary.length > 0 ? value.summary : JSON.stringify(value)
	}]
}

function apply(ctx, config) {
	const cfg = resolveConfig(config)

	/** @type {Map<string, any>} worker name -> record. Process-local, Host-wide. */
	const roster = new Map()
	const STATE_PATH = resolveStatePath()

	// ------------------------------------------------------- persistence

	/**
	 * Write the roster to disk. Best-effort by design: losing a roster update is
	 * bad, but failing a tool call because the state file could not be written
	 * would be worse and much harder to diagnose.
	 */
	function saveRoster() {
		try {
			mkdirSync(dirname(STATE_PATH), { recursive: true, mode: 0o700 })
			const payload = JSON.stringify({ version: 1, savedAt: Date.now(), workers: [...roster.values()] })
			const temp = `${STATE_PATH}.tmp`
			writeFileSync(temp, payload, { mode: 0o600 })
			renameSync(temp, STATE_PATH)
		} catch {
			// Persistence is a durability improvement, never a precondition.
		}
	}

	/**
	 * Restore the roster. Anything malformed is skipped rather than trusted: a
	 * corrupt state file must not be able to break plugin activation.
	 */
	function loadRoster() {
		let parsed
		try {
			parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
		} catch {
			return
		}
		if (!Array.isArray(parsed?.workers)) return
		for (const entry of parsed.workers) {
			if (typeof entry?.name !== 'string' || typeof entry?.sessionId !== 'string' || typeof entry?.cwd !== 'string') continue
			roster.set(entry.name, {
				...entry,
				tasks: Array.isArray(entry.tasks) ? entry.tasks : [],
				reports: Array.isArray(entry.reports) ? entry.reports : [],
				escalations: Array.isArray(entry.escalations) ? entry.escalations : [],
				lastSeq: typeof entry.lastSeq === 'number' ? entry.lastSeq : -1,
				lastActivityAt: typeof entry.lastActivityAt === 'number' ? entry.lastActivityAt : 0,
				// The session still exists durably; it is simply not attached yet.
				dormant: ctx.agents.get(entry.sessionId) === undefined
			})
		}
	}

	// ---------------------------------------------------- campaign tree

	/**
	 * Root of the shared campaign tree for one orchestrator session.
	 *
	 * The roster is the plugin's index; this tree is the durable, human-browsable
	 * record beside it. Reports and escalations are archived here as markdown as
	 * they arrive, and INDEX.md is regenerated so the whole campaign can be read
	 * with nothing but a file browser — no plugin, no tools. The orchestrator
	 * keeps its own memory and task notes in `notes/` and `tasks/` here.
	 */
	function campaignRoot(owner) {
		return join(dirname(STATE_PATH), 'campaigns', safeName(owner))
	}

	/** One path-safe name component. */
	function safeName(value) {
		return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 90)
	}

	/**
	 * Write one report or escalation as a readable file. Best-effort: an archive
	 * failure must never fail the report the worker just made — the roster still
	 * holds it, and the campaign tree is a convenience over that.
	 */
	function archiveToCampaign(owner, kind, rec, entry) {
		try {
			const dir = join(campaignRoot(owner), kind === 'report' ? 'reports' : 'escalations')
			mkdirSync(dir, { recursive: true, mode: 0o700 })
			const stamp = new Date(entry.at ?? Date.now()).toISOString().replace(/[:.]/g, '-')
			const file = join(dir, `${safeName(rec.name)}-${stamp}.md`)
			const head = [
				`# ${kind === 'report' ? 'Report' : 'Escalation'} — ${rec.name}`,
				'',
				`- worker: ${rec.name}`,
				`- project: ${rec.project}`,
				`- session: ${rec.sessionId}`,
				`- cwd: ${rec.cwd}`,
				`- at: ${new Date(entry.at ?? Date.now()).toISOString()}`
			]
			const body = []
			if (kind === 'report') {
				head.push(`- status: ${entry.status}`)
				body.push('', '## Summary', '', entry.summary ?? '')
				if (hasText(entry.details)) body.push('', '## Details', '', entry.details)
				if (Array.isArray(entry.artifacts) && entry.artifacts.length > 0) {
					body.push('', '## Artifacts', '')
					for (const item of entry.artifacts) body.push(`- ${item}`)
				}
			} else {
				body.push('', '## Question', '', entry.question ?? '')
				if (hasText(entry.context)) body.push('', '## Context', '', entry.context)
				if (Array.isArray(entry.options) && entry.options.length > 0) {
					body.push('', '## Options', '')
					for (const option of entry.options) body.push(`- ${option}`)
				}
			}
			writeFileSync(file, [...head, ...body, ''].join('\n'), { mode: 0o600 })
			writeCampaignIndex(owner)
			return file
		} catch {
			return undefined
		}
	}

	/**
	 * Regenerate the campaign index. Kept flat and greppable on purpose: this is
	 * what a person reads when they want the state of the whole engagement
	 * without asking an agent.
	 */
	function writeCampaignIndex(owner) {
		try {
			const root = campaignRoot(owner)
			mkdirSync(root, { recursive: true, mode: 0o700 })
			const mine = [...roster.values()].filter(rec => rec.owner === owner)
			const lines = [
				'# Squad campaign',
				'',
				`- orchestrator session: \`${owner}\``,
				`- workers: ${mine.length}`,
				`- updated: ${new Date().toISOString()}`,
				'',
				'## Roster',
				'',
				'| worker | project | session | status | reports | escalations |',
				'| --- | --- | --- | --- | --- | --- |'
			]
			for (const rec of mine) {
				lines.push(`| ${rec.name} | ${rec.project} | \`${rec.sessionId}\` | ${statusOf(rec)} | ${rec.reports.length} | ${rec.escalations.length} |`)
			}
			lines.push('', '## Latest task per worker', '')
			for (const rec of mine) {
				const last = rec.tasks[rec.tasks.length - 1]
				lines.push(`- **${rec.name}**: ${last === undefined ? '_(nothing assigned yet)_' : last.text}`)
			}
			lines.push(
				'',
				'## Layout',
				'',
				'```',
				'INDEX.md      this file, regenerated on every report',
				'reports/      one markdown file per worker report',
				'escalations/  one markdown file per worker question',
				'notes/        free-form campaign memory',
				'tasks/        the task board',
				'```',
				''
			)
			writeFileSync(join(root, 'INDEX.md'), lines.join('\n'), { mode: 0o600 })
			return root
		} catch {
			return undefined
		}
	}

	/**
	 * Wake the orchestrator with a fleet notification.
	 *
	 * A worker report used to land in the roster and nowhere else: the
	 * orchestrator only learned about it if it happened to poll with squad_list or
	 * squad_wait. An orchestrator sitting idle between rounds therefore never
	 * learned that a worker had finished — a completed task looked lost.
	 *
	 * Delivery is a QUEUED turn: it starts a turn at once when the orchestrator is
	 * idle, and waits behind the current turn when it is busy rather than
	 * interrupting it. `SessionPromptRequest` carries no source field, so the text
	 * is self-labelling to stay distinguishable from the user's own messages.
	 *
	 * @returns a short delivery outcome, surfaced to the worker and the orchestrator.
	 */
	async function notifyOrchestrator(ownerSessionId, text, signal) {
		if (cfg.notifyOnReport !== true) return 'disabled'
		if (!hasText(ownerSessionId)) return 'no orchestrator session'
		try {
			await ctx.sessionController.prompt({
				requestId: `squad-notify-${randomUUID()}`,
				sessionId: ownerSessionId,
				mode: 'queue',
				content: [{ type: 'text', text: truncate(text, cfg.maxTextChars) }]
			}, signal ?? new AbortController().signal)
			return 'delivered'
		} catch (error) {
			// Never fail the report itself over a notification: the roster and the
			// campaign tree still hold it, and the orchestrator can still collect.
			return `failed: ${String(error)}`
		}
	}

	// ---------------------------------------------------------------- helpers

	/** Stamp a record as changed. */
	function touch(rec) {
		rec.updatedAt = Date.now()
	}

	/**
	 * Attach a restored worker again so it can be prompted or inspected.
	 *
	 * Two constraints, both read from `ensureSession` rather than guessed:
	 *  - the `cwd` must equal the session header's stored cwd or `create` throws
	 *    ApiSessionCwdConflict, which is why `rec.cwd` is persisted;
	 *  - passing `agentPreset` would run `assertPresetUnchanged`, so it is omitted
	 *    here — the session already carries its preset durably.
	 *
	 * @returns true when a live agent is attached.
	 */
	async function ensureLive(rec) {
		if (ctx.agents.get(rec.sessionId) !== undefined) {
			rec.dormant = false
			return true
		}
		if (rec.sessionId === undefined || rec.cwd === undefined) return false
		try {
			await ctx.sessionController.create({ sessionId: rec.sessionId, cwd: rec.cwd })
			rec.dormant = false
			delete rec.adoptError
			touch(rec)
			return true
		} catch (error) {
			// Recorded so squad_status can report why, instead of silently failing.
			rec.adoptError = String(error)
			return false
		}
	}

	/** As ensureLive, but refuses the call when the worker cannot be attached. */
	async function requireLive(rec) {
		if (await ensureLive(rec)) return
		throw refuse(`worker "${rec.name}" could not be re-attached to session ${rec.sessionId}${rec.adoptError === undefined ? '' : `: ${rec.adoptError}`}. It is still on the roster; close it and spawn it again if the session is gone.`)
	}

	/**
	 * The one place a worker record is built, so the created and recovered paths
	 * cannot drift apart.
	 */
	function buildRecord({ workerName, workspace, sessionId, preset, owner }) {
		return {
			name: workerName,
			project: workspace.title,
			cwd: workspace.path,
			workspaceId: workspace.id,
			sessionId,
			preset: hasText(preset) ? preset : null,
			owner,
			provider: cfg.defaultProvider,
			model: cfg.defaultModel,
			tasks: [],
			reports: [],
			escalations: [],
			lastSeq: -1,
			lastActivityAt: 0,
			createdAt: Date.now(),
			updatedAt: Date.now()
		}
	}

	/**
	 * Find an existing worker session by its durable title.
	 *
	 * This is the recovery path: the roster is the fast lookup, and this catches
	 * the case where it is missing — a fresh install, a deleted state file, or a
	 * roster rebuilt after a crash. Only sessions whose header cwd matches the
	 * target workspace are considered, and titles are read one session at a time,
	 * so the scan is bounded by the workspace rather than the whole corpus.
	 *
	 * @returns the matching session header, or undefined.
	 */
	async function findByTitle(workerName, workspacePath) {
		let records
		try {
			records = await ctx.sessionQuery.listSessions()
		} catch {
			return undefined
		}
		const wanted = titleFor(workerName)
		for (const record of records) {
			const header = record?.header
			if (header?.id === undefined) continue
			if (workspacePath !== undefined && header.cwd !== undefined && header.cwd !== workspacePath) continue
			try {
				const snapshot = await ctx.sessionQuery.readTitle(header.id)
				if (snapshot?.title === wanted) return header
			} catch {
				// A session whose title cannot be read simply is not a match.
			}
		}
		return undefined
	}

	/** Best-effort durable identity marker; never fatal to a spawn. */
	async function markTitle(sessionId, workerName) {
		try {
			await ctx.sessionController.rename({ sessionId, title: titleFor(workerName) })
		} catch {
			// A worker without a title still works; it is just harder to identify.
		}
	}

	/**
	 * Resolve the worker a caller named, accepting EITHER its roster name or its
	 * session id. A caller holding an id from squad_list can address the same
	 * worker without knowing its name, and ownership is still enforced either way.
	 */
	function owned(exec, identifier) {
		const key = String(identifier ?? '').trim()
		let rec = roster.get(key)
		if (rec === undefined && key.length > 0) {
			for (const candidate of roster.values()) {
				if (candidate.sessionId === key) {
					rec = candidate
					break
				}
			}
		}
		if (rec === undefined) {
			const known = [...roster.keys()]
			const hint = key.startsWith('session-') ? ' (that looks like a session id, but no tracked worker uses it)' : ''
			const rosterHint = known.length === 0 ? 'the roster is empty — call squad_spawn first' : `known workers: ${known.join(', ')}`
			throw refuse(`no squad worker matches "${key}"${hint}; ${rosterHint}`)
		}
		if (exec?.agent?.id !== rec.owner) {
			throw refuse(`worker "${rec.name}" (${rec.sessionId}) belongs to orchestrator session ${rec.owner}, not ${exec?.agent?.id ?? 'this session'}`)
		}
		return rec
	}

	/** The record for the calling session when it is itself a worker, else undefined. */
	function selfRecord(exec) {
		if (exec?.agent?.id === undefined) return undefined
		for (const rec of roster.values()) if (rec.sessionId === exec.agent.id) return rec
		return undefined
	}

	/**
	 * Ask the session store for one worker's raw log. Returns an empty list when
	 * the session is gone, so every caller can degrade instead of throwing.
	 */
	async function readEvents(rec, signal) {
		try {
			const observation = await ctx.sessionQuery.observeSession(rec.sessionId, { projectionMode: 'none', signal })
			try {
				return observation.events ?? []
			} finally {
				await observation[Symbol.asyncDispose]?.()
			}
		} catch {
			return []
		}
	}

	/**
	 * Cheap activity refresh: listEvents carries seq and time but no payloads, so
	 * this stays light enough to run on a timer for every live worker.
	 */
	async function refreshActivity(rec) {
		try {
			const records = await ctx.sessionQuery.listEvents(rec.sessionId)
			const last = records[records.length - 1]
			if (last === undefined) return
			if (last.seq !== rec.lastSeq) {
				rec.lastSeq = last.seq
				rec.lastActivityAt = last.time
				touch(rec)
				saveRoster()
			} else if (rec.lastActivityAt === 0) {
				rec.lastActivityAt = last.time
			}
		} catch {
			// A disposed or not-yet-flushed worker is reported through `status` instead.
		}
	}

	/**
	 * Ask questions the worker put to the human and never got answered. The user
	 * cannot reply to a worker session they are not watching, so an outstanding
	 * `ask_user_question` means that worker is wedged until the orchestrator acts.
	 */
	function pendingQuestions(events) {
		const asked = new Map()
		const answered = new Set()
		for (const event of events) {
			if (event.type === 'tool/call' && (event.data?.name === 'ask_user_question' || event.data?.name === 'ask_user')) {
				asked.set(event.data.callId, { at: event.time, arguments: event.data.arguments })
			} else if (event.type === 'tool/result') {
				const id = event.data?.message?.toolCallId
				if (typeof id === 'string') answered.add(id)
			}
		}
		const open = []
		for (const [id, call] of asked) if (!answered.has(id)) open.push({ id, at: call.at, question: call.arguments })
		return open
	}

	/** Most recent non-empty assistant message, used as the fallback report. */
	function lastAnswer(events) {
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const event = events[i]
			if (event.type !== 'assistant/message') continue
			const text = blocksToText(event.data?.message?.content, cfg.maxTextChars)
			if (text.length > 0) return text
		}
		return ''
	}

	/** The last tool the worker called, so the orchestrator can see where it is. */
	function lastToolCall(events) {
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const event = events[i]
			if (event.type === 'tool/call') return { name: event.data?.name ?? null, at: event.time }
		}
		// null, never undefined: a tool result must be lossless JSON, and a bare
		// `undefined` property here is what made squad_spawn report "invalid output".
		return null
	}

	/**
	 * Whether a worker's last turn never closed.
	 *
	 * `turn/start` without its `turn/end` is the only durable trace of a process
	 * that died mid-turn — a restart, a crash, a killed worker. A balanced log
	 * means every turn it began was finished, so a worker sitting at `idle` with a
	 * balanced log is genuinely between tasks rather than interrupted. Verified
	 * against real logs before wiring it up.
	 */
	function interruptedTurn(events) {
		let open = 0
		for (const event of events) {
			if (event.type === 'turn/start') open += 1
			else if (event.type === 'turn/end') open -= 1
		}
		return open > 0
	}

	/**
	 * Total input queued on a worker, tolerating a driver that does not expose
	 * the live Inbox. A worker view is the one thing every other squad tool
	 * depends on, so it must never throw: an unexpected Agent shape has to
	 * degrade to "0 queued", never wedge the whole roster.
	 */
	function pendingCount(agent) {
		if (agent === undefined || agent === null) return 0
		try {
			return (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0)
		} catch {
			return 0
		}
	}

	/**
	 * Derive one worker's live status. `running` is the Agent's own lifecycle
	 * flag, so it is accurate; staleness is layered on top of the last log write.
	 */
	function statusOf(rec, events) {
		const agent = ctx.agents.get(rec.sessionId)
		// No live agent means "not attached yet", not "gone": the session is
		// durable and ensureLive() re-attaches it on next use.
		if (agent === undefined) return rec.adoptError === undefined ? 'dormant' : 'unattachable'
		if (events !== undefined && pendingQuestions(events).length > 0) return 'needs-answer'
		if (agent.status !== 'running') {
			if (rec.reports.length > 0) return 'reported'
			return 'idle'
		}
		const idleMs = Date.now() - (rec.lastActivityAt || 0)
		if (rec.lastActivityAt > 0 && idleMs > cfg.stuckAfterMs) return 'stuck'
		return 'working'
	}

	/** Compact public shape shared by squad_list and every other view. */
	async function view(rec, { withDetail = false } = {}) {
		await refreshActivity(rec)
		const agent = ctx.agents.get(rec.sessionId)
		const events = withDetail ? await readEvents(rec) : undefined
		const base = {
			name: rec.name,
			project: rec.project,
			cwd: rec.cwd,
			session_id: rec.sessionId,
			status: statusOf(rec, events),
			// The route the plugin pinned, or null when the worker inherits the
			// session default. Never an empty string: a caller must be able to tell
			// "pinned to X" from "not pinned" without guessing.
			model: hasText(rec.provider) && hasText(rec.model) ? `${rec.provider}/${rec.model}` : null,
			last_task: rec.tasks[rec.tasks.length - 1]?.text ?? null,
			last_activity: rec.lastActivityAt > 0 ? new Date(rec.lastActivityAt).toISOString() : null,
			queued: pendingCount(agent),
			unread_reports: rec.reports.filter(report => !report.delivered).length,
			unread_escalations: rec.escalations.filter(item => !item.answered).length
		}
		if (!withDetail) return base
		const open = events === undefined ? [] : pendingQuestions(events)
		return {
			...base,
			last_tool: lastToolCall(events ?? []),
			open_questions: open.map(item => ({ at: new Date(item.at).toISOString(), question: truncate(item.question, cfg.maxTextChars) })),
			last_answer: lastAnswer(events ?? []) || null,
			/** True when the worker is wedged on a question nobody answered. */
			blocked_on_question: open.length > 0
		}
	}

	function truncate(text, limit) {
		if (typeof text !== 'string') return ''
		return text.length > limit ? `${text.slice(0, limit)}…` : text
	}

	/**
	 * Render one worker for a model-facing summary. Every call site passes a
	 * `view()` result, so this consumes the view's own snake_case keys — reading
	 * the internal record's `sessionId`/`provider` here printed "undefined" for
	 * exactly the two fields those names carried.
	 */
	function render(view) {
		return [
			`<worker>${view.name}</worker>`,
			`<project>${view.project}</project>`,
			`<cwd>${view.cwd}</cwd>`,
			`<session_id>${view.session_id}</session_id>`,
			`<status>${view.status}</status>`,
			// A pinned route is worth showing; when the plugin pinned nothing the
			// worker inherits the session default, and an empty `<model></model>`
			// would read as a bug rather than a deliberate inheritance.
			`<model>${hasText(view.model) ? view.model : 'session default'}</model>`,
			`<queued>${view.queued}</queued>`,
			`<last_task>${view.last_task ?? ''}</last_task>`,
			`<unread_reports>${view.unread_reports}</unread_reports>`,
			`<unread_escalations>${view.unread_escalations}</unread_escalations>`
		].join('\n')
	}

	/** Resolve a project name or absolute path to a registered workspace, registering it when a path is given. */
	async function resolveWorkspace(project, cwd) {
		const workspaces = ctx.workspaceRegistry.list()
		const byProject = project === undefined ? undefined : workspaces.find(ws => ws.title === project || ws.path === project)
		if (byProject !== undefined) return byProject
		if (hasText(cwd)) {
			const path = cwd.trim()
			const existing = workspaces.find(ws => ws.path === path)
			if (existing !== undefined) return existing
			return await ctx.workspaceRegistry.create(path, hasText(project) ? project.trim() : path.split('/').filter(Boolean).pop())
		}
		if (hasText(project)) {
			throw refuse(`no registered workspace matches project "${project}"; known projects: ${workspaces.map(ws => ws.title).join(', ') || '(none)'}. Pass cwd to register a new one.`)
		}
		throw refuse('pass project (a registered workspace title or path) or cwd so the worker knows which workspace to open')
	}

	// Restore any roster saved by a previous process or plugin generation, so a
	// restart or a bundle patch reload no longer empties the fleet.
	loadRoster()

	// ------------------------------------------------------------------ tools

	/** Create or adopt one named worker session bound to another workspace. */
	async function spawn(args, exec) {
		const owner = exec?.agent?.id
		if (owner === undefined) throw refuse('squad_spawn requires a calling agent')
		const workerName = args.name.trim()
		if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(workerName)) throw refuse('name must be 1-40 lowercase letters, digits, or hyphens, starting with a letter or digit')

		const existing = roster.get(workerName)
		if (existing !== undefined) {
			if (owner !== existing.owner) throw refuse(`worker "${workerName}" already exists and belongs to another orchestrator session (${existing.owner})`)
			// A restored record is dormant until re-attached; spawn is the natural
			// place to do that, so "ensure the fleet exists" also revives it.
			const warnings = []
			if (!(await ensureLive(existing))) {
				warnings.push(`restored worker could not be re-attached to session ${existing.sessionId}${existing.adoptError === undefined ? '' : `: ${existing.adoptError}`}`)
			}
			return { rec: existing, created: false, warnings }
		}

		const workspace = await resolveWorkspace(args.project, args.cwd)
		const preset = hasText(args.preset) ? args.preset.trim() : cfg.workerPreset
		const warnings = []

		// Recovery before creation: if a session already carries this worker's
		// title in this workspace, adopt it. Without this, a lost roster turns
		// every re-spawn into a brand-new session and orphans the previous one —
		// which is exactly how the first campaign accumulated ~7 stray sessions
		// per project.
		const recovered = await findByTitle(workerName, workspace.path)
		if (recovered !== undefined) {
			const rec = buildRecord({ workerName, workspace, sessionId: recovered.id, preset, owner })
			roster.set(workerName, rec)
			saveRoster()
			if (!(await ensureLive(rec))) {
				warnings.push(`adopted existing session ${recovered.id} but could not attach to it${rec.adoptError === undefined ? '' : `: ${rec.adoptError}`}`)
			}
			await refreshActivity(rec)
			saveRoster()
			return { rec, created: false, warnings }
		}

		let created
		try {
			created = await ctx.sessionController.create({ workspaceId: workspace.id, ...(hasText(preset) ? { agentPreset: preset } : {}) })
		} catch (error) {
			// A missing or broken worker preset must not block the whole roster.
			created = await ctx.sessionController.create({ workspaceId: workspace.id })
			warnings.push(`created WITHOUT preset "${preset}" — the worker will not have its role instructions (${String(error)})`)
		}
		const sessionId = created.sessionId

		// Stamp the durable identity marker before anything can go wrong.
		await markTitle(sessionId, workerName)

		// Pin the worker route only when one is configured. Empty means the worker
		// inherits the session default, which is what a shared install wants — and
		// calling selectModel with a blank provider would fail on every spawn.
		// When a route IS configured, a failure here is surfaced rather than
		// swallowed: the worker would otherwise quietly run on whatever the Host
		// default happens to be, which may be a model that cannot read images.
		if (hasText(cfg.defaultProvider) && hasText(cfg.defaultModel)) {
			try {
				await ctx.sessionController.selectModel({
					sessionId,
					provider: cfg.defaultProvider,
					model: cfg.defaultModel,
					...(hasText(cfg.defaultReasoningEffort) ? { reasoningEffort: cfg.defaultReasoningEffort } : {})
				})
			} catch (error) {
				warnings.push(`could not pin the model to ${cfg.defaultProvider}/${cfg.defaultModel}; the worker is running on the session default (${String(error)})`)
			}
		}

		const rec = buildRecord({ workerName, workspace, sessionId, preset, owner })
		roster.set(workerName, rec)
		await refreshActivity(rec)
		touch(rec)
		saveRoster()
		return { rec, created: true, warnings }
	}

	ctx.tools.register(defineTool({
		name: 'squad_spawn',
		description: 'Create or adopt a named worker session running in a different workspace. Use one worker per project. Re-spawning an existing name returns the same worker, so this is safe to call at the start of every task.',
		parameters: {
			name: { type: 'string', required: true, description: 'Stable worker name, e.g. "reviewer" or "performance".' },
			project: { type: 'string', description: 'Registered workspace title or absolute path, e.g. "opencode-ai-reviewer".' },
			cwd: { type: 'string', description: 'Absolute workspace path. Registers a new workspace when project is unknown or omitted.' },
			preset: { type: 'string', description: 'Agent preset for the worker; defaults to the configured worker preset.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const { rec, created, warnings } = await spawn(args, exec)
			let live
			try {
				live = await view(rec, { withDetail: true })
			} catch (error) {
				// Unwind completely: drop the roster record AND stop the session we
				// just created, so a failed spawn leaves nothing behind in the
				// user's sidebar. Leaving orphans is what made this failure look
				// like a workspace-registration problem instead of a crash.
				roster.delete(rec.name)
				saveRoster()
				const orphan = ctx.agents.get(rec.sessionId)
				if (orphan !== undefined) {
					try {
						orphan.cancel({ kind: 'hook', reason: 'squad-spawn-failed' }, { keepInbox: false })
					} catch {
						// Already idle; nothing to stop.
					}
				}
				throw refuse(`worker "${rec.name}" could not be read back after creation (${String(error)}). It was removed from the roster and its turn was stopped; re-run squad_spawn.`)
			}
			// Make sure the campaign tree exists from the first spawn, and tell the
			// orchestrator where it is: that directory is its campaign memory.
			const campaign = writeCampaignIndex(rec.owner)
			return {
				created,
				worker: live,
				warnings,
				campaign_dir: campaign ?? null,
				summary: `${created ? 'Created' : 'Adopted'} worker "${rec.name}" in ${rec.project} (${rec.sessionId}), model ${hasText(rec.provider) && hasText(rec.model) ? `${rec.provider}/${rec.model} (pinned)` : 'inherited from the session default'}.${campaign === undefined ? '' : `\nCampaign tree: ${campaign} — write your task board in tasks/ and campaign memory in notes/ there.`}${warnings.length === 0 ? '' : `\nWARNINGS:\n${warnings.map(w => `- ${w}`).join('\n')}`}`
			}
		},
		presentCall: args => ({ card: 'generic', title: `Spawn worker ${args.name}`, kind: 'other' })
	}))

	ctx.tools.register(defineTool({
		name: 'squad_list',
		description: 'List every squad worker with its project, live status, queued task count, and unread reports or escalations. Check this to see what the fleet is doing.',
		parameters: {},
		output: RESULT_OUTPUT,
		async execute(_args, exec) {
			const workers = []
			for (const rec of roster.values()) {
				if (rec.owner !== exec?.agent?.id) continue
				workers.push(await view(rec))
			}
			if (workers.length === 0) return { workers, summary: 'No workers yet. Call squad_spawn with a project to create one.' }
			return {
				workers,
				summary: `${workers.length} worker(s):\n${workers.map(render).join('\n\n')}`
			}
		},
		presentCall: () => ({ card: 'generic', title: 'List squad workers', kind: 'read' })
	}))

	ctx.tools.register(defineTool({
		name: 'squad_resume',
		description: 'Re-attach every worker after the orchestrator itself was resumed, and report what each one needs. Call this FIRST whenever you are asked to continue: it revives sessions that a restart left dormant, identifies workers whose turn never closed, and surfaces unread reports and escalations. Use reprompt to tell interrupted workers to carry on automatically.',
		parameters: {
			names: { type: 'array', description: 'Worker names or session ids to resume. Omit to resume every worker you own.' },
			reprompt: { type: 'boolean', description: 'Send "continue your interrupted task" to workers whose turn never closed. Defaults to false, so you can inspect before acting.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const wanted = Array.isArray(args.names) && args.names.length > 0 ? new Set(args.names.map(String)) : undefined
			const mine = [...roster.values()].filter(rec => rec.owner === exec?.agent?.id && (wanted === undefined || wanted.has(rec.name) || wanted.has(rec.sessionId)))
			if (mine.length === 0) {
				return { workers: [], summary: 'Nothing to resume: no workers on the roster. Call squad_spawn to create the fleet.' }
			}

			const workers = []
			let reattached = 0
			let interruptedCount = 0
			let reprompted = 0
			for (const rec of mine) {
				const wasDormant = ctx.agents.get(rec.sessionId) === undefined
				const live = await ensureLive(rec)
				if (wasDormant && live) reattached += 1
				const events = live ? await readEvents(rec) : []
				const interrupted = live && interruptedTurn(events)
				if (interrupted) interruptedCount += 1

				// Only ever re-prompt a worker whose turn never closed: an idle
				// worker with a balanced log is genuinely between tasks, and
				// waking it would invent work the orchestrator never assigned.
				if (args.reprompt === true && interrupted) {
					try {
						await ctx.sessionController.prompt({
							requestId: `squad-resume-${randomUUID()}`,
							sessionId: rec.sessionId,
							mode: 'queue',
							content: [{ type: 'text', text: 'Your previous turn was interrupted before it finished, most likely by a restart. Re-check what you already completed in this workspace, resume from where you stopped, and finish the task you were given. Then call squad_report.' }]
						}, exec.signal)
						reprompted += 1
					} catch (error) {
						rec.adoptError = String(error)
					}
				}

				const detail = await view(rec, { withDetail: true })
				workers.push({
					...detail,
					interrupted,
					needs_attention: detail.unread_reports > 0 || detail.unread_escalations > 0 || detail.blocked_on_question === true || interrupted
				})
				saveRoster()
			}

			const need = workers.filter(w => w.needs_attention)
			const lines = workers.map(w => {
				const flags = [
					w.interrupted ? 'INTERRUPTED (turn never closed)' : '',
					w.blocked_on_question ? 'BLOCKED on a question' : '',
					w.unread_reports > 0 ? `${w.unread_reports} unread report(s)` : '',
					w.unread_escalations > 0 ? `${w.unread_escalations} unread escalation(s)` : ''
				].filter(Boolean)
				return `${render(w)}${flags.length === 0 ? '\n<needs_attention>false</needs_attention>' : `\n<needs_attention>${flags.join('; ')}</needs_attention>`}`
			})
			const headline = [
				`Resumed ${workers.length} worker(s)${reattached > 0 ? `, re-attached ${reattached} from a previous process` : ''}.`,
				interruptedCount > 0 ? `${interruptedCount} had an unfinished turn${reprompted > 0 ? ` and ${reprompted} were told to continue` : ' — inspect them or re-run with reprompt:true'}.` : '',
				need.length > 0 ? `${need.length} need you.` : 'None need you right now.'
			].filter(Boolean).join(' ')

			return {
				workers,
				reattached,
				interrupted: interruptedCount,
				reprompted,
				summary: `${headline}\n\n${lines.join('\n\n')}`
			}
		},
		presentCall: () => ({ card: 'generic', title: 'Resume the fleet', kind: 'read' })
	}))

	ctx.tools.register(defineTool({
		name: 'squad_assign',
		description: 'Send a task to a worker. Use mode "queue" to schedule it for the worker\'s next turn, or mode "steer" to redirect a worker that is already working. Use "steer" to answer an escalation.',
		parameters: {
			name: { type: 'string', required: true, description: 'Worker name, or its session id as shown by squad_list.' },
			task: { type: 'string', required: true, description: 'The task. State what to do and what report you expect.' },
			mode: { type: 'string', required: true, enum: ['queue', 'steer'], description: 'queue schedules the task as its own new turn (it waits if the worker is mid-turn); steer injects it into the turn already running, consumed at the next step boundary.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const rec = owned(exec, args.name)
			// Re-attach a restored worker before dispatching; a dormant record is
			// recoverable, not dead.
			await requireLive(rec)
			const agent = ctx.agents.get(rec.sessionId)
			// Capture delivery state BEFORE dispatching, so the reply can say what
			// actually happened. Reporting "Queued" for both cases is what made a
			// queue sent to an idle worker look identical to a steer.
			const wasRunning = agent.status === 'running'
			const ahead = pendingCount(agent)
			await ctx.sessionController.prompt({
				requestId: `squad-${randomUUID()}`,
				sessionId: rec.sessionId,
				mode: args.mode,
				content: [{ type: 'text', text: args.task }]
			// prompt() takes (request, signal). Omitting the signal left the Host
			// calling signal.throwIfAborted() on undefined, so every dispatch
			// failed with "Cannot read properties of undefined (reading
			// 'throwIfAborted')" before the task ever reached the worker.
			}, exec.signal)
			// Steering is how the orchestrator answers an escalation, so any
			// escalation still open has now been responded to. Marking it here
			// keeps `unread_escalations` honest without a separate ack tool.
			if (args.mode === 'steer') {
				rec.escalations = rec.escalations.map(item => (item.answered ? item : { ...item, answered: true, answeredAt: Date.now() }))
			}
			rec.tasks.push({ at: Date.now(), text: truncate(args.task, cfg.maxTextChars), mode: args.mode })
			await refreshActivity(rec)
			touch(rec)
			saveRoster()
			const delivery = args.mode === 'steer'
				? (wasRunning
					? 'injected into the turn it is running now; it will be picked up at the next step boundary'
					: 'delivered; the worker was idle, so this started a turn')
				: (wasRunning
					? `queued behind the turn it is running now${ahead > 0 ? ` (${ahead} message(s) already waiting)` : ''}; it will start as its own separate turn once that finishes`
					: 'started immediately as its own turn; the worker was idle, so there was nothing to wait behind')
			return {
				worker: rec.name,
				session_id: rec.sessionId,
				mode: args.mode,
				delivery,
				status: statusOf(rec),
				summary: `${args.mode === 'steer' ? 'Steered' : 'Queued'} worker "${rec.name}" in session ${rec.sessionId} — ${delivery}. It is now ${statusOf(rec)}. Use squad_wait to be told when it reports.`
			}
		},
		presentCall: args => ({ card: 'generic', title: `${args.mode === 'steer' ? 'Steer' : 'Assign'} ${args.name}`, kind: 'other', locations: [] })
	}))

	ctx.tools.register(defineTool({
		name: 'squad_status',
		description: 'Inspect one worker in detail: live status, last tool it called, whether it is blocked on an unanswered question, its last answer, and anything still queued for it.',
		parameters: { name: { type: 'string', required: true, description: 'Worker name, or its session id as shown by squad_list.' } },
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const rec = owned(exec, args.name)
			const detail = await view(rec, { withDetail: true })
			return {
				worker: detail,
				summary: [
					render({ ...detail }),
					detail.last_tool ? `\n<last_tool>${detail.last_tool.name}</last_tool>` : '',
					detail.open_questions.length > 0 ? `\n<blocked_on_question>true</blocked_on_question>\n<question>${detail.open_questions[detail.open_questions.length - 1].question}</question>` : '',
					detail.last_answer ? `\n<last_answer>${detail.last_answer}</last_answer>` : ''
				].filter(Boolean).join('\n')
			}
		},
		presentCall: args => ({ card: 'generic', title: `Status of ${args.name}`, kind: 'read' })
	}))

	/**
	 * Shared watch predicates for squad_wait and squad_watch.
	 *
	 * One definition of "settled" and "needs attention", so a blocking wait and a
	 * background watch can never disagree about when a fan-out is finished — the
	 * kind of drift that would silently make one of them hang or return early.
	 */
	function watchKit(exec, names) {
		const wanted = Array.isArray(names) && names.length > 0 ? new Set(names.map(String)) : undefined
		const mine = () => [...roster.values()].filter(rec => rec.owner === exec?.agent?.id && (wanted === undefined || wanted.has(rec.name) || wanted.has(rec.sessionId)))
		const snapshot = async () => {
			const workers = []
			for (const rec of mine()) workers.push(await view(rec, { withDetail: true }))
			return workers
		}
		/**
		 * A worker needs attention when it reported, escalated, is wedged on a
		 * question, or went stale. Comparing this signature across polls is what
		 * makes a wait return on a *meaningful* change: an earlier version tracked
		 * raw log growth, so the call came back on every progress tick instead of
		 * on a report.
		 */
		const needsAttention = w => w.unread_reports > 0 || w.unread_escalations > 0 || w.blocked_on_question || w.status === 'reported' || w.status === 'stuck' || w.status === 'needs-answer'
		const signature = workers => workers.map(w => `${w.name}:${w.status}:${w.unread_reports}:${w.unread_escalations}:${w.blocked_on_question}`).join('|')
		/** Nothing is still working. */
		const settled = workers => workers.length > 0 && workers.every(w => w.status !== 'working')
		/** Wedged on something only the orchestrator can resolve. */
		const blocked = workers => workers.some(w => w.status === 'needs-answer' || w.status === 'stuck')
		/** Satisfied under the requested mode. */
		const satisfied = (workers, mode) => mode === 'all' ? (settled(workers) || blocked(workers)) : workers.some(needsAttention)
		return { mine, snapshot, needsAttention, signature, settled, blocked, satisfied }
	}

	ctx.tools.register(defineTool({
		name: 'squad_watch',
		description: 'Wait for workers IN THE BACKGROUND and be woken when they finish, so you can keep working meanwhile. Returns immediately with a job id; the completion notice wakes you with the result. Use this instead of squad_wait when a fan-out will take a while. mode "all" (default) wakes when every watched worker has settled.',
		parameters: {
			names: { type: 'array', description: 'Worker names or session ids to watch. Omit to watch every worker you own.' },
			mode: { type: 'string', enum: ['all', 'any'], description: '"all" (default) wakes when nothing is still working. "any" wakes on the first worker that needs attention.' },
			timeout_ms: { type: 'number', description: 'Give up after this long, capped by the configured maximum.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			// Soft access: without a job controller in the preset, background work is
			// impossible. Say so plainly instead of failing obscurely, and point at
			// the blocking alternative.
			const jobs = ctx.get('jobs')
			if (jobs === undefined) {
				throw refuse('background jobs are unavailable in this session, so squad_watch cannot run. Use squad_wait instead, or add @deepseek-ai/dsh-tool-jobs to this agent preset.')
			}
			const mode = args.mode === 'any' ? 'any' : 'all'
			const timeout = Math.min(args.timeout_ms ?? cfg.maxWaitMs, cfg.maxWaitMs)
			const kit = watchKit(exec, args.names)
			const label = args.names === undefined || args.names.length === 0 ? 'the whole fleet' : args.names.join(', ')

			// If it is already true, there is nothing to watch: answer inline so the
			// orchestrator does not pay a job round-trip for a finished fleet.
			const first = await kit.snapshot()
			if (kit.satisfied(first, mode)) {
				return { watching: false, job_id: null, workers: first, summary: `Already satisfied — no watch needed.\n\n${first.map(render).join('\n\n')}` }
			}

			const deadline = Date.now() + timeout
			const describe = workers => {
				const need = workers.filter(kit.needsAttention)
				const settledCount = workers.filter(w => w.status !== 'working').length
				return `${settledCount}/${workers.length} settled.${need.length === 0 ? '' : ` ${need.length} need you (${need.map(w => w.name).join(', ')}).`}\n\n${workers.map(render).join('\n\n')}`
			}

			let jobId
			try {
				jobId = jobs.start({
					kind: 'squad',
					label: `watch ${label}`,
					owner: exec.agent.id,
					run(job) {
						let cancelled = false
						const done = (async () => {
							try {
								while (!cancelled) {
									await new Promise(resolve => setTimeout(resolve, cfg.pollMs))
									if (cancelled) break
									const workers = await kit.snapshot()
									if (kit.satisfied(workers, mode)) {
										const text = describe(workers)
										job.append(text)
										return { status: 'completed', result: text }
									}
									if (Date.now() >= deadline) {
										const text = `Timed out after ${Math.round(timeout / 1000)}s. ${describe(workers)}`
										job.append(text)
										return { status: 'completed', detail: 'timeout', result: text }
									}
									job.updateProgress(`${workers.filter(w => w.status !== 'working').length}/${workers.length} settled`)
								}
								return { status: 'killed' }
							} catch (error) {
								return { status: 'failed', detail: String(error) }
							}
						})()
						return { cancel() { cancelled = true }, done }
					}
				})
			} catch (error) {
				throw refuse(`could not start a background watch (${String(error)}). Use squad_wait instead.`)
			}

			// Show what is running now so the orchestrator can decide what to do
			// while it waits, rather than sitting idle.
			const working = first.filter(w => w.status === 'working').map(w => w.name)
			return {
				watching: true,
				job_id: jobId,
				workers: first,
				summary: `Watching ${label} in the background as job ${jobId} (mode ${mode}, up to ${Math.round(timeout / 1000)}s). You are free to do other work now — you will be woken with the result.${working.length === 0 ? '' : `\nStill working: ${working.join(', ')}.`}\nStop it early with job_kill if you no longer need it.`
			}
		},
		presentCall: () => ({ card: 'generic', title: 'Watch squad in background', kind: 'other' })
	}))

	ctx.tools.register(defineTool({
		name: 'squad_wait',
		description: 'Block until workers finish, report, escalate, or change status. mode "any" returns on the first worker that needs attention; mode "all" waits until EVERY watched worker has settled, so a fan-out can be gathered in one pass instead of one turn per worker. Returns immediately when the condition already holds.',
		parameters: {
			names: { type: 'array', description: 'Worker names or session ids to watch. Omit to watch every worker you own.' },
			timeout_ms: { type: 'number', description: 'How long to wait, capped by the configured maximum.' },
			mode: { type: 'string', enum: ['any', 'all'], description: '"any" (default) returns on the first worker needing attention. "all" waits until no watched worker is still working — use it after assigning to several workers at once.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const timeout = Math.min(args.timeout_ms ?? 120_000, cfg.maxWaitMs)
			const mode = args.mode === 'all' ? 'all' : 'any'
			// Same predicates as squad_watch, so the blocking wait and the background
			// watch can never disagree about when a fan-out is finished.
			const kit = watchKit(exec, args.names)
			const { snapshot, needsAttention, signature, blocked } = kit
			const done = workers => kit.satisfied(workers, mode)

			const report = (workers, note) => {
				const need = workers.filter(needsAttention)
				const settled = workers.filter(w => w.status !== 'working')
				const head = mode === 'all'
					? `${settled.length}/${workers.length} worker(s) settled.${need.length > 0 ? ` ${need.length} need you:` : ''}`
					: `${need.length} worker(s) need you:`
				return {
					workers,
					mode,
					settled: settled.length,
					needs_attention: need.map(w => w.name),
					summary: `${note === undefined ? head : `${head} ${note}`}\n\n${(mode === 'all' && need.length === 0 ? workers : need.length > 0 ? need : workers).map(render).join('\n\n')}`
				}
			}

			const deadline = Date.now() + timeout
			const first = await snapshot()
			if (done(first)) return report(first, mode === 'all' ? 'All watched workers have finished.' : undefined)
			let baseline = signature(first)

			while (Date.now() < deadline) {
				// Deliberately NOT unref'd: this timer is the only thing keeping the
				// wait alive, so unref'ing it lets the host drop the call on the
				// floor. The deadline above bounds it.
				await new Promise(resolve => setTimeout(resolve, 2_000))
				const workers = await snapshot()
				if (done(workers)) return report(workers, mode === 'all' ? 'All watched workers have finished.' : undefined)
				// A worker that cannot progress without us must not be waited out.
				if (mode === 'all' && blocked(workers)) return report(workers, 'Some workers are blocked and will not progress on their own.')
				if (mode === 'any') {
					const next = signature(workers)
					if (next !== baseline) return report(workers, 'Workers changed state.')
				}
			}
			const workers = await snapshot()
			const settled = workers.filter(w => w.status !== 'working')
			return {
				workers,
				mode,
				settled: settled.length,
				timedOut: true,
				summary: `Waited ${Math.round(timeout / 1000)}s — ${settled.length}/${workers.length} settled.\n\n${workers.map(render).join('\n\n')}`
			}
		},
		presentCall: () => ({ card: 'generic', title: 'Wait for squad', kind: 'read' })
	}))

	ctx.tools.register(defineTool({
		name: 'squad_collect',
		description: 'Read a worker\'s reports, open escalations, and final answer, and mark them delivered. Call this after squad_wait to actually read what the worker produced.',
		parameters: {
			name: { type: 'string', required: true, description: 'Worker name, or its session id as shown by squad_list.' },
			mark_read: { type: 'boolean', description: 'Mark the returned reports and escalations as delivered. Defaults to true.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const rec = owned(exec, args.name)
			const events = await readEvents(rec)
			const mark = args.mark_read !== false
			const reports = rec.reports.map(report => ({ ...report }))
			const escalations = rec.escalations.map(item => ({ ...item }))
			const answer = lastAnswer(events)
			const open = pendingQuestions(events)
			if (mark) {
				rec.reports = rec.reports.map(report => (report.delivered ? report : { ...report, delivered: true, deliveredAt: Date.now() }))
				rec.escalations = rec.escalations.map(item => (item.answered ? item : { ...item, answered: true, answeredAt: Date.now() }))
				touch(rec)
				saveRoster()
			}
			return {
				name: rec.name,
				status: statusOf(rec, events),
				reports: reports.map(report => ({ at: new Date(report.at).toISOString(), status: report.status, summary: report.summary, details: report.details ?? null, artifacts: report.artifacts ?? null })),
				escalations: escalations.map(item => ({ at: new Date(item.at).toISOString(), question: item.question, context: item.context ?? null, options: item.options ?? null, answered: item.answered })),
				last_answer: answer || null,
				summary: renderCollection(rec, statusOf(rec, events), reports, escalations, answer, open)
			}
		},
		presentCall: args => ({ card: 'generic', title: `Collect from ${args.name}`, kind: 'read' })
	}))

	function renderCollection(rec, status, reports, escalations, answer, open) {
		const lines = [`<worker>${rec.name}</worker>`, `<status>${status}</status>`]
		if (reports.length > 0) {
			lines.push(`<reports count="${reports.length}">`)
			for (const report of reports) {
				lines.push(`  <report status="${report.status}" at="${new Date(report.at).toISOString()}">`)
				lines.push(`    <summary>${report.summary}</summary>`)
				if (hasText(report.details)) lines.push(`    <details>${report.details}</details>`)
				if (Array.isArray(report.artifacts) && report.artifacts.length > 0) lines.push(`    <artifacts>${report.artifacts.join('\n')}</artifacts>`)
				lines.push('  </report>')
			}
			lines.push('</reports>')
		}
		if (escalations.length > 0) {
			lines.push(`<escalations count="${escalations.length}">`)
			for (const item of escalations) {
				lines.push(`  <escalation at="${new Date(item.at).toISOString()}">`)
				lines.push(`    <question>${item.question}</question>`)
				if (hasText(item.context)) lines.push(`    <context>${item.context}</context>`)
				if (Array.isArray(item.options) && item.options.length > 0) lines.push(`    <options>${item.options.join('\n')}</options>`)
				lines.push('  </escalation>')
			}
			lines.push('</escalations>')
		}
		if (open.length > 0) lines.push(`<open_question>${truncate(open[open.length - 1].question, cfg.maxTextChars)}</open_question>`)
		if (hasText(answer) && reports.length === 0) lines.push(`<last_answer>${answer}</last_answer>`)
		if (reports.length === 0 && escalations.length === 0 && !hasText(answer) && open.length === 0) lines.push('No reports or escalations yet.')
		return lines.join('\n')
	}

	ctx.tools.register(defineTool({
		name: 'squad_stop',
		description: 'Cancel a worker\'s active turn, or discard its queued work. Use this when a worker is going the wrong way and you are steering it instead of stopping it.',
		parameters: {
			name: { type: 'string', required: true, description: 'Worker name, or its session id as shown by squad_list.' },
			keep_queued: { type: 'boolean', description: 'Keep queued follow-ups instead of discarding them. Defaults to false.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const rec = owned(exec, args.name)
			await requireLive(rec)
			const agent = ctx.agents.get(rec.sessionId)
			const previous = agent.status
			// AgentCancelCause is an object union, not a free string.
			agent.cancel({ kind: 'hook', reason: 'squad-stop' }, { keepInbox: args.keep_queued === true })
			await refreshActivity(rec)
			touch(rec)
			saveRoster()
			return { worker: rec.name, previous_status: previous, summary: `Stopped worker "${rec.name}" (was ${previous}). Queued work ${args.keep_queued === true ? 'kept' : 'discarded'}.` }
		},
		presentCall: args => ({ card: 'generic', title: `Stop ${args.name}`, kind: 'other' })
	}))

	ctx.tools.register(defineTool({
		name: 'squad_close',
		description: 'Stop a worker and remove it from the roster, so the fleet stops tracking it. The worker session and its log are retained and stay readable in its workspace.',
		parameters: { name: { type: 'string', required: true, description: 'Worker name, or its session id as shown by squad_list.' } },
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const rec = owned(exec, args.name)
			// Agent is not disposable: its lifetime belongs to the fiber that
			// created it, and there is no Host-side close. Cancel the active turn
			// and drop the record, and say plainly that the session survives.
			const agent = ctx.agents.get(rec.sessionId)
			if (agent !== undefined) {
				try {
					agent.cancel({ kind: 'hook', reason: 'squad-close' }, { keepInbox: false })
				} catch {
					// A worker with nothing to cancel is already closed for our purposes.
				}
			}
			roster.delete(rec.name)
			touch(rec)
			saveRoster()
			return {
				worker: rec.name,
				session_id: rec.sessionId,
				summary: `Closed worker "${rec.name}" (${rec.sessionId}) and stopped its turn. The session and its log are retained in ${rec.project}.`
			}
		},
		presentCall: args => ({ card: 'generic', title: `Close ${args.name}`, kind: 'other' })
	}))

	// -------------------------------------------------------- worker-side tools

	ctx.tools.register(defineTool({
		name: 'squad_report',
		description: 'Report the result of your assigned task back to the orchestrator. Call this at the end of every turn so the orchestrator knows where you stand. Do not finish a turn without it.',
		parameters: {
			status: { type: 'string', required: true, enum: ['done', 'partial', 'blocked'], description: 'done = task finished; partial = partly finished; blocked = cannot continue.' },
			summary: { type: 'string', required: true, description: 'One or two sentences: what you did and what the outcome is.' },
			details: { type: 'string', description: 'Anything the orchestrator needs to verify the work: commands run, decisions made, problems hit.' },
			artifacts: { type: 'array', description: 'Concrete outputs: changed file paths, URLs, test results.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const rec = selfRecord(exec)
			if (rec === undefined) throw refuse('this session is not a squad worker; only sessions created by squad_spawn should report')
			const report = {
				id: randomUUID(),
				at: Date.now(),
				status: args.status,
				summary: args.summary,
				// null, not undefined: records are lossless JSON so they can never
				// leak a JS undefined into a tool result.
				details: hasText(args.details) ? args.details : null,
				// map(String) turned a structured artifact into the literal text
				// "[object Object]", which is what reached the orchestrator. Keep
				// strings as-is and serialise anything else instead of destroying it.
				artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(artifactText) : null,
				delivered: false
			}
			rec.reports.push(report)
			// Archive to the campaign tree so the record outlives the roster and is
			// readable without the plugin.
			const archived = archiveToCampaign(rec.owner, 'report', rec, report)
			// Wake the orchestrator: without this the report sits in the roster and an
			// idle orchestrator never learns the task finished.
			const notified = await notifyOrchestrator(
				rec.owner,
				`[SQUAD] Worker "${rec.name}" (${rec.project}) reported ${args.status}.\n\n${truncate(args.summary, 1200)}\n\nCall squad_collect with name "${rec.name}" to read the full report, then continue the campaign.`,
				exec?.signal
			)
			await refreshActivity(rec)
			touch(rec)
			saveRoster()
			return {
				reported: true,
				status: args.status,
				orchestrator_notified: notified === 'delivered',
				summary: `Reported "${args.status}" to orchestrator ${rec.owner} (${notified}).${archived === undefined ? '' : ' Archived to the campaign tree.'}`
			}
		},
		presentCall: args => ({ card: 'generic', title: `Report ${args.status}`, kind: 'other' })
	}))

	ctx.tools.register(defineTool({
		name: 'squad_escalate',
		description: 'Ask the orchestrator for a decision you cannot make yourself. Use it only when a choice is genuinely yours to make; otherwise finish the task and report.',
		parameters: {
			question: { type: 'string', required: true, description: 'The decision you need, stated concretely.' },
			options: { type: 'array', description: 'The specific options you can see, best first.' },
			context: { type: 'string', description: 'What you have already tried, and what each option would cost.' }
		},
		output: RESULT_OUTPUT,
		async execute(args, exec) {
			const rec = selfRecord(exec)
			if (rec === undefined) throw refuse('this session is not a squad worker; only sessions created by squad_spawn should escalate')
			const escalation = {
				id: randomUUID(),
				at: Date.now(),
				question: args.question,
				options: Array.isArray(args.options) ? args.options.map(artifactText) : null,
				context: hasText(args.context) ? args.context : null,
				answered: false
			}
			rec.escalations.push(escalation)
			archiveToCampaign(rec.owner, 'escalation', rec, escalation)
			// An escalation means the worker is stopped until answered, so the
			// orchestrator has to be woken rather than left to discover it.
			const notified = await notifyOrchestrator(
				rec.owner,
				`[SQUAD] Worker "${rec.name}" (${rec.project}) is BLOCKED and needs your answer:\n\n${truncate(args.question, 1200)}${hasText(args.context) ? `\n\nContext: ${truncate(args.context, 800)}` : ''}\n\nCall squad_status "${rec.name}" for detail, then answer with squad_assign mode:"steer". It produces nothing until you do.`,
				exec?.signal
			)
			touch(rec)
			saveRoster()
			return {
				escalated: true,
				orchestrator_notified: notified === 'delivered',
				summary: `Escalated to orchestrator ${rec.owner} (${notified}): ${args.question}`
			}
		},
		presentCall: () => ({ card: 'generic', title: 'Escalate to orchestrator', kind: 'other' })
	}))

	// Keep each worker's activity stamp fresh so `statusOf` can tell a busy
	// worker from a wedged one. Only RUNNING workers are polled: an idle worker
	// cannot change without a new prompt, and refreshActivity reads the whole
	// event list, so polling idle workers would burn O(log length) every tick
	// for no signal.
	const poll = setInterval(() => {
		for (const rec of roster.values()) {
			const agent = ctx.agents.get(rec.sessionId)
			if (agent === undefined || agent.status !== 'running') continue
			void refreshActivity(rec)
		}
	}, cfg.pollMs)
	poll.unref?.()
	ctx.effect(() => () => clearInterval(poll))
}

export { Config, apply, inject, name }
