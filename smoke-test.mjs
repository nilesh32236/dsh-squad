// Offline harness. Two passes:
//  1. every defineTool schema compiles and renders (activation-time safety)
//  2. every execute() body runs against a realistic mock Host (runtime safety)
//
// Pass 2 exists because pass 1 alone let three wrong API assumptions through:
// Agent.inbox key names, AgentCancelCause's shape, and Agent disposal. All three
// were compile-clean and only failed when a tool actually ran.
//
// Not shipped in the bundle. Run: node smoke-test.mjs
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from './fleet.js'

/**
 * One mock Host. Building a second, independent one is how the persistence test
 * simulates a plugin reload or a `dsh` restart: same state file, fresh in-memory
 * registries.
 */
function makeHost() {
	const registered = []
	const agents = new Map()
	const workspaces = [
		{ id: 'w-reviewer', title: 'opencode-ai-reviewer', path: '/home/admin/opencode-ai-reviewer' },
		{ id: 'w-perf', title: 'performance-optimisation', path: '/var/www/site/wp-content/plugins/performance-optimisation' }
	]
	const created = []
	const cancelled = []
	const prompted = []
	// Durable session titles, as the real Host keeps them: a `session/title`
	// event read back through sessionQuery.readTitle.
	const renamed = []
	const titles = new Map()
	const sessionEvents = new Map()
	let seqCounter = 0

	/** A worker Agent shaped like the real one: camelCase inbox, object cancel cause. */
	function makeAgent(id, overrides = {}) {
		return {
			id,
			status: 'idle',
			inbox: { nextTurn: [], nextStep: [], clear() {} },
			cancel(cause, options) {
				if (cause === null || typeof cause !== 'object' || typeof cause.kind !== 'string') {
					throw new TypeError(`cancel(cause) must be an AgentCancelCause object, got ${JSON.stringify(cause)}`)
				}
				cancelled.push({ id, cause, options })
				if (options?.keepInbox !== true) this.inbox.nextTurn = []
				this.status = 'idle'
			},
			...overrides
		}
	}

	function appendEvent(sessionId, event) {
		seqCounter += 1
		const list = sessionEvents.get(sessionId) ?? []
		list.push({ seq: seqCounter, time: Date.now(), ...event })
		sessionEvents.set(sessionId, list)
	}

	// Background jobs, as jobs-local implements them: start() is synchronous and
	// returns an id; the spec's run() gets a handle and returns { cancel, done }.
	// kind only has to be a non-empty string — the real registry validates nothing
	// beyond that, which is what makes a "squad" kind legal.
	const startedJobs = []
	let jobCounter = 0
	const jobs = {
		start(spec) {
			if (spec.kind.length === 0) throw new Error('invalid job kind')
			if (spec.owner === undefined) throw new Error('test mock requires an owner')
			const id = `squad-${++jobCounter}`
			const chunks = []
			const hooks = spec.run({ id, append: text => chunks.push(text), updateProgress() {} })
			startedJobs.push({ id, spec, hooks, chunks })
			return id
		}
	}

	const services = { jobs }
	const ctx = {
		get: name => services[name],
		tools: { register: (tool) => { registered.push(tool); return () => {} } },
		agents: { get: (id) => agents.get(id) },
		sessions: { get: () => undefined, list: () => [] },
		sessionController: {
			async create(request) {
				// Mirrors the real create(): an explicit sessionId ADOPTS that
				// session rather than making a new one, and a cwd that disagrees
				// with the stored header throws ApiSessionCwdConflict.
				if (request.sessionId !== undefined) {
					// ensureSession checks the header cwd BEFORE returning, for a live
					// agent as well as a dormant one. Checking only when creating
					// would hide the constraint on the re-adoption path.
					const known = adoptedCwd.get(request.sessionId)
					if (known !== undefined && request.cwd !== undefined && known !== request.cwd) {
						throw new Error(`ApiSessionCwdConflict: session ${request.sessionId} has cwd ${known}, got ${request.cwd}`)
					}
					if (agents.get(request.sessionId) === undefined) {
						agents.set(request.sessionId, makeAgent(request.sessionId))
					}
					adopted.push(request.sessionId)
					return { sessionId: request.sessionId }
				}
				const id = `session-test-${created.length}`
				created.push(request)
				agents.set(id, makeAgent(id))
				// The real Host always stamps a cwd into the session header — the
				// workspace path when workspaceId is used. Model that, or the
				// ApiSessionCwdConflict guard stays invisible to this test.
				const ws = request.workspaceId === undefined ? undefined : workspaces.find(w => w.id === request.workspaceId)
				const effectiveCwd = ws?.path ?? request.cwd
				if (effectiveCwd !== undefined) adoptedCwd.set(id, effectiveCwd)
				return { sessionId: id }
			},
			async selectModel(request) { return { selected: request } },
			// Mirrors the real signature: (request, signal). The Host calls
			// signal.throwIfAborted(), so a permissive one-arg mock let an arity
			// bug ship and every dispatch failed at runtime.
			async prompt(request, signal) {
				if (signal === undefined) throw new TypeError("sessionController.prompt(request, signal): signal is required")
				signal.throwIfAborted()
				prompted.push(request)
				return { accepted: true }
			},
			cancel() { return { accepted: true } },
			// The durable identity marker: a worker session is titled `squad:<name>`.
			async rename(request) {
				renamed.push(request)
				titles.set(request.sessionId, request.title)
				return { title: request.title, seq: 1 }
			}
		},
		sessionQuery: {
			async observeSession(sessionId, options) {
				void options
				return {
					events: sessionEvents.get(sessionId) ?? [],
					cursor: seqCounter,
					async [Symbol.asyncDispose]() {}
				}
			},
			async listEvents(sessionId) { return sessionEvents.get(sessionId) ?? [] },
			// Used by the recovery scan: enumerate sessions, then read titles.
			async listSessions() {
				return [...agents.keys()].map(id => ({ header: { id, cwd: adoptedCwd.get(id) }, live: true, persisted: true }))
			},
			async readTitle(sessionId) {
				const title = titles.get(sessionId)
				return title === undefined ? undefined : { title, messageSeqs: [], source: 'user', eventSeq: 1, updatedAt: Date.now() }
			}
		},
		workspaceRegistry: {
			list: () => workspaces,
			async create(path, title) { const ws = { id: `w-${title}`, title, path }; workspaces.push(ws); return ws }
		},
		effect: () => () => {}
	}

	const adopted = []
	const adoptedCwd = new Map()
	return { ctx, registered, agents, workspaces, created, cancelled, prompted, sessionEvents, appendEvent, adopted, makeAgent, renamed, titles, startedJobs }
}

const host = makeHost()
const { ctx, registered, agents, workspaces, created, cancelled, prompted, appendEvent, makeAgent, renamed, titles } = host

/**
 * Declared arity of every Host API this plugin calls, transcribed from the
 * service catalog. Three separate shipped bugs were signature mistakes —
 * Agent.inbox key names, AgentCancelCause's shape, and prompt()'s two
 * arguments — and each one passed because a mock was looser than the real
 * thing. Writing the arity down here makes the next one a test failure
 * instead of a runtime error in someone's orchestrator session.
 */
const HOST_API_ARITY = {
	'sessionController.create': 1,
	'sessionController.selectModel': 1,
	'sessionController.prompt': 2,
	'sessionQuery.observeSession': 2,
	'sessionQuery.listEvents': 1,
	'workspaceRegistry.list': 0,
	'workspaceRegistry.create': 2,
	'agents.get': 1
}
for (const [path, arity] of Object.entries(HOST_API_ARITY)) {
	const [service, method] = path.split('.')
	const fn = ctx[service]?.[method]
	if (typeof fn !== 'function') throw new Error(`mock missing ${path}`)
	const actual = fn.length
	if (actual !== arity) throw new Error(`${path}: mock takes ${actual} args, the Host API takes ${arity}`)
}
console.log(`pass 0: ${Object.keys(HOST_API_ARITY).length} Host API mocks match their declared arity`)

// Isolate roster persistence. apply() resolves its state path from DSH_HOME at
// call time, so a scratch home keeps the test from touching the real roster.
const STATE_HOME = mkdtempSync(join(tmpdir(), 'squad-test-'))
process.env.DSH_HOME = STATE_HOME

apply(ctx, Config({}))

// ---- pass 1: schemas ------------------------------------------------------
const byName = new Map()
for (const tool of registered) {
	byName.set(tool.name, tool)
	const rendered = tool.output.render({}, { summary: `hi from ${tool.name}` })
	if (!Array.isArray(rendered) || rendered[0]?.type !== 'text') throw new Error(`${tool.name}: bad renderer`)
}
console.log(`pass 1: ${registered.length} tool schemas compile and render`)

// ---- pass 2: execute bodies ----------------------------------------------
const OWNER = 'session-orchestrator'
const exec = { agent: { id: OWNER }, signal: new AbortController().signal}

/**
 * A tool result must be lossless JSON. `JSON.stringify` drops undefined
 * silently, so round-tripping alone is not enough — walk the value and reject
 * any `undefined` before it reaches the registry. This is what caught
 * squad_spawn's "invalid output" (a `last_tool: undefined` property).
 */
function assertLossless(value, path, toolName) {
	if (value === undefined) throw new Error(`${toolName}: ${path} is undefined (a tool result must be lossless JSON)`)
	if (value === null || typeof value !== 'object') return
	if (Array.isArray(value)) {
		value.forEach((item, i) => assertLossless(item, `${path}[${i}]`, toolName))
		return
	}
	for (const [key, child] of Object.entries(value)) assertLossless(child, `${path}.${key}`, toolName)
}

/** A model-facing summary must never leak a JS `undefined` into a labelled field. */
function assertNoUndefinedLabel(summary, toolName) {
	if (typeof summary !== 'string' || summary.length === 0) throw new Error(`${toolName}: empty summary`)
	const bad = summary.match(/<(?:worker|project|cwd|session_id|status|model|queued)>undefined</)
	if (bad) throw new Error(`${toolName}: summary renders ${bad[0]} — key shape mismatch`)
}

/** Call a tool and assert both invariants on every result. */
const call = async (name, args) => {
	const result = await byName.get(name).execute(args, exec)
	assertLossless(result, 'result', name)
	if (result && typeof result === 'object' && 'summary' in result) assertNoUndefinedLabel(result.summary, name)
	return result
}

const r1 = await call('squad_spawn', { name: 'reviewer', project: 'opencode-ai-reviewer' })
if (!r1.created) throw new Error('spawn did not create')
if (r1.worker.queued !== 0) throw new Error(`queued should be 0, got ${r1.worker.queued}`)
console.log(`  spawn reviewer      -> ${r1.worker.session_id}  queued=${r1.worker.queued}  status=${r1.worker.status}`)

await call('squad_spawn', { name: 'performance', project: 'performance-optimisation' })
const dup = await call('squad_spawn', { name: 'reviewer', project: 'opencode-ai-reviewer' })
if (dup.created) throw new Error('re-spawn must adopt, not create')
console.log('  re-spawn reviewer   -> adopted (idempotent)')

const duoport = await call('squad_spawn', { name: 'duoport', cwd: '/home/admin/duoport-connect-for-opencode' })
if (duoport.worker.project !== 'duoport-connect-for-opencode') throw new Error('cwd did not register a workspace')
console.log(`  spawn duoport       -> registered workspace "${duoport.worker.project}"`)

const list = await call('squad_list', {})
if (list.workers.length !== 3) throw new Error(`expected 3 workers, got ${list.workers.length}`)
console.log(`  squad_list          -> ${list.workers.length} workers, none threw`)

// The roster summary must carry the real session id and model. It previously
// rendered `session_id: undefined` and `model: undefined/space-bunny-free`
// because render() read the internal record's keys while being handed a view.
if (list.summary.includes('undefined')) throw new Error(`roster summary contains "undefined":\n${list.summary}`)
if (!list.summary.includes(list.workers[0].session_id)) throw new Error(`roster summary lost session id:\n${list.summary}`)
// With no route pinned the worker inherits the session default, and the roster
// must SAY that rather than render an empty `<model></model>`.
if (!list.summary.includes('<model>session default</model>')) {
	throw new Error(`roster summary did not state the inherited route:\n${list.summary}`)
}
if (list.workers[0].model !== null) throw new Error(`unpinned worker reported model ${list.workers[0].model}`)
console.log('  roster summary     -> session id + inherited route both rendered')

// a worker that is mid-turn with queued input
const busyId = list.workers[0].session_id
const busy = agents.get(busyId)
busy.status = 'running'
busy.inbox.nextTurn.push({})
busy.inbox.nextStep.push({}, {})
const busyView = await call('squad_status', { name: list.workers[0].name })
if (busyView.worker.queued !== 3) throw new Error(`expected queued=3, got ${busyView.worker.queued} (inbox key names wrong?)`)
if (busyView.worker.status !== 'working') throw new Error(`expected working, got ${busyView.worker.status}`)
console.log(`  squad_status busy   -> queued=3 status=working (inbox keys correct)`)

// an Agent with no inbox at all must degrade, not throw
const noInbox = makeAgent('session-noinbox')
delete noInbox.inbox
agents.set(noInbox.id, noInbox)
await call('squad_spawn', { name: 'degenerate', project: 'opencode-ai-reviewer' })
const deg = await call('squad_status', { name: 'degenerate' })
if (deg.worker.queued !== 0) throw new Error('missing inbox must degrade to 0')
console.log('  degenerate Agent    -> queued=0, did not throw')

// squad_wait must NOT return merely because a worker is making progress. The
// earlier implementation tracked raw log growth and fired on every progress
// tick, which would spam the orchestrator during a long task.
const quiet = await call('squad_wait', { names: ['degenerate'], timeout_ms: 2_500 })
if (quiet.timedOut !== true) throw new Error('squad_wait returned for a worker that only had no news')
console.log('  squad_wait quiet    -> timed out, did not fire on progress')

// assign (queue) then steer
await call('squad_assign', { name: 'reviewer', task: 'audit the plugin', mode: 'queue' })
await call('squad_assign', { name: 'reviewer', task: 'focus on the cache layer', mode: 'steer' })
if (prompted.length !== 2) throw new Error(`expected 2 prompts, got ${prompted.length}`)
if (prompted[0].mode !== 'queue' || prompted[1].mode !== 'steer') throw new Error('prompt mode not forwarded')
console.log(`  assign queue+steer  -> ${prompted.length} prompts with modes ${prompted.map(p => p.mode).join(',')}`)

// The reply must distinguish "queued behind the running turn" from "started
// now because it was idle". Saying "Queued" for both is what made a queue sent
// to an idle worker look identical to a steer.
agents.get(list.workers[0].session_id).status = 'idle'
const queuedIdle = await call('squad_assign', { name: list.workers[0].name, task: 'probe A', mode: 'queue' })
if (!/idle/.test(queuedIdle.delivery)) throw new Error(`queue-to-idle said: ${queuedIdle.delivery}`)

const busyAgent = agents.get(list.workers[0].session_id)
busyAgent.status = 'running'
busyAgent.inbox.nextTurn.push({})
const queuedBusy = await call('squad_assign', { name: list.workers[0].name, task: 'probe B', mode: 'queue' })
if (!/queued behind/.test(queuedBusy.delivery)) throw new Error(`queue-to-busy said: ${queuedBusy.delivery}`)

const steeredBusy = await call('squad_assign', { name: list.workers[0].name, task: 'probe C', mode: 'steer' })
if (!/injected into the turn/.test(steeredBusy.delivery)) throw new Error(`steer-to-busy said: ${steeredBusy.delivery}`)

busyAgent.status = 'idle'
const steeredIdle = await call('squad_assign', { name: list.workers[0].name, task: 'probe D', mode: 'steer' })
if (!/started a turn/.test(steeredIdle.delivery)) throw new Error(`steer-to-idle said: ${steeredIdle.delivery}`)
console.log('  delivery wording    -> queue/steer x idle/busy all distinguished')

// worker reports back
const workerSession = list.workers[1].session_id
const workerExec = { agent: { id: workerSession }, signal: undefined }
await byName.get('squad_report').execute(
	{ status: 'done', summary: 'optimised the cache warmup path', details: 'added early hints', artifacts: ['inc/class-warmup.php'] },
	workerExec
)
const afterReport = await call('squad_collect', { name: 'performance' })
if (afterReport.reports.length !== 1) throw new Error('report not collected')
if (afterReport.status !== 'reported') throw new Error(`expected reported, got ${afterReport.status}`)
console.log(`  squad_report+collect-> status=${afterReport.status} reports=${afterReport.reports.length}`)

// Now that a report is on file, squad_wait must return promptly rather than
// blocking for its whole timeout.
const before = Date.now()
const waitFast = await call('squad_wait', { names: ['performance'], timeout_ms: 30_000 })
const waitedMs = Date.now() - before
if (waitFast.timedOut === true) throw new Error('squad_wait timed out despite a worker needing attention')
if (waitedMs > 5_000) throw new Error(`squad_wait took ${waitedMs}ms to notice an existing report`)
console.log(`  squad_wait report   -> returned in ${waitedMs}ms`)

// worker escalates
await byName.get('squad_escalate').execute(
	{ question: 'drop the legacy shim or keep it?', options: ['drop', 'keep'] },
	workerExec
)
const escalated = await call('squad_status', { name: 'performance' })
if (escalated.worker.unread_escalations !== 1) throw new Error(`expected 1 unread escalation, got ${escalated.worker.unread_escalations}`)

// Steering is how the orchestrator answers an escalation; that must clear the
// unread count without a separate acknowledgement tool.
await call('squad_assign', { name: 'performance', task: 'keep it, but mark it deprecated', mode: 'steer' })
const answered = await call('squad_status', { name: 'performance' })
if (answered.worker.unread_escalations !== 0) throw new Error(`steer did not clear the escalation (${answered.worker.unread_escalations} left)`)
console.log('  escalate+steer      -> unread 1 then cleared by steer')

// collect afterwards still reports the escalation, now as answered
const afterEsc = await call('squad_collect', { name: 'performance' })
if (afterEsc.escalations.length !== 1) throw new Error('escalation not collected')
if (afterEsc.escalations[0].answered !== true) throw new Error('escalation should read as answered')
console.log(`  squad_collect       -> ${afterEsc.escalations.length} escalation, answered`)

// orphan ask_user_question must surface as needs-answer
const stuckId = list.workers[2].session_id
appendEvent(stuckId, { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question', arguments: '{}' } })
agents.get(stuckId).status = 'running'
const stuckView = await call('squad_status', { name: 'duoport' })
if (stuckView.worker.status !== 'needs-answer') throw new Error(`expected needs-answer, got ${stuckView.worker.status}`)
console.log(`  orphan question     -> status=${stuckView.worker.status}`)

// stop + close use the object cancel cause
await call('squad_stop', { name: 'reviewer', keep_queued: true })
if (cancelled.length === 0 || cancelled[0].cause.kind !== 'hook') throw new Error('squad_stop cancel cause wrong')
console.log(`  squad_stop          -> cancel cause {kind:${cancelled[0].cause.kind}, reason:${cancelled[0].cause.reason}}`)

await call('squad_close', { name: 'reviewer' })
const afterClose = await call('squad_list', {})
if (afterClose.workers.some(w => w.name === 'reviewer')) throw new Error('close did not remove the worker')
console.log(`  squad_close         -> roster now ${afterClose.workers.length} workers`)

// ownership must be enforced
try {
	await byName.get('squad_assign').execute({ name: 'performance', task: 'x', mode: 'queue' }, { agent: { id: 'session-intruder' } })
	throw new Error('ownership check did not fire')
} catch (error) {
	if (!String(error.message).includes('belongs to orchestrator')) throw error
}
console.log('  ownership enforced  -> intruder refused')

// ---- pass 3: persistence across a plugin reload ---------------------------
// This is the failure that cost real work: every bundle patch reload disposes
// and re-applies the plugin, which built a fresh empty roster and lost the fleet
// mid-campaign. A second host with a fresh in-memory registry must restore it.
const statePath = join(STATE_HOME, 'squad', 'roster.json')
const onDisk = JSON.parse(readFileSync(statePath, 'utf8'))
const savedNames = onDisk.workers.map(w => w.name).sort()
if (!savedNames.includes('performance')) throw new Error(`roster not written to disk: ${savedNames.join(', ')}`)
if (onDisk.workers.every(w => typeof w.cwd !== 'string' || w.cwd.length === 0)) throw new Error('cwd not persisted (re-adoption would throw ApiSessionCwdConflict)')
console.log(`  roster on disk      -> ${savedNames.join(', ')}`)

const host2 = makeHost()
apply(host2.ctx, Config({}))
const byName2 = new Map(host2.registered.map(t => [t.name, t]))
const list2 = await byName2.get('squad_list').execute({}, { agent: { id: OWNER }, signal: new AbortController().signal })
if (list2.workers.length !== afterClose.workers.length) {
	throw new Error(`reload lost the fleet: ${list2.workers.length} workers restored, expected ${afterClose.workers.length}`)
}
if (!list2.workers.every(w => w.status === 'dormant')) {
	throw new Error(`restored workers should be dormant until re-attached, got ${list2.workers.map(w => w.status).join(', ')}`)
}
console.log(`  after reload        -> ${list2.workers.length} workers restored as dormant`)

// Re-adoption must work, and must be attempted with the ORIGINAL cwd — passing a
// different cwd makes the real Host throw ApiSessionCwdConflict.
const reAdopt = await byName2.get('squad_spawn').execute(
	{ name: 'performance', project: 'performance-optimisation' },
	{ agent: { id: OWNER }, signal: new AbortController().signal }
)
if (reAdopt.created !== false) throw new Error('re-spawn after reload must adopt, not create')
if (reAdopt.worker.status === 'dormant') throw new Error('re-spawn did not re-attach the restored worker')
console.log(`  re-adoption         -> performance re-attached (${reAdopt.worker.status})`)

// With the wrong cwd the real Host refuses; assert our mock models that, so the
// constraint stays visible if the adoption path is ever changed.
try {
	await host.ctx.sessionController.create({ sessionId: "session-test-1", cwd: "/definitely/not/the/original" })
	throw new Error('cwd conflict was not raised — the mock no longer models the real constraint')
} catch (error) {
	if (!String(error.message).includes('ApiSessionCwdConflict')) throw error
}
console.log('  cwd constraint      -> mismatched cwd still rejected')

// Workers must carry a durable identity marker, and that marker must stand in
// for the roster: losing the state file must not spawn duplicate sessions.
if (!renamed.some(r => r.title.startsWith('squad:'))) throw new Error('spawn did not title the worker session')
const titledNames = [...titles.values()].filter(t => t.startsWith('squad:')).map(t => t.slice(6)).sort()
if (!titledNames.includes('performance')) throw new Error(`expected a squad:performance title, got ${titledNames.join(', ')}`)
console.log(`  durable titles      -> ${titledNames.join(', ')}`)

// Recovery with NO saved roster: the state file is gone, but the sessions and
// their titles survive, so spawn must ADOPT rather than create a duplicate.
const emptyHome = mkdtempSync(join(tmpdir(), 'squad-test-empty-'))
process.env.DSH_HOME = emptyHome
const host3 = makeHost()
for (const [id, agent] of agents) host3.agents.set(id, agent)
for (const [id, title] of titles) host3.titles.set(id, title)
apply(host3.ctx, { pollMs: 60 })
const byName3 = new Map(host3.registered.map(t => [t.name, t]))
const createdBefore = host3.created.length
const recoveredSpawn = await byName3.get('squad_spawn').execute(
	{ name: 'performance', project: 'performance-optimisation' },
	{ agent: { id: OWNER }, signal: new AbortController().signal }
)
if (host3.created.length !== createdBefore) throw new Error('recovery created a NEW session instead of adopting the titled one')
if (recoveredSpawn.created !== false) throw new Error('recovery should report created:false')
if (recoveredSpawn.worker.status === 'dormant') throw new Error('recovered worker was not attached')
console.log(`  roster-loss recovery-> adopted ${recoveredSpawn.worker.session_id} with no new session`)

// Address a worker by session id, not just by name.
const byId = await byName3.get('squad_status').execute(
	{ name: recoveredSpawn.worker.session_id },
	{ agent: { id: OWNER }, signal: new AbortController().signal }
)
if (byId.worker.name !== 'performance') throw new Error(`session-id lookup resolved to ${byId.worker.name}`)
console.log('  address by id       -> session id resolves to the same worker')

// ---- pass 5: resume the fleet --------------------------------------------
// squad_resume is what the orchestrator calls when asked to continue. It must
// re-attach dormant workers, spot a turn that never closed, and only re-prompt
// the genuinely interrupted ones.
const resumeExec = { agent: { id: OWNER }, signal: new AbortController().signal }

// 'performance' is mid-task: a turn started and the process died before it ended.
host3.appendEvent(recoveredSpawn.worker.session_id, { type: 'turn/start', data: { turn: 7 } })
// 'duoport' is genuinely between tasks: a balanced turn.
const duoportSpawn = await byName3.get('squad_spawn').execute(
	{ name: 'duoport', cwd: '/home/admin/duoport-connect-for-opencode' },
	resumeExec
)
host3.appendEvent(duoportSpawn.worker.session_id, { type: 'turn/start', data: { turn: 1 } })
host3.appendEvent(duoportSpawn.worker.session_id, { type: 'turn/end', data: { turn: 1 } })

const resumed = await byName3.get('squad_resume').execute({ reprompt: true }, resumeExec)
if (resumed.workers.length !== 2) throw new Error(`resume covered ${resumed.workers.length} workers, expected 2`)
if (resumed.interrupted !== 1) throw new Error(`expected exactly 1 interrupted worker, got ${resumed.interrupted}`)
if (resumed.reprompted !== 1) throw new Error(`expected 1 reprompt, got ${resumed.reprompted}`)
const interruptedWorker = resumed.workers.find(w => w.interrupted)
if (interruptedWorker.name !== 'performance') throw new Error(`wrong worker flagged interrupted: ${interruptedWorker.name}`)
const balancedWorker = resumed.workers.find(w => w.name === 'duoport')
if (balancedWorker.interrupted) throw new Error('a worker with a balanced log was wrongly flagged interrupted')
console.log(`  squad_resume        -> ${resumed.interrupted} interrupted, ${resumed.reprompted} reprompted (idle worker untouched)`)

// Without reprompt, resume must inspect only — never invent work.
const promptedBefore = host3.prompted.length
const inspectOnly = await byName3.get('squad_resume').execute({}, resumeExec)
if (host3.prompted.length !== promptedBefore) throw new Error('resume without reprompt still dispatched a prompt')
if (inspectOnly.interrupted !== 1) throw new Error('inspect-only resume lost the interrupted signal')
console.log('  resume (no reprompt)-> inspected without dispatching')

// ---- pass 6: structured artifacts and parallel gather ---------------------
// String({...}) on a structured artifact produced the literal "[object Object]",
// which is what reached the orchestrator in real reports.
const artifactValue = { path: 'inc/class-rest.php', note: 'line 115 bare literal' }
await byName3.get('squad_report').execute(
	{ status: 'done', summary: 'audited', artifacts: ['plain-string.php', artifactValue] },
	{ agent: { id: recoveredSpawn.worker.session_id }, signal: undefined }
)
const withArtifacts = await byName3.get('squad_collect').execute({ name: 'performance' }, resumeExec)
const arts = withArtifacts.reports.at(-1).artifacts
if (arts.some(a => a.includes('[object Object]'))) throw new Error(`structured artifact destroyed: ${JSON.stringify(arts)}`)
if (!arts.some(a => a.includes('class-rest.php'))) throw new Error('structured artifact content lost')
if (!arts.includes('plain-string.php')) throw new Error('plain string artifact altered')
console.log(`  artifacts preserved -> ${arts.length} items, no "[object Object]"`)

// ---- pass 8: a worker report must WAKE the orchestrator -------------------
// The original defect: squad_report wrote to the roster and returned, so an idle
// orchestrator never learned the task had finished and the report looked lost.
const wakesToOwner = () => host3.prompted.filter(p => p.sessionId === OWNER)
const wakesBefore = wakesToOwner().length
const reportResult = await byName3.get('squad_report').execute(
	{ status: 'done', summary: 'wake test', artifacts: ['x'] },
	{ agent: { id: recoveredSpawn.worker.session_id }, signal: undefined }
)
const wakes = wakesToOwner()
if (wakes.length !== wakesBefore + 1) throw new Error(`report sent ${wakes.length - before} wake-up(s), expected 1`)
if (reportResult.orchestrator_notified !== true) throw new Error('report did not report a successful wake')
const wake = wakes.at(-1)
if (wake.mode !== 'queue') throw new Error(`wake used mode "${wake.mode}", expected queue`)
const wakeText = wake.content.map(c => c.text).join(' ')
if (!wakeText.includes('[SQUAD]')) throw new Error('wake message is not labelled [SQUAD]')
if (!wakeText.includes('squad_collect')) throw new Error('wake message does not tell the orchestrator to collect')
if (wake.sessionId !== OWNER) throw new Error('wake went to the wrong session')
console.log('  report wakes owner  -> queued [SQUAD] notification telling it to collect')

// An escalation is a worker that produces nothing until answered, so it must wake
// the orchestrator too.
const beforeEsc = wakesToOwner().length
const escResult = await byName3.get('squad_escalate').execute(
	{ question: 'Which branch should I target?', context: 'two candidates' },
	{ agent: { id: recoveredSpawn.worker.session_id }, signal: undefined }
)
const escWakes = wakesToOwner()
if (escWakes.length !== beforeEsc + 1) throw new Error('escalation did not wake the orchestrator')
if (escResult.orchestrator_notified !== true) throw new Error('escalation did not report a successful wake')
const escText = escWakes.at(-1).content.map(c => c.text).join(' ')
if (!escText.includes('BLOCKED')) throw new Error('escalation wake does not say the worker is blocked')
if (!escText.includes('steer')) throw new Error('escalation wake does not tell the orchestrator to steer')
console.log('  escalate wakes owner-> queued [SQUAD] BLOCKED notification with steer hint')

// And it must be switchable off, for an orchestrator that prefers to poll.
const quietHost = makeHost()
for (const [id, ag] of agents) quietHost.agents.set(id, ag)
for (const [id, t] of titles) quietHost.titles.set(id, t)
process.env.DSH_HOME = emptyHome
apply(quietHost.ctx, { notifyOnReport: false })
const quietByName = new Map(quietHost.registered.map(t => [t.name, t]))
const quietSpawn = await quietByName.get('squad_spawn').execute({ name: 'quiet', project: 'performance-optimisation' }, { agent: { id: OWNER }, signal: new AbortController().signal })
const quietBefore = quietHost.prompted.filter(p => p.sessionId === OWNER).length
const quietResult = await quietByName.get('squad_report').execute(
	{ status: 'done', summary: 'silent' },
	{ agent: { id: quietSpawn.worker.session_id }, signal: undefined }
)
if (quietResult.orchestrator_notified !== false) throw new Error('report claimed a wake while notification was disabled')
if (quietHost.prompted.filter(p => p.sessionId === OWNER).length !== quietBefore) throw new Error('notifyOnReport:false still woke the orchestrator')
console.log('  notify off          -> report stayed silent when configured off')

// mode:"all" must wait for every worker, not return on the first one that
// reports — that is what serialised the orchestrator's gather into one turn per
// worker even though the fan-out was already parallel.
const perfAgent = host3.agents.get(recoveredSpawn.worker.session_id)
const duoAgent = host3.agents.get(duoportSpawn.worker.session_id)
perfAgent.status = 'running'
duoAgent.status = 'idle'
const allWaiting = await byName3.get('squad_wait').execute({ names: ['performance', 'duoport'], mode: 'all', timeout_ms: 2_500 }, resumeExec)
if (allWaiting.timedOut !== true) throw new Error("mode 'all' returned while a worker was still working")
console.log('  squad_wait all      -> held while a worker was still working')

perfAgent.status = 'idle'
const allSettled = await byName3.get('squad_wait').execute({ names: ['performance', 'duoport'], mode: 'all', timeout_ms: 5_000 }, resumeExec)
if (allSettled.timedOut === true) throw new Error("mode 'all' timed out with every worker settled")
if (allSettled.settled !== allSettled.workers.length) throw new Error(`settled ${allSettled.settled}/${allSettled.workers.length}`)
console.log(`  squad_wait all      -> returned once all ${allSettled.settled} workers settled`)

// A worker blocked on a question must not deadlock an 'all' gather.
perfAgent.status = 'running'
host3.appendEvent(recoveredSpawn.worker.session_id, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question', arguments: '{}' } })
const blockedGather = await byName3.get('squad_wait').execute({ names: ['performance', 'duoport'], mode: 'all', timeout_ms: 4_000 }, resumeExec)
if (blockedGather.timedOut === true) throw new Error("mode 'all' deadlocked on a worker that needs an answer")
console.log('  squad_wait all      -> released on a blocked worker instead of deadlocking')

// squad_watch must return IMMEDIATELY with a job id, so the orchestrator is free
// to do other work while the fleet finishes — the whole point of the tool.
// Uses duoport: `performance` is deliberately left blocked on a question by the
// check above, and a blocked worker correctly short-circuits the watch.
duoAgent.status = 'running'
const watched = await byName3.get('squad_watch').execute({ names: ['duoport'], mode: 'all', timeout_ms: 60_000 }, resumeExec)
if (watched.watching !== true) throw new Error(`squad_watch did not start a background watch: ${JSON.stringify(watched).slice(0, 300)}`)
if (typeof watched.job_id !== 'string' || !watched.job_id.startsWith('squad-')) throw new Error(`bad job id: ${watched.job_id}`)
const watchJob = host3.startedJobs.at(-1)
if (watchJob.spec.kind !== 'squad') throw new Error(`job kind was ${watchJob.spec.kind}`)
if (watchJob.spec.owner !== OWNER) throw new Error('job was not owned by the orchestrator session')
if (typeof watchJob.hooks.cancel !== 'function' || typeof watchJob.hooks.done?.then !== 'function') throw new Error('run() did not return { cancel, done }')
console.log(`  squad_watch         -> returned ${watched.job_id} immediately, orchestrator free`)

// It must settle once the watched worker stops working…
duoAgent.status = 'idle'
const outcome = await watchJob.hooks.done
if (outcome.status !== 'completed') throw new Error(`watch settled ${outcome.status}: ${outcome.detail}`)
if (typeof outcome.result !== 'string' || outcome.result.length === 0) throw new Error('watch settled without a result')
if (watchJob.chunks.length === 0) throw new Error('watch appended nothing to the job output ring')
console.log('  squad_watch         -> settled completed with a readable result')

// …and a watch on an already-settled fleet must not start a job at all.
const idleWatch = await byName3.get('squad_watch').execute({ names: ['duoport'], mode: 'all' }, resumeExec)
if (idleWatch.watching !== false) throw new Error('watch started a job for an already-settled fleet')
console.log('  squad_watch         -> answered inline when nothing was pending')

// A PINNED route must be reported verbatim, so "pinned to X" and "not pinned" are
// distinguishable without guessing.
const pinnedHome = mkdtempSync(join(tmpdir(), 'squad-test-pinned-'))
process.env.DSH_HOME = pinnedHome
const pinnedHost = makeHost()
apply(pinnedHost.ctx, { defaultProvider: 'acme', defaultModel: 'vision-1', defaultReasoningEffort: 'max' })
const pinnedByName = new Map(pinnedHost.registered.map(t => [t.name, t]))
const ownerExec = { agent: { id: OWNER }, signal: new AbortController().signal }
const pinnedSpawn = await pinnedByName.get('squad_spawn').execute({ name: 'pinned', project: 'performance-optimisation' }, ownerExec)
if (pinnedSpawn.worker.model !== 'acme/vision-1') throw new Error(`pinned worker reported model ${pinnedSpawn.worker.model}`)
console.log('  pinned route       -> reported as acme/vision-1')

console.log('\nPASS 2: all execute bodies ran clean')
console.log('PASS 3: roster survives a plugin reload and re-adopts')
console.log('PASS 4: a lost roster recovers by durable title instead of duplicating')
console.log('PASS 5: resume re-attaches, detects interrupted turns, and is inspect-only by default')
console.log('PASS 6: artifacts survive structured values, and mode:"all" gathers a fan-out')
console.log('PASS 7: squad_watch runs in the background and answers inline when settled')
console.log('PASS 8: a worker report or escalation WAKES an idle orchestrator')
