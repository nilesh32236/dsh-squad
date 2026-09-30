# dsh-squad

**Run a fleet of AI agents across your projects, from one orchestrating chat.**

`dsh-squad` is a [DeepSeek Harness](https://github.com/deepseek-ai) plugin that lets one
session create and coordinate worker agent sessions running in *other* workspaces.
You talk to the orchestrator; it delegates to workers, each working in its own
project directory, and reports back to you.

```
you ──▶ orchestrator ──▶ worker: opencode-ai-reviewer
                     ├─▶ worker: performance-optimisation
                     └─▶ worker: duoport-connect-for-opencode
                            │
                            └── squad_report ──▶ orchestrator wakes up
```

---

## Why

DSH can already create a session against any workspace, prompt it, cancel it, and
read its log. What it has no notion of is **naming** those sessions, remembering
which orchestrator owns which worker, and turning *"send this task over there and
tell me when it's done"* into a tool call.

That layer is this plugin. Each worker keeps its own durable session log as the
source of truth for its work; `dsh-squad` holds a roster of pointers plus the
reports and escalations workers submitted.

## What makes it different

Most multi-agent setups make you choose between **blocking** (the orchestrator
sits and waits) and **spinning** (it polls in a loop, burning tokens).

`dsh-squad` does neither:

- **Workers wake the orchestrator.** When a worker reports, the plugin delivers a
  message into the orchestrator's session. If it is idle it starts a turn
  immediately; if it is busy the message queues behind the current turn. Nothing
  has to be polled.
- **`squad_watch` is genuinely non-blocking.** It registers a real DSH background
  job and returns a job id at once, so the orchestrator can review, plan, or
  prepare the next round while a long task runs. It is woken with the result.
- **The fleet survives restarts.** The roster is persisted, and every worker
  session carries a durable `squad:<name>` title — so identity survives even if
  the state file is lost, and re-spawning adopts the existing session instead of
  creating a duplicate.

---

## Requirements

- DeepSeek Harness `>= 0.1.7-rc.1`
- A harness version whose Web profile provides `@deepseek-ai/dsh-tool-jobs`
  (required for `squad_watch`) — it ships in the standard DSH web profile.

## Install

### From GitHub

```sh
dsh plugin --profile web add github:nilesh32236/dsh-squad
```

Then enable the bundle in the plugin manager and **restart** DSH — plugin
JavaScript does not hot-reload.

### From a local checkout (development)

```sh
git clone https://github.com/nilesh32236/dsh-squad ~/dsh-squad
cd ~/dsh-squad
node tools/dev-links.mjs /path/to/dsh-install   # link the harness-provided peers
dsh plugin --profile web add link:$PWD
```

`tools/dev-links.mjs` exists because a bundle installed as a `link:` to a
directory *outside* the harness tree has no path to the harness's own packages:
Node resolves imports from the linked directory's real path, walks up through your
home directory, and never reaches the harness installation. The script creates
the symlinks. An npm/GitHub install inside the profile's `node_modules` does not
need it.

## Quick start

1. Start a new session and select the **Orchestrator** agent preset.
2. Create the fleet — one worker per project and per role:

   ```
   squad_spawn  name: reviewer  project: my-frontend   preset: squad-reviewer
   squad_spawn  name: fixer     project: my-backend    preset: squad-fixer
   ```

3. **Fan out, then gather once.** `squad_assign` returns immediately, so send
   every task before waiting for any of them:

   ```
   squad_assign  name: reviewer  task: "Audit the auth flow for missing checks."
   squad_assign  name: fixer     task: "Fix the flaky retry test in tests/retry.test.js."
   squad_wait    mode: all
   squad_collect name: reviewer
   squad_collect name: fixer
   ```

   > **The single most common mistake** is `assign → wait → collect`, repeated per
   > worker. That serialises a fleet that could be running concurrently. Assign to
   > everyone first.

4. For slow work, use `squad_watch` instead of `squad_wait` and keep working.

---

## Tools

### Orchestrator tools

| Tool | Purpose |
| --- | --- |
| `squad_spawn` | Create or **adopt** a worker bound to another workspace. Idempotent by name. Registers an unknown `cwd` as a new workspace. |
| `squad_resume` | Re-attach every worker and report what each needs. **Call this first whenever you resume**, and after any restart. |
| `squad_list` | The roster: project, status, queued tasks, unread reports and escalations. |
| `squad_assign` | Send a task. `queue` = its own new turn; `steer` = inject into the running turn. Also how you answer an escalation. |
| `squad_wait` | Block until workers finish. `mode: "all"` gathers a whole fan-out in one call. |
| `squad_watch` | **Same condition, in the background.** Returns a job id at once and wakes you with the result. |
| `squad_status` | One worker in detail: last tool called, blocked question, last answer, queued work. |
| `squad_collect` | Read reports and escalations, and mark them delivered. |
| `squad_stop` | Cancel a worker's active turn; keep or discard its queued work. |
| `squad_close` | Remove the worker from the roster. Its session log is retained. |

### Worker tools

| Tool | Purpose |
| --- | --- |
| `squad_report` | Submit a result (`done` / `partial` / `blocked`) with a summary and artefacts. **Wakes the orchestrator.** |
| `squad_escalate` | Ask the orchestrator for a decision only it can make. **Wakes the orchestrator.** |

Both worker tools refuse when the calling session is not a squad worker, so they
are harmless anywhere else.

### Addressing a worker

Every orchestrator tool accepts **either the worker name or its session id**, so a
caller holding an id from `squad_list` can address the same worker. Ownership is
enforced either way.

---

## Coordination model

### Queue vs. steer

Both are the same durable message with a different delivery target:

| Mode | Delivered as | When to use |
| --- | --- | --- |
| `queue` | `next-turn` — a new turn, after the current one finishes | Normal task dispatch. Never interrupts. |
| `steer` | `next-step` — injected at the next step boundary of the running turn | Redirecting live work, and answering escalations. |

If a worker is idle, both start a turn immediately.

### How the orchestrator learns a worker finished

A report or escalation delivers a message into the orchestrator's session:

```
[SQUAD] Worker "reviewer" (my-frontend) reported done.
        …
        Call squad_collect with name "reviewer" to read the full report.
```

This is why an idle orchestrator still reacts — it does not need to be polling.
Set `notifyOnReport: false` to disable it and poll instead.

### Campaign memory

`squad_spawn` reports a campaign tree, and reports are archived into it as
markdown automatically:

```
$DSH_HOME/squad/campaigns/<orchestrator-session>/
  INDEX.md          regenerated on every report — roster table + layout
  reports/          one markdown file per worker report
  escalations/      one markdown file per worker question
  notes/            campaign memory (written by the orchestrator)
  tasks/            the task board
```

The roster is the plugin's index; this tree is the durable, human-browsable
record beside it, readable with nothing but a file browser. It is keyed to the
**orchestrator session** — a new orchestrator session starts with an empty tree.

---

## Status values

| Status | Meaning |
| --- | --- |
| `idle` | Live, between tasks. |
| `working` | A turn is running. |
| `stuck` | Running with no log growth past `stuckAfterMs`. |
| `reported` | Submitted a report the orchestrator has not collected. |
| `needs-answer` | Blocked on an unanswered `ask_user_question`. Nobody watches a worker's session, so an outstanding question would otherwise wedge it silently. |
| `dormant` | On the roster but not attached to a live session — restored after a restart. Re-attached automatically. |
| `unattachable` | Could not be re-attached; the reason is reported. |

## Config

Set in the bundle patch's `squad` row:

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultProvider` | *(empty)* | Worker route provider. Empty = workers inherit the session default. |
| `defaultModel` | *(empty)* | Worker model. Empty = inherit. Set both to **pin** every worker to one route, so a later change of the host default cannot silently move a running worker onto a model that cannot do the job. |
| `defaultReasoningEffort` | *(empty)* | Worker reasoning effort; only applied when a route is pinned. |
| `workerPreset` | *(empty)* | Preset applied to spawned workers. |
| `stuckAfterMs` | `900000` | No-log-growth threshold before a running worker is `stuck`. |
| `notifyOnReport` | `true` | Deliver a message into the orchestrator's session when a worker reports or escalates. |
| `pollMs` | `20000` | Activity-stamp refresh cadence. |
| `maxTextChars` | `4000` | Cap on any text block returned to a model. |
| `maxWaitMs` | `600000` | Upper bound on one `squad_wait` / `squad_watch`. |

## Bundled agent presets

The bundle ships five presets: **Orchestrator**, **Squad Worker**,
**Squad Reviewer**, **Squad Fixer**, and **Squad Auditor**.

> **A preset's `plugins` list is complete, not additive.** A preset that declares
> only a persona strips *every* tool from the session. Each preset here therefore
> carries the full plugin list of the shipped `standard` preset with only the
> `persona` row replaced. `verify-presets.py` asserts that structurally.

## Docs

- [`docs/ORCHESTRATOR-GUIDE.md`](docs/ORCHESTRATOR-GUIDE.md) — how to run a campaign well
- [`docs/INTERNALS.md`](docs/INTERNALS.md) — design decisions and platform traps
- [`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md) — research findings and roadmap

## Development

```sh
node smoke-test.mjs          # 37 checks across 8 passes
python3 verify-presets.py    # preset parity against the shipped `standard`
python3 generate-presets.py  # regenerate cordis.patch.yml after a persona edit
```

The test suite runs every tool body against a mock host and asserts, among other
things, that no tool result contains a JavaScript `undefined` (a tool result must
be lossless JSON). Every signature in the mock is transcribed from the service
catalog and checked for arity, because three shipped bugs were signature mistakes
that survived only because a mock was looser than the real API.

**Reload semantics:** patch data (`cordis.patch.yml`) reloads live by toggling the
bundle. Plugin JavaScript (`fleet.js`) does **not** hot-reload — the loader caches
the entry's module import for the life of the process, so a corrected `fleet.js`
needs a real DSH restart.

## License

MIT
