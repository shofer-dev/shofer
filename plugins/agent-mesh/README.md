# agent-mesh (Shofer plugin)

Makes a Shofer node a participant in the **NATS agent mesh** (`saas.md` §5.5). Pure JS — no
native deps — so it bundles anywhere and loads on **any** node (interactive L1 workspace, L2
backend, or a runner), independent of the (native) `temporal-runner` plugin.

Design + rationale: [`DESIGN.md`](./DESIGN.md). How to verify: [`TESTING.md`](./TESTING.md).

## What it does

- **Inbound**: subscribes to configured/subscribed subjects and injects each message into the
  running agent via `ctx.agent.notify` (async-notification delivery).
- **Outbound telemetry** (opt-in): publishes this node's task events (`onEvent`) to
  `telemetrySubjectPrefix.<taskId>`.
- **Agent tools**: `mesh_publish` (emit an event), `mesh_subscribe` / `mesh_unsubscribe` (watch a
  subject; matches arrive as notifications). Plus **static** `config.subscriptions`.

## Config

| key                      | default            | meaning                                                    |
| ------------------------ | ------------------ | ---------------------------------------------------------- |
| `natsUrl`                | `nats://nats:4222` | NATS server                                                |
| `subscriptions`          | `[]`               | subjects auto-subscribed on start (delivered to the agent) |
| `deliverMode`            | `queue`            | `ctx.agent.notify` mode for inbound messages               |
| `telemetry`              | `false`            | publish task events to NATS                                |
| `telemetrySubjectPrefix` | `agents.telemetry` | telemetry subject prefix                                   |

## Note

This plugin owns **all** NATS for the node; `temporal-runner` owns Temporal and carries no NATS.
They coordinate through Shofer (the runner spawns tasks; this plugin observes + publishes their
events). The NATS↔Temporal bridging lives in central components (ingress + user-console), not here.
