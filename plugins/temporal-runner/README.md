# temporal-runner (Shofer plugin)

Turns a Shofer node into a **Temporal activity worker**: it registers to a capability-tagged
task queue, **pulls** agent jobs, and drives the co-located Shofer as a durable job via the
scoped `ctx.agent.spawn` API. Design + rationale: [`docs/temporal_plugin.md`](../../docs/temporal_plugin.md)
(and the enabling plugin-API additions in [`docs/plugin_system.md` §14](../../docs/plugin_system.md#14-proposed-agent-control-api-for-workflow--runner-plugins)).

## What it does

On enable, `ctx.registerService` starts a Temporal `Worker` that long-polls `config.taskQueue`.
On pickup, the `runShoferTask` activity:

1. `ctx.agent.spawn(prompt, { metadata })` → a `PluginTaskHandle`,
2. `heartbeat()`s (liveness + cancellation delivery),
3. `await handle.result()` → returns the structured `PluginTaskResult` to Temporal,
4. on Temporal cancellation → `handle.cancel()` (structured cancellation).

`maxConcurrentActivityTaskExecutions = config.concurrency` (default 1) is capacity + backpressure —
polling only resumes when a slot is free (pull-based, no central dispatcher).

It carries **no NATS** — live telemetry/notifications are the `agent-mesh` plugin's job (they
coordinate through Shofer, not with each other).

## Agent tools (read-only introspection)

- `temporal_task_queue_status` — how many runners poll a queue (pool health).
- `temporal_list_workflows` — list workflow executions (optional visibility query).
- `temporal_describe_workflow` — status of a workflow by id.

## Requirements

- Plugin-API §14 (`ctx.agent.spawn`/`cancel`) — shipped in this Shofer build.
- `permissions.agent` (granted in `plugin.json`) + a host that wires the agent seam (the VS Code
  extension / the CLI under the shim).
- Its own runtime deps installed alongside the plugin: `@temporalio/worker`,
  `@temporalio/activity`, `@temporalio/client` (see `package.json`). These are dynamically
  `import()`ed; if they're missing the plugin surfaces a **user notification** (not just a log)
  with an actionable "npm install" message, and does nothing else.

## Config (`ctx.config`)

| key               | default         | meaning                                             |
| ----------------- | --------------- | --------------------------------------------------- |
| `temporalAddress` | `temporal:7233` | Temporal frontend gRPC                              |
| `namespace`       | `default`       | Temporal namespace                                  |
| `taskQueue`       | `runner:coding` | capability-tagged queue (polling = pool membership) |
| `activityName`    | `runShoferTask` | activity type driven by Shofer                      |
| `concurrency`     | `1`             | `maxConcurrentActivityTaskExecutions`               |
| `heartbeatMs`     | `10000`         | activity heartbeat interval                         |

## Note

This is the **runner** (Activity worker). Pipeline **Workflows** — the deterministic controllers
that schedule `runShoferTask` — live elsewhere; a Shofer/LLM run is non-deterministic and must
stay inside an Activity, never a Workflow.
