# Orchestrator Guide

Reference for writing a prompt for the **Orchestrator** agent preset. Written
for an author who has not used the system, so it states the mechanics first and
the prompt-design guidance second.

---

## 1. The mental model

A **worker** is a real, separate DSH session — not a subagent, not a teammate,
not a thread. It has:

- its own session id and durable log,
- its own workspace (a different `cwd` per project),
- the **full standard tool set** (read, write, edit, glob, grep, bash, skills,
  goals, subagents, agent-team tools),
- its own model, inherited from your session unless a route is pinned at spawn,
- a row in the normal workspace sidebar, so a human can open and read it.

Workers persist independently of the orchestrator. They are not children in a
call tree, and the orchestrator does not receive their output automatically.

Names are stable and **globally owned**: the orchestrator session that spawned a
worker is the only session that may control it. Re-spawning an existing name
returns the same worker rather than creating a second one.

## 2. Message flow — two directions, two mechanisms

```
ORCHESTRATOR  ──squad_assign──▶  worker session
                                    │
              ◀──squad_report ──────┤   (worker calls a tool)
              ◀──squad_escalate ────┘
```

- **Downward** is push. `squad_assign` calls the Host session API to inject a
  user message into the worker's session.
- **Upward** is *not* a return value. The worker must explicitly call
  `squad_report` (result) or `squad_escalate` (needs a decision). Those calls
  write into the plugin's roster, which the orchestrator reads with
  `squad_collect`.

**Consequence for prompt design:** a task is only complete when the worker
reports. If a worker finishes a turn without calling `squad_report`, it simply
goes `idle` and no report exists — see §6 for the fallback.

## 3. Tool reference

### Orchestrator tools

| Tool | Arguments | Semantics |
| --- | --- | --- |
| `squad_spawn` | `name`, `project` or `cwd`, `preset?` | Create or adopt a worker bound to a workspace. **Idempotent by name.** Registers an unknown `cwd` as a new workspace. Reads back the worker before succeeding; if that fails it cancels the session and drops the record, so a failed spawn leaves nothing behind. |
| `squad_list` | — | Cheap roster: name, project, status, queued count, `unread_reports`, `unread_escalations`. Poll this. |
| `squad_assign` | `name`, `task`, `mode` | Send work. See §4. The reply states exactly how it was delivered. |
| `squad_wait` | `names?`, `timeout_ms?` | Block until a worker needs attention or changes status. Default 120 s, capped at 600 s. Returns immediately if something already needs attention. |
| `squad_status` | `name` | One worker in detail: status, `last_tool`, `blocked_on_question`, `last_answer`, queued count. |
| `squad_collect` | `name`, `mark_read?` | Read reports, escalations and the last answer; marks them delivered. |
| `squad_stop` | `name`, `keep_queued?` | Cancel the active turn; optionally keep or discard queued work. |
| `squad_close` | `name` | Stop the worker and drop it from the roster. The session and log are retained. |

### Worker tools

| Tool | Arguments | Semantics |
| --- | --- | --- |
| `squad_report` | `status` (`done`/`partial`/`blocked`), `summary`, `details?`, `artifacts?` | Submit the result. `summary` is the payload the orchestrator reads. |
| `squad_escalate` | `question`, `options?`, `context?` | Ask the orchestrator for a decision. |

Both refuse when the calling session is not a squad worker, so they are harmless
in any other session.

## 4. Queue vs steer — the one concept to get right

`mode` decides **when** the message is consumed:

| | worker is idle | worker is mid-turn |
| --- | --- | --- |
| `queue` | starts a turn immediately | **waits**; becomes its own new turn when the current one ends |
| `steer` | starts a turn | **injected into the turn already running**, consumed at the next step boundary |

Mechanically: `queue` → the agent's `next-turn` inbox; `steer` → the `next-step`
inbox. The platform's own `QueueAction` type (`edit` | `remove` | `steer`) shows
the same model — a queued item is *promoted* to steering.

**The trap:** when a worker is idle, `queue` and `steer` behave almost
identically, so a queue sent to an idle worker looks like it was "sent now".
The difference is only observable while the worker is busy.

**Guidance for the prompt:**
- New task → `queue`.
- Redirect work in flight, or answer an escalation → `steer`.
- Do not steer merely to "make it start sooner" — an idle worker already starts.
- `squad_assign` replies with the delivery it chose, so the orchestrator can
  quote it rather than guess.

## 5. Status model

| Status | Meaning |
| --- | --- |
| `idle` | live, not in a turn, nothing reported yet |
| `working` | mid-turn and its log grew recently |
| `stuck` | mid-turn with **no log growth** for `stuckAfterMs` (default 15 min) |
| `reported` | not running, and at least one report exists |
| `needs-answer` | its log has an `ask_user_question` call with no result — it is wedged until the orchestrator answers |
| `closed` | no live agent for that session |

`stuck` is a heuristic: a worker reasoning for a long time without tool calls can
trip it. Treat it as "go and look", not "it has failed".

`needs-answer` matters because workers are told **not** to ask the human. An
orphaned question would otherwise wedge a worker silently forever.

## 6. The orchestration loop

```
1. squad_spawn   one worker per project (idempotent — safe to re-run)
2. squad_assign  a task, stating the expected report
3. squad_wait    block until something needs attention
4. squad_collect read the report / escalation
5. verify        check the claim with your OWN tools
6. decide        next task, or finish
```

Two points that make the difference between a working fleet and a noisy one:

- **Step 5 is the orchestrator's real value.** The orchestrator has full file and
  shell tools for its own workspace. A worker's report is a *claim*; verify it
  before building on it. In testing, a worker correctly found that
  `AUDIT_PLAN.md` was stale, but over-claimed that `PERFORMANCE.md` was too —
  verification narrowed it to a real, actionable finding.
- **Prefer `squad_wait` to polling.** It returns on a report, escalation,
  `needs-answer`, `stuck`, or a status change (e.g. a worker going `working` →
  `idle`). It does *not* fire on ordinary progress, so it will not spam.

**Fallback when a worker never reports:** it transitions to `idle`, which is a
status change and wakes `squad_wait`. `squad_collect` then falls back to the
worker's **last assistant message** from its session log. So a worker that
forgets to report is recoverable, but its output is unstructured.

## 7. Writing the prompt — sections that earn their place

1. **Role and boundary.** State that the orchestrator coordinates and does not
   do the workers' work; it decides, delegates, verifies, decides again.
2. **The roster.** Name → project → purpose. A stable list prevents the
   orchestrator inventing workers or double-spawning.
3. **The loop.** Spell out the sequence in §6. Without it, agents tend to assign
   and then guess, or poll in a loop.
4. **Task shape.** *One objective per task, and always state the expected
   report.* Give a worked example of a good and a bad task statement (§9).
5. **Delivery mode rules.** The §4 table, compressed. Explicitly: `queue` for
   new work, `steer` to redirect or to answer an escalation.
6. **Verification duty.** "Never forward a worker's claim as verified fact. Check
   the files, diffs or outputs yourself before acting on a report."
7. **Escalation handling.** Answer with `squad_assign` + `steer`. Do not let an
   escalation sit — a worker in `needs-answer` is burning nothing but producing
   nothing.
8. **Stop conditions.** What "done" means for the whole engagement, and what to
   do about workers at the end (`squad_close`, or leave them idle).
9. **Report economy.** Reports land in the orchestrator's own context. Ask for
   concise summaries and artefacts, not transcripts.

### What NOT to put in the prompt

- Do not describe the tool schemas — they are already in context.
- Do not ask the orchestrator to poll `squad_list` in a loop; `squad_wait` exists.
- Do not have it re-spawn workers on every turn; `squad_spawn` is idempotent, so
  a single "ensure the fleet exists" instruction covers it.

## 8. Hard constraints and gotchas

| Constraint | Consequence for the prompt |
| --- | --- |
| **Writes currently require approval, and nobody answers a worker's prompt** | Read-only tasks work today. Any task needing a write or mutating shell command **hangs**. Until the approval policy is changed, keep tasks read-only. |
| Sandbox root is `/opt/dsh` (the install dir, not your projects) | Reads work anywhere; writes outside `/opt/dsh` are blocked. |
| The roster is **in-memory, not persisted** | A `dsh` restart empties it. Worker sessions still exist on disk, so re-spawning creates **new** sessions and the old ones become orphans to archive. |
| Names are globally owned by the spawning session | A different orchestrator session cannot touch them. Restarting the orchestrator session does not transfer ownership. |
| `stuck` is heuristic (15 min, no log growth) | A long reasoning pause can trip it. Instruct: on `stuck`, inspect with `squad_status` before acting. |
| Worker model is pinned at spawn | Changing the Host default later does not move existing workers. |
| Worker names: `^[a-z0-9][a-z0-9-]{0,39}$` | Lowercase, digits, hyphens; ≤ 40 chars. |
| Workers are instructed not to ask the human | A genuine blocker arrives as `squad_escalate`, or as `needs-answer` if the worker ignored that. |

## 9. Worked task phrasings

**Weak** — no expected report, no boundary:

> Look at the reviewer project and see what needs doing.

**Strong** — one objective, named artefacts, explicit report:

> Read `IMPROVEMENT-PLAN.md` in your workspace. Report the three
> highest-priority items using each item's exact heading text, and for each one
> give the line number and the stated severity. Call `squad_report` with
> `status: done`, the three headings in `summary`, and `artifacts` listing the
> file you read.

**Redirecting mid-flight** (`steer`):

> Also check whether that file mentions a severity column, and include it.

**Answering an escalation** (`steer`):

> Keep the shim, but mark it deprecated in a comment. Then finish the original
> task and report.

**Verification task the orchestrator does itself:**

> Before acting on that report, read `AGENTS.md` and confirm the endpoint count
> the worker cited.

## 10. Context economics

- Every `squad_collect` puts a full report into the orchestrator's context.
  Collect when you intend to act, not speculatively.
- `squad_wait` and `squad_list` return rendered worker views, which are compact.
- One worker per project keeps each worker's context focused and keeps report
  volume proportional to progress.
- Long engagements should expect the orchestrator to accumulate reports; a
  prompt that asks for terse summaries and artefact lists ages far better than
  one that asks for detail.

## 11. Ready-to-adapt prompt skeleton

```text
You coordinate a fleet of worker sessions, each running in its own project
workspace. You do not do their work: you decide what should be built, delegate
it, verify what comes back, and choose the next task.

The fleet (one worker per project):
- <name>  → <project>  → <what this project is>
- ...

How to work:
1. squad_spawn each worker once (idempotent — safe to re-run). Do not create
   duplicates.
2. For each task: squad_assign with mode "queue", one objective, and state the
   exact report you expect.
3. squad_wait for the fleet rather than polling squad_list in a loop.
4. squad_collect to read reports and escalations.
5. Verify before you act. You have file and shell tools; a report is a claim, not
   a fact. Check the files or outputs a worker cites.
6. Decide the next task from what you verified.

Delivery modes:
- "queue" schedules the task as the worker's own new turn. If the worker is
  mid-turn it waits; if idle it starts immediately.
- "steer" injects the message into the turn already running, at its next step
  boundary. Use it to redirect work in flight, or to answer an escalation.
- Never use "steer" just to make something start sooner.

Handle these:
- needs-answer → the worker is wedged on a question. Answer with mode "steer".
- stuck → not necessarily failed. Check squad_status before acting.
- Escalations → answer them; do not let them sit.

Constraints:
- Tasks must be READ-ONLY for now: writes require an approval that nothing can
  answer, and will hang the worker.
- Keep report requests concise; reports land in your own context.
- When the engagement is finished, squad_close each worker.

Start by ensuring the fleet exists, then ask me what the first objective is.
```

---

## Appendix: deployment facts

- Bundle `dsh-squad`, entry `fleet.js`.
- Presets: `Orchestrator` (order 20), `Squad Worker` (order 21),
  `Squad Reviewer` (22), `Squad Fixer` (23), `Squad Auditor` (24) — all at full
  parity with the shipped `standard` preset (19 plugins each).
- Config: `workerPreset: squad-worker`, `stuckAfterMs: 900000`,
  `notifyOnReport: true`, `pollMs: 20000`, `maxTextChars: 4000`,
  `maxWaitMs: 600000`. `defaultProvider` / `defaultModel` are empty by default so
  workers inherit the session route; set both to pin them.
- Verify a change with `node smoke-test.mjs` (8 passes, 38 checks) and
  `python3 verify-presets.py`. Patch edits (`cordis.patch.yml`) reload live by
  toggling the bundle; JavaScript edits (`fleet.js`) require a `dsh` restart.
