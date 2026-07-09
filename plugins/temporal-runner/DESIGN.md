# Temporal Runner Plugin — Design

A Shofer **plugin** that turns any Shofer node into a **Temporal activity worker** ("runner"):
it registers to capability-tagged task queues, **pulls** agent jobs, and drives the co-located
Shofer to execute them — durably, distributed, and resumable. It is a **general Shofer
capability**: any Shofer user can run distributed, durable, human-gated agent pipelines by
enabling one plugin.

It owns **Temporal only** and carries **no NATS**. Live telemetry, agent-to-agent
notifications, and the mesh are a **sibling plugin**, [`agent-mesh`](../agent-mesh/DESIGN.md);
the two share nothing and coordinate only through Shofer (this plugin spawns tasks, `agent-mesh`
observes their events and publishes them). Splitting by transport keeps `agent-mesh` pure-JS and
confines the native Temporal core to nodes that actually run the worker.

> **Status: proposed.** The plugin depends on the small, additive plugin-API changes in
> [`plugin_system.md` §14](../../docs/plugin_system.md#14-proposed-agent-control-api-for-workflow--runner-plugins)
> (a scoped `ctx.agent` task-control surface + a non-HTTP network-egress permission). The
> **platform** context — why this exists, how it fits a multi-agent SaaS — is in
> [`saas.md` §5.6](../../docs/saas.md#56-agentic-pipelines--orchestration); **this** document
> is the plugin itself.

---

## 1. Why a plugin (not a companion)

Shofer's public `ShoferAPI` ([`public_api.md`](../../docs/public_api.md)) can already fill this role via a
**companion VS Code extension** (the API's reference-consumer pattern). But a companion is tied to
the **VS Code extension host**, which fits a code-server workspace but is awkward for a **headless
runner pool**.

A **plugin** is the better home because it is:

- **Host-agnostic** ([`plugin_system.md` §2](../../docs/plugin_system.md#2-design-goals)) — runs identically
  in the VS Code extension, the CLI, and a **headless server** (`shofer serve`), which is exactly
  where a runner pool lives.
- **A standard, upstream Shofer feature** — every Shofer user benefits from distributed durable
  pipelines. The enabling API additions (§14 there) are generally useful (the "workflow plugin"
  category §5.9 already names).
- **Config-gated and non-contaminating** — disabled by default, permission-gated; a standalone
  Shofer without it is byte-for-byte unchanged.
- **Precedented** — the Live Memory plugin already bundles and runs a background **server** via
  `ctx.registerService`, so hosting a Temporal worker is an existing pattern, not a new capability.

The orchestration logic can be shared with the companion; the plugin is the upstream home.

---

## 2. Where it sits

The stack (see [`saas.md` §5.6](../../docs/saas.md#56-agentic-pipelines--orchestration)):

```
NATS       ← event ingress + signalling (+ live telemetry side-channel)
Temporal   ← durable orchestration + capability-tagged runner pool
Shofer     ← the agent runtime (THIS plugin drives it)   ← the runner
llm-router ← model access ·  GitLab ← coordination system of record
```

This plugin is the **runner** half: the Temporal **activity worker** that executes agent activities.

**Determinism boundary.** Pipeline **Workflows** are deterministic controllers (routing, gates,
retries) hosted elsewhere (a central orchestration worker); this plugin hosts **Activity** workers —
the non-deterministic agent runs. Shofer/LLM execution runs **only inside an Activity, never a
Workflow**. (Temporal vs Shofer/Slang = outer vs inner loop, complementary — `saas.md` §5.6.)

---

## 3. How it works

On activation the plugin:

1. **Hosts the worker** — `ctx.registerService({ name, start, stop })`
   ([`plugin_system.md` §5.11](../../docs/plugin_system.md#511-host-capabilities-ctx)) starts a Temporal
   worker (a client to `temporal:7233`, from `ctx.config`).
2. **Joins the pool by polling** — the worker long-polls **capability-tagged task queues**
   (`runner:coding`, `gpu`, … from `ctx.config`). Polling a queue _is_ pool membership; there is
   **no central dispatcher** — runners self-select when they have a free slot (pull-based → natural
   load-balancing/backpressure, no SPOF).
3. **Registers an activity** (`config.activityName`, default `runShoferTask`) whose implementation:
    - `ctx.agent.spawn(prompt, { metadata })` → a **`PluginTaskHandle`**
      ([`plugin_system.md` §14.2](../../docs/plugin_system.md#142-scoped-agent-control-on-ctxagent)).
    - calls `activity.heartbeat()` on every task event and on a `config.heartbeatMs` interval —
      liveness + cancellation delivery. (Live telemetry to NATS is **not** the runner's job; the
      `agent-mesh` plugin does that by observing the same task events, keeping Temporal's workflow
      history small + fast.)
    - `await handle.result()` → returns the structured `PluginTaskResult` (status / output / MR url in
      `metadata`) to Temporal.
    - on Temporal cancellation (human cancel or the global kill switch) → `handle.cancel()`, exposing
      Shofer's existing structured cancellation.

Concurrency = the worker's `maxConcurrentActivityTaskExecutions` (from `config.concurrency`; capacity
and backpressure; often **1** for clean per-task worktree isolation — an idle Shofer pod pulls one
job, runs it in-process, returns to polling).

### Illustrative sketch

```ts
import { Worker, NativeConnection } from "@temporalio/worker"

export default {
	name: "temporal-runner",
	async initialize(ctx) {
		let worker: Worker | undefined
		ctx.registerService({
			name: "temporal-worker",
			start: async () => {
				const connection = await NativeConnection.connect({ address: ctx.config.temporalAddress })
				worker = await Worker.create({
					connection,
					namespace: ctx.config.namespace,
					taskQueue: ctx.config.taskQueue, // capability tag
					maxConcurrentActivityTaskExecutions: ctx.config.concurrency ?? 1,
					activities: {
						async runShoferTask(input: { prompt: string; metadata?: Record<string, unknown> }) {
							const h = await ctx.agent.spawn(input.prompt, { metadata: input.metadata })
							const unsub = h.onEvent(() => Activity.heartbeat({ taskId: h.taskId })) // liveness only — no NATS
							Activity.cancellationSignal.addEventListener("abort", () => h.cancel())
							const hb = setInterval(() => Activity.heartbeat(), ctx.config.heartbeatMs ?? 10_000)
							try {
								return await h.result() // { status, output, metadata } → back to Temporal
							} finally {
								unsub()
								clearInterval(hb)
							}
						},
					},
				})
				await worker.run()
			},
			stop: () => worker?.shutdown(),
		})
	},
}
```

The activity heartbeats but never touches NATS; live telemetry is the `agent-mesh` plugin's job
(it observes the same task events). The runner's only egress is gRPC to Temporal.

---

## 4. Resume-safety — the "leave the wheel safe" contract

Agent activities have **side effects** (files written, branch pushed, MR opened, LLM spend), so
Temporal's "retry on a healthy runner" is correct **only if the activity is resume-safe, not blindly
re-run**:

- **Shofer checkpoints + per-task worktree** — a retry reattaches and continues from the last
  checkpoint, never restarts from zero.
- **Idempotency keys** on outward actions (MR keyed to the ticket, provisioning keyed to a request
  id) so a retry reconciles instead of duplicating.
- **Heartbeat** so a long agent run isn't mistaken for a dead worker, and cancellation propagates.

This is the same contract a **human takeover** or the **global kill switch** relies on (see
`saas.md` §5.6).

---

## 5. The mesh half is a sibling plugin

The **mesh participant** role — registry heartbeat, inbound agent-to-agent delivery via
`ctx.agent.notify`, and outbound NATS telemetry — is the **separate** [`agent-mesh`](../agent-mesh/DESIGN.md)
plugin (`saas.md` §5.5), split out so it stays pure-JS. "A Shofer node joins the fabric" = enable
**both** plugins; each is independently useful (a runner with no mesh, or a mesh participant that
never pulls Temporal work). They coordinate only through Shofer.

### Agent tools (read-only introspection)

So the driving agent can inspect the pipeline/runner state, the plugin exposes three tools (via
`registerTools`, backed by a pure-JS `@temporalio/client`):

- `temporal_task_queue_status` — how many runner workers poll a queue (pool health).
- `temporal_list_workflows` — list workflow executions (optional Temporal visibility query).
- `temporal_describe_workflow` — status of a workflow by id.

These are strictly read-only; the plugin never starts or signals workflows (that is the
orchestration worker's job).

---

## 6. Configuration

Via the plugin manifest `config` schema → `ctx.config`
([`plugin_system.md` §4](../../docs/plugin_system.md#4-plugin-manifest)). Flat keys (matching the
implementation):

```jsonc
{
	"config": {
		"temporalAddress": "temporal:7233",
		"namespace": "default",
		"taskQueue": "runner:coding", // capability tag — polling it = pool membership
		"activityName": "runShoferTask",
		"concurrency": 1, // maxConcurrentActivityTaskExecutions
		"heartbeatMs": 10000,
	},
	"permissions": {
		"agent": true, // spawn/await/cancel (§14.2)
		"tools": true, // the introspection tools above
		"network": ["grpc://temporal:7233"], // declared socket egress (§14.3) — Temporal only, no NATS
	},
}
```

---

## 7. Required plugin-API additions

Everything below **except** the two items is already shipped
([`plugin_system.md` §14.4](../../docs/plugin_system.md#144-what-does-not-change)):

| Need                                                     | Status                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Host the worker (`ctx.registerService`)                  | ✅ shipped (Live-Memory-precedented)                                                              |
| Inbound delivery / one-way steering (`ctx.agent.notify`) | ✅ shipped                                                                                        |
| Observe events / completion (`onEvent`, lifecycle hooks) | ✅ shipped                                                                                        |
| Config + idempotency state (`ctx.config`, `ctx.storage`) | ✅ shipped                                                                                        |
| **Spawn → `TaskHandle` (await result) + `cancel`**       | ⚠️ proposed — [§14.2](../../docs/plugin_system.md#142-scoped-agent-control-on-ctxagent)           |
| **Non-HTTP (gRPC/socket) network egress**                | ⚠️ proposed — [§14.3](../../docs/plugin_system.md#143-non-http-network-egress-permissionsnetwork) |

Both proposed items are scoped, gated, and ride existing seams (see §14) — they are the ~15% delta,
not new subsystems.

---

## 8. Relationship to the companion (ShoferAPI) path

The same runner role can be filled by a **companion VS Code extension** over the public `ShoferAPI`
([`public_api.md`](../../docs/public_api.md)) — the API's reference-consumer pattern, which bridges Shofer
events to external systems. That path is the **VS Code / workspace binding**, natural where a rich
local UI and human takeover already live (code-server). This **plugin** is the **host-agnostic**
equivalent: same job, but it runs **headless** (the runner pool) and is a standard, upstream Shofer
feature. The two can share the Temporal/NATS logic as a library; the plugin is the general home.

---

## Related documents

| Document                                                                                                         | Relationship                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`plugin_system.md` §14](../../docs/plugin_system.md#14-proposed-agent-control-api-for-workflow--runner-plugins) | The plugin-API additions this plugin needs (spawn-handle/cancel, socket egress).      |
| [`saas.md` §5.6](../../docs/saas.md#56-agentic-pipelines--orchestration)                                         | Platform orchestration context: NATS ingress + Temporal pool + Shofer runtime.        |
| [`v3_architecture.md`](../../docs/v3_architecture.md)                                                            | Host-agnostic core + distributed execution (the substrate this builds on).            |
| [`agentapi.md`](../../docs/agentapi.md)                                                                          | The transport-agnostic control-plane surface the scoped `ctx.agent` mirrors.          |
| [`public_api.md`](../../docs/public_api.md)                                                                      | The companion (`ShoferAPI`) path — the VS Code extension binding, complementary here. |
