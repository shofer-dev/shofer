# temporal-runner — Testing

How to verify the plugin, from cheapest to most end-to-end. The dev cluster already runs Temporal
and NATS (deployed under `infra/`); their NodePorts on the dev node are **Temporal `:30233`** and
**temporal-ui `:30088`** (NATS `:30422` is only relevant to `agent-mesh`).

## 1. Static — typecheck

```bash
cd extensions/shofer && pnpm -w typecheck   # or: tsc -p plugins/temporal-runner/tsconfig.json --noEmit
```

Covers the plugin against the §14 `PluginAgent` surface (`spawn`/`cancel`/`PluginTaskHandle`/
`PluginTaskResult`) and the structural `@temporalio/worker` types.

## 2. Runner mechanism — standalone harness (real Temporal + NATS)

Proves the pull/execute/heartbeat/result loop against **real** infra without needing a Shofer host.
A standalone worker registers `runShoferTask` on `runner:coding` with the activity body **stubbed**
(the `ctx.agent.spawn` call replaced by a canned `PluginTaskResult`), and a client starts a workflow
that schedules it.

```bash
# point at the dev cluster (or a local `temporal server start-dev`)
export TEMPORAL_ADDRESS=<dev-node>:30233
node worker.mjs &     # long-polls runner:coding, runs the stubbed activity, heartbeats
node client.mjs       # starts a workflow → activity → asserts the returned PluginTaskResult
```

What this **does** prove: task-queue registration, pull-based pickup, heartbeating, cancellation
delivery, and the structured result round-trip. What it **does not** prove: that a real Shofer run
drives the activity — that is step 4 (the activity body is stubbed here). Flag this honestly in any
result write-up.

## 3. Introspection tools — against real Temporal

With a worker polling (step 2 or 4), the three read-only tools resolve against `@temporalio/client`:

- `temporal_task_queue_status` → reports ≥1 activity poller on `runner:coding`.
- `temporal_list_workflows` → lists the workflow started in step 2.
- `temporal_describe_workflow` → status/runId/start of that workflow.

Independently cross-check with the Temporal UI (`:30088`) or `temporal workflow list`.

## 4. End-to-end — code-server in k3s (the real runner)

The only test that exercises `ctx.agent.spawn` driving a real Shofer.

1. Build + install the latest Shofer (with this plugin bundled) into the in-cluster code-server:
   `./deploy.sh dev install-extensions`.
2. In the pod, install the plugin's native deps (`@temporalio/worker` is per-architecture):
   `npm install` in the installed plugin folder; confirm `require("@temporalio/worker")` loads.
3. Enable **temporal-runner** in the Shofer Plugins panel (disabled by default — consent gate) and
   reload; ensure a working model provider is configured.
4. On enable, the worker logs `worker polling temporal:7233 ns=default queue=runner:coding` and
   `temporal_task_queue_status` shows the pod as a poller.
5. Start a workflow scheduling `runShoferTask` → the pod picks it up, Shofer runs the prompt, and the
   structured `PluginTaskResult` returns to Temporal (visible in the UI).

**Missing-deps path:** if the `@temporalio/*` deps are absent, enabling the plugin must surface a
**user notification** (not just a log) with an actionable `npm install` message, and start nothing
else. Verify by enabling before step 2.

> Status: steps 1–3 verified against the dev cluster; step 4's `ctx.agent.spawn`→real-Shofer leg is
> the outstanding e2e (gated on manually enabling the plugin in-pod). Keep this note current.
