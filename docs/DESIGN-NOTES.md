# Squad — Research & Implementation Plan

**Status: research only.** No code has been changed. Nothing in this document
has been applied. The running agent was not interrupted.

Mapped against your list, plus what **Munder Difflin** does
([munderdiffl.in](https://munderdiffl.in/), [github](https://github.com/chaitanyagiri/munder-difflin))
— a local multi-agent harness that wraps existing CLI agents with a mailbox,
per-agent inboxes, a shared task board, automations, and an "Ask me" queue.

---

## 1. Platform findings — the four that matter

### 🟢 Finding 1: DSH ships a fully-built scheduler, and it is switched off

`@deepseek-ai/dsh-schedule` provides the service, four model-facing tools, and a
UI. It is present in the installation and **disabled by default**:

```yaml
- id: schedule
  name: '@deepseek-ai/dsh-schedule'
  disabled: true            # ← composed profile, no override anywhere
- id: ui-schedule
  name: '@deepseek-ai/dsh-client-ui-schedule'
  disabled: true
```

What it can do:

```ts
schedule.create(sessionId, request, signal?) → ScheduleRecord

ScheduleCreateRequest {
  prompt: string          // "Reminder content to present when the target becomes due"
  title: string           // ≤120 chars, names the card
  after_seconds? | at? | every_seconds? | daily? | weekly? | cron?
}
```

Tools exposed when enabled: `schedule_create`, `schedule_list`, `schedule_delete`,
`schedule_update`. Delivery targets **any session id**, so it can prompt a worker
or the orchestrator.

This covers two of your items directly: *"schedule timer which asks the main
orchestrator to check status of all agents"* and *"before assigning new task it
checks status, send task on queue so it only checks after current work is
complete"* — a delayed `after_seconds` assignment is native.

**Caveat:** `schedule` is off in the shipped base composition. It may be opt-in
for a reason, and enabling may need more than the single row (the Loader pattern
is `disabled: false` override + insert any rows it depends on). First task is a
spike to enable it in isolation and confirm the tools appear.

### 🟢 Finding 2: auto-continuation already exists and is already on

`goal` + `goal-round-driver` + `tool-goal` are **enabled right now**. From its README:

> automatically continues an active goal in the same session **while the agent is
> idle**, continuation is armed, and the configured round allowance remains. Each
> round gives the model another turn toward the objective; only goal rounds that
> reach model history consume the allowance, and exhaustion records a blocker.

This is your *"check if the main agent has stopped or been interrupted, and ask it
to continue"* — built in, bounded by `max_goal_rounds` on the goal itself. It has
no configuration of its own.

So the answer here is **not "build it"** but **"make the orchestrator use it"** —
the orchestrator prompt should create a goal for the engagement. That is a prompt
change plus, optionally, the plugin creating the goal on the orchestrator's behalf.

### 🟡 Finding 3: per-worker personas are possible without hand-writing presets

`PresetDefinition` is exactly a patch row's `config`:

```ts
interface PresetDefinition {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: readonly EntryOptions[]
}
```

and `agentPresets.register(definition)` is a Host service method returning an
unregister disposer.

So a plugin can **synthesise a preset at runtime**: take the standard plugin list,
swap in a custom persona, register it, and pass its id to
`sessionController.create({ agentPreset })`.

This is the clean path to your *"each team member has a different persona, each for
specific work"*. Today `squad_spawn` already accepts a `preset` argument, but the
presets must be hand-written patch rows — so every new role is a YAML edit and a
bundle reload. Runtime registration turns that into a `persona` string argument.

### 🔴 Finding 4: Agent Teams cannot give us a cross-worker task board

This one is a hard blocker for the obvious approach, and worth knowing before
anyone tries it. From the Agent Teams README:

> Choose it when several agents must cooperate on **one shared workspace** and
> their roster, messages, and task state must survive crashes and restarts.
> **Avoid it when teammates need separate working directories, when several
> processes must coordinate over one team**, or when a task owner should be
> released automatically — **none of those are supported.**

> The Lead Session log is the single source of truth; roster, mailbox, and task
> state are replayed from it on every read.

Our workers are separate sessions in **separate workspaces** — precisely the case
the README says to avoid. Each worker would be its own Lead with its own private
board; boards do not merge across sessions.

**Therefore a shared task board must be owned by our plugin.** That is the single
largest piece of new work in this plan.

---

## 2. Your list, scored

| You asked for | Verdict | Effort |
|---|---|---|
| Per-member personas for specific work | 🟡 Buildable cheaply via runtime preset registration | **S** |
| Shared todo / task board across workers | 🔴 Must be built in the plugin (Agent Teams can't) | **L** |
| Scheduler that queues work for later / when idle | 🟢 Platform has it; needs enabling + wiring | **S** |
| Check status before assigning; queue so it runs after current work | 🟢 `mode: "queue"` already does this exactly | **Done** |
| Timer asking the orchestrator to check all agents | 🟢 `schedule_create` on the orchestrator session | **S** |
| Detect main agent stopped/interrupted → resume | 🟢 Goals + round driver, already enabled | **S** (prompt) |
| Circuit breaker on runaway spend | 🔴 Nothing in the platform; must be built | **M** |
| Crashed agent restarts with work intact | 🟡 Sessions persist; **our roster does not** | **M** |
| Long-term memory per agent | 🟡 Not researched in depth; `dsh-simple-memory` is installed | **?** |

---

## 3. Phased plan

Ordered so that each phase is independently useful and nothing later is blocked
by nothing earlier.

### Phase 0 — unblock writes *(prerequisite for everything real)*

**Problem.** New sessions get `approval: 'ask'`, and nothing answers a worker's
prompt, so any write or mutating shell command hangs the worker forever.

**Do.** Set workers' approval policy to `never` on spawn
(`approval.setPolicy(agent, 'never')`; `ApprovalPolicy = 'ask' | 'never'`), and
fix the sandbox root — `sandbox-policy.workspaceRoot` is `!!js process.cwd()`,
which is `/opt/dsh`, the *installation directory*, not a project.

**Decide:** per-worker policy (targeted, low risk) vs
`DSH_PERMISSION_MODE=danger-full-access` in the systemd unit (global; also fixes
the sandbox root). I prefer both.

**Risk:** low. **This gates every write task.**

### Phase 1 — per-worker personas *(biggest workflow win for the effort)*

**Do.**
1. `squad_spawn` gains a `persona` argument (and keeps `preset` for full presets).
2. On spawn: clone the standard plugin list, substitute the persona text, call
   `agentPresets.register({ id: 'squad-<name>-<hash>', plugins })`, pass the id to
   `create({ agentPreset })`.
3. Keep the registration disposer so `squad_close` can unregister it.
4. Optionally ship a few named role templates (reviewer, implementer, auditor,
   researcher) as text the orchestrator can pick from or override.

**Why it matters.** This is what makes Munder Difflin's team feel like a team: an
auditor and an implementer are different *agents*, not the same worker with a
different task. It also improves report quality — the persona is where the output
contract lives.

**Risk:** medium — runtime registration is a new mechanism; needs a spike to
confirm register→create→run works end-to-end.

### Phase 2 — shared task board *(the largest piece)*

**Problem.** Workers are separate sessions; there is no shared board.

**Do.** Own it in the plugin:
- `squad_task_create { title, description, assignee?, blocked_by?, write_scopes? }`
- `squad_task_list { status?, assignee? }`
- `squad_task_update { id, action: claim|complete|reopen|edit, expected_revision }`
- A `squad_tasks` tool the **worker** calls to see its own queue and claim work.

**Design decisions to settle first:**
- **Storage.** The roster is in-memory and not persisted, so a board stored there
  dies on restart. Options: (a) persist both to a JSON file under `$DSH_HOME`;
  (b) model it on the Agent Teams approach and make one session log authoritative;
  (c) SQLite via the `sessionQuery`/`storage` services. **(a)** is simplest and
  also fixes the roster-persistence problem in one move.
- **Who owns task state.** Today `squad_assign` is fire-and-forget. A board means
  assignment becomes a record with a lifecycle, and `squad_collect` updates it.
- **Overlap detection.** Agent Teams derives write-scope warnings from declared
  scopes. Worth copying if two workers can touch one repo.

**Risk:** medium-high. This is real feature work, and it needs the persistence
decision made deliberately — not guessed, which is how the last four bugs happened.

### Phase 3 — scheduler + orchestrator heartbeat

**Do.**
1. Spike: enable `- id: schedule` (+ `ui-schedule`) with `disabled: false` and
   confirm `schedule_create` and the UI appear.
2. Add `squad_schedule` wrappers so the orchestrator can set a check-in without
   knowing session ids: every N minutes, or "in 30 minutes", deliver
   *"check the fleet and act"* to the orchestrator's own session.
3. Optionally schedule a **deferred assignment** — `after_seconds` on a worker —
   which is your "pin a task and run it later when idle".

**Caution:** a recurring self-prompt wakes the orchestrator and spends tokens
every tick. Needs a bounded cadence, a stop condition, and probably a maximum
number of check-ins. This is exactly the runaway-spend risk Munder Difflin
guards with a circuit breaker.

**Risk:** low technically; medium on cost discipline.

### Phase 4 — goals as the engagement driver

**Do.** Have the orchestrator create a goal for the engagement at the start
(`create_goal { objective, max_goal_rounds }`), so the round driver continues it
while idle and stops cleanly when rounds are exhausted.

Pair it with Phase 3: the goal handles *"keep going"*, the schedule handles
*"wake up and look"*. They compose — the goal for intent, the schedule for cadence.

**Risk:** low. Mostly prompt design; already enabled.

### Phase 5 — persistence and recovery

**Do.** Persist the roster (and the Phase 2 board) to `$DSH_HOME`. On plugin
activation, reload and re-adopt worker sessions with
`sessionController.create({ sessionId })`.

**Must settle:** ownership after restart. Currently a worker is locked to the
session that spawned it, and a *new* orchestrator session cannot touch it. The
sensible rule is *ownership is enforced only while the owning session is alive*,
but that is a design decision, not an implementation detail.

**Risk:** medium — depends on `ensureSession`'s adoption semantics, which should
be read from source rather than assumed.

### Phase 6 — spend circuit breaker

**Do.** A plugin-side guard: count assignments/rounds per worker and per
engagement, warn the orchestrator at a threshold, hard-stop at a ceiling. The
`tokenMeter` service (`measure(session, requestHeader?)`) can attribute usage.

**Risk:** low-ish; the design question is what "too much" means.

---

## 4. Recommended sequence

```
Phase 0  unblock writes              ← nothing real works without this
Phase 1  per-worker personas         ← best value per unit of effort
Phase 4  goals as engagement driver  ← cheap, already enabled, prompt-level
Phase 3  scheduler + heartbeat       ← cheap, after a spike
Phase 5  persistence + recovery      ← unlocks long-running fleets
Phase 2  shared task board           ← largest; needs the persistence decision
Phase 6  spend breaker               ← only once fleets run unattended
```

Rationale: Phases 4 and 3 are cheap and immediately make unattended operation
possible. Phase 2 is the biggest and should follow Phase 5, because a task board
without persistence is worse than no board — it would lose work on every restart.

---

## 5. Things I would advise against, and why

- **Don't build the board on Agent Teams.** Its README explicitly excludes
  separate working directories and multiple processes over one team. It would
  look like it works in a single-workspace test and fail exactly in our case.
- **Don't trust an inspect listing as proof of activation.** The Host `Service`
  catalog advertises `schedule` with a full method list even though the row is
  `disabled: true`. Verify activation behaviourally — call the tool.
- **Don't add features before Phase 0.** Every write task hangs today; adding
  scheduling on top of that just schedules hangs.
- **Don't hand-roll scheduling** before checking whether enabling `dsh-schedule`
  works. It already has cron, intervals, daily/weekly, a UI, delivery history, and
  a catalog.

---

## 6. Open questions for you

1. **Approval policy** — per-worker `never`, or global `danger-full-access`
   (which also fixes the `/opt/dsh` sandbox root)? Or both?
2. **Roles** — which personas do you actually want? The three projects differ
   (JS reviewer, WordPress plugin, PHP connector), so role may matter more than
   project.
3. **Board storage** — JSON file under `$DSH_HOME`, or an authoritative session
   log like Agent Teams? The first is simpler; the second survives crashes with
   the platform's own machinery.
4. **Autonomy ceiling** — how many unattended rounds/check-ins before the
   orchestrator must stop and ask you?
5. **Do workers need to see each other's tasks**, or is a board the orchestrator
   reads and assigns from enough? The former is much more work.
6. **Is a worker really meant to operate on a live production install?** A
   worker writes inside its own workspace, so pointing one at a production path
   gives it write access there. Decide that deliberately, per project.

---

## Appendix: verified facts used above

| Fact | Source |
|---|---|
| `schedule` + `ui-schedule` are `disabled: true`, no override | composed profile dump |
| `schedule_create/list/delete/update` exist in `dsh-schedule` | `lib/index.js:2117–2205` |
| `ScheduleCreateRequest` supports delay/interval/daily/weekly/cron | `dsh-schedule/lib/types/types.d.ts:306` |
| `goal`, `goal-round-driver`, `command-goal`, `tool-goal` are enabled | composed profile dump |
| Round driver continues while idle, bounded by goal rounds | `dsh-goal-round-driver/README.md` |
| `PresetDefinition = { id, name?, description?, order?, plugins }` | `dsh-agent-preset-registry/lib/types/definition.d.ts:4` |
| `agentPresets.register()` returns an unregister disposer | Host `Service` catalog |
| Agent Teams excludes separate working dirs / multi-process teams | `dsh-experimental-agent-team/README.md:32` |
| Team state is replayed from the Lead session log | same README:105 |
| `ApprovalPolicy = 'ask' \| 'never'` | `dsh-user-approval/lib/types/index.d.ts:54` |
| Default approval is `ask`; sandbox root is `process.cwd()` = `/opt/dsh` | composed profile dump |
