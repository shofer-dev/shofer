# agent-mesh — Testing

Pure-JS, no native deps — so testing is lighter than `temporal-runner`. The dev cluster's NATS is on
NodePort **`:30422`** (in-cluster `nats:4222`).

## 1. Static — typecheck

```bash
cd extensions/shofer && pnpm -w typecheck   # or: tsc -p plugins/agent-mesh/tsconfig.json --noEmit
```

## 2. Connectivity + missing-dep path

- With the `nats` dep installed and a reachable server, enabling the plugin logs
  `connected to nats://… ; static subscriptions: [ … ]`.
- With `nats` **absent**, enabling must surface a **user notification** (`ctx.host.notifier.error`),
  not just a log, telling the user to `npm install`, and start nothing else. Verify by removing the
  dep before enable.

## 3. Inbound delivery (NATS → `ctx.agent.notify`)

Set `config.subscriptions: ["ops.alert.*"]`, enable, then publish to a matching subject and confirm
it arrives as an agent notification on the next turn:

```bash
# nats CLI pointed at the dev node
nats --server <dev-node>:30422 pub ops.alert.disk "root fs 92% on node-3"
# → agent sees:  [mesh:ops.alert.disk] root fs 92% on node-3
```

`deliverMode` (`queue`/`interrupt`/`spawn`) selects the `ctx.agent.notify` mode.

## 4. Agent tools

- `mesh_subscribe("demo.>")` then, from the CLI, `nats pub demo.hello "hi"` → delivered as a
  notification; `mesh_unsubscribe("demo.>")` stops it.
- `mesh_publish("demo.hello", "from agent")` → a `nats sub demo.hello` on the CLI receives it.

## 5. Outbound telemetry (opt-in)

Set `config.telemetry: true`, run any task, and watch the telemetry subject:

```bash
nats --server <dev-node>:30422 sub "agents.telemetry.>"
# → one message per task event, JSON-encoded PluginEvent, keyed by taskId
```

Telemetry is best-effort and deliberately **not** written to any Temporal history.
