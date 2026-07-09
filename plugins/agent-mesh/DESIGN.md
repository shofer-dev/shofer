# NATS Mesh Plugin (`agent-mesh`) — Design

A Shofer **plugin** that makes any Shofer node a participant in the **NATS agent mesh**: it
delivers inbound async **notifications/events** into the running agent, emits telemetry, and gives
the agent tools to **emit and subscribe** to events itself. It is **pure JS** (no native deps), so
it bundles anywhere and loads on **any** node — an interactive L1 workspace, the L2 backend, or a
runner — independent of the (native) [`temporal-runner`](../temporal-runner/DESIGN.md) plugin.

> **Status: proposed / implemented as `plugins/agent-mesh`.** It uses only **shipped** plugin-API
> surfaces (`ctx.registerService`, `ctx.agent.notify`, `registerTools`) — **no §14 needed**. The
> platform context is [`saas.md` §5.5](../../docs/saas.md#55-the-agent-mesh-registration-discovery-a2a) (the
> mesh) and [`saas.md` §5.6](../../docs/saas.md#56-agentic-pipelines--orchestration) (how it sits beside the
> runner).

---

## 1. Why a separate plugin (split by transport)

The per-node fabric capability ships as **two composable plugins, one transport each** —
`agent-mesh` (NATS) and `temporal-runner` (Temporal) — rather than one. The decisive reasons:

- **Different nodes want different subsets.** An interactive L1 workspace wants to _receive_
  cluster notifications and be discoverable, but it is **not** in the runner pool — so it should not
  carry the native Temporal core just to get notifications. A headless runner wants both.
- **Different dependency weight.** `agent-mesh` needs only the **pure-JS `nats`** client (bundles
  anywhere); `temporal-runner` needs the **native `@temporalio/*`** worker (per-architecture).
- **Independent failure.** Notification delivery shouldn't be coupled to the Temporal worker's
  health, and vice versa.

They share nothing and **coordinate through Shofer**: the runner spawns tasks; `agent-mesh` observes
their events (via `onEvent`) and publishes telemetry — no plugin-to-plugin API needed.

---

## 2. What it does

On enable, `ctx.registerService` opens one NATS connection and:

1. **Inbound delivery** — subscribes to the configured subjects (`config.subscriptions`) and to any
   subject the agent subscribes to at runtime; each incoming message is **injected into the running
   agent via `ctx.agent.notify`** (default `mode: "queue"` — seen on the agent's next turn). This is
   the mesh's async-notification delivery: "your provisioning finished", "an alert fired", an A2A
   message, etc.
2. **Outbound telemetry** (opt-in, `config.telemetry`) — publishes this node's task events
   (`onEvent`) to `telemetrySubjectPrefix.<taskId>`, so a live view (user-console) can follow along —
   deliberately **not** in any orchestrator's durable history.
3. **Agent tools** — the agent can drive the mesh itself:

    | Tool                             | Does                                                                  |
    | -------------------------------- | --------------------------------------------------------------------- |
    | `mesh_publish(subject, message)` | emit an event/notification onto the bus (fire-and-forget)             |
    | `mesh_subscribe(subject)`        | watch a subject (`*`/`>` wildcards) — matches arrive as notifications |
    | `mesh_unsubscribe(subject)`      | stop watching                                                         |

    …plus **static** subscriptions declared in config (the "subscribe via configuration" path).

---

## 3. Configuration (`ctx.config`)

| key                      | default            | meaning                                                                    |
| ------------------------ | ------------------ | -------------------------------------------------------------------------- |
| `natsUrl`                | `nats://nats:4222` | NATS server                                                                |
| `subscriptions`          | `[]`               | subjects auto-subscribed on start (delivered to the agent)                 |
| `deliverMode`            | `queue`            | `ctx.agent.notify` mode for inbound messages (`queue`/`interrupt`/`spawn`) |
| `telemetry`              | `false`            | publish task events to NATS                                                |
| `telemetrySubjectPrefix` | `agents.telemetry` | telemetry subject prefix                                                   |

Permissions: `tools`, `agent` (for `ctx.agent.notify`), `events` (for `onEvent`), and
`network: ["nats://…"]`.

---

## 4. Required plugin-API surfaces (all shipped)

| Need                                      | Surface                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| Host the NATS connection + subscribe loop | `ctx.registerService`                                                      |
| Inject inbound messages into the agent    | `ctx.agent.notify` (needs `permissions.agent`)                             |
| Observe task events for telemetry         | `onEvent`                                                                  |
| Emit/subscribe tools                      | `registerTools` (`defineCustomTool`)                                       |
| Config + user-facing errors               | `ctx.config`, `ctx.host.notifier` (fails loudly if `nats` isn't installed) |

Unlike `temporal-runner`, `agent-mesh` needs **no §14** and **no native code** — it's the light,
portable half of the fabric.

---

## 5. How it interlocks with Temporal (it doesn't, directly)

NATS is the **event/notification/telemetry** plane; Temporal is the **durable orchestration** plane.
They never talk directly — Temporal is NATS-agnostic (a workflow is deterministic and does no I/O).
They meet only at **two central bridge points that hold both a NATS connection and a Temporal
client** (see [`saas.md` §5.6](../../docs/saas.md#56-agentic-pipelines--orchestration)):

- **Ingress bridge** — a NATS consumer that turns an event into a pipeline: `NATS → client.workflow.start()`.
- **user-console** — turns human approvals into Temporal **signals** and pipeline/agent state into
  NATS notifications.

`agent-mesh` is **not** one of those bridges — it only speaks NATS (deliver in, publish out). An
event _triggering_ a Temporal pipeline goes `NATS → ingress bridge → Temporal client`, never through
this plugin, and never Temporal subscribing to NATS.

---

## Related documents

| Document                                                                          | Relationship                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`temporal-runner/DESIGN.md`](../temporal-runner/DESIGN.md)                       | The sibling (native) **runner** plugin — Temporal half of the fabric.                         |
| [`plugin_system.md`](../../docs/plugin_system.md)                                 | `ctx.registerService` / `ctx.agent.notify` / `registerTools` — the surfaces this plugin uses. |
| [`saas.md` §5.5](../../docs/saas.md#55-the-agent-mesh-registration-discovery-a2a) | The agent mesh (registration/discovery/A2A) this plugin participates in.                      |
| [`saas.md` §5.6](../../docs/saas.md#56-agentic-pipelines--orchestration)          | The two-plugin split + the NATS↔Temporal bridge points.                                      |
| [`v3_architecture.md`](../../docs/v3_architecture.md)                             | Host-agnostic core the plugin runs on.                                                        |
