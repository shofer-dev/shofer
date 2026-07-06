# AgentApi — the transport-agnostic agent surface

`AgentApi` is the **one control-plane interface** every front-end and transport drives.
It decouples the core agent (loop, tools, MCP, checkpoints, changed-files) from _how_ a
UI reaches it, so arbitrary front-ends (VS Code, an editor over [ACP](./acp.md), a CLI, a
remote controller) can drive the same core without touching it.

- **Definition:** [`packages/types/src/agent-api.ts`](../packages/types/src/agent-api.ts)
  (in `@shofer/types`, vscode-free, so both the core implementations and the wire-protocol
  modules share it).
- **Strategic context:** [`v3_architecture.md`](./v3_architecture.md) §10–§12 (host boundary,
  HTTP/SDK, distributed execution).

## Why it exists

The decoupling seam is `AgentApi`, **not** any single wire protocol. Everything else is a
_transport_ that binds to it:

| Binding        | Implementer                                                                                            | Role                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In-process** | `ShoferApiAgent implements AgentApi` (`transport/shofer-api-agent.ts`)                                 | The live core agent, backed by the extension's `ShoferAPI`.                                                                                                                                  |
| **HTTP/SSE**   | `createHttpServer(api)` + `ShoferHttpClient implements AgentApi` (`transport/http-{server,client}.ts`) | A **1:1 projection of the full surface** (see [routes](#httpsse-binding)). Powers **Shofer Nodes** — remote headless executors (`shofer serve`) driven by a controller (`ShoferHttpClient`). |
| **ACP**        | `AcpAgentServer` over `AgentApi` (`transport/acp-*.ts`)                                                | A **lossy adapter** onto the external [Agent Client Protocol](./acp.md) so ACP editors (Zed, …) can drive shofer. Narrower than `AgentApi` — see [acp.md](./acp.md).                         |

Because `ShoferHttpClient` _implements_ `AgentApi`, client and server can't drift: the same
interface is the wire contract.

## The surface

The full method set (see the source for exact signatures):

### Control plane

| Method                                                              | Purpose                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTask({ prompt, taskId?, apiConfiguration? })` → `{ taskId }` | Start a task. `apiConfiguration` ships the controller's resolved [API Configuration](#per-task-api-configuration) so a remote task runs on the same provider/model the front-end picked. |
| `sendMessage(taskId, message)`                                      | Send a follow-up message to a running task.                                                                                                                                              |
| `cancelTask(taskId)`                                                | Abort a task.                                                                                                                                                                            |
| `respondToAsk(taskId, AskResponse)`                                 | Answer an outstanding `ask` (interactive tool approval / follow-up). The reverse of the `ask` events on the stream, so a remote task's approvals round-trip like a local one's.          |
| `subscribe(listener)` → `unsubscribe`                               | Subscribe to the agent event stream ([`ServerEvent`](#event-model)).                                                                                                                     |

### Reverse data channel (Shofer Nodes L3)

Checkpoints + the changed-files panel for a **remote (shadow) task** — the controller
fetches data / runs ops on the owning executor exactly like a local task drives its own
in-process service:

| Method                                                           | Purpose                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `getCheckpointDiff(taskId, opts)` → `CheckpointDiffEntry[]`      | Compute a checkpoint diff on the executor.                            |
| `restoreCheckpoint(taskId, opts)`                                | Rewind the task to a checkpoint on the executor.                      |
| `getTaskChangedFiles(taskId)` → `ChangedFilesPayload`            | The task's changed-files panel payload.                               |
| `getChangedFileDiff(taskId, relPath)` → `{ original, final }`    | Base + final content for one file (diff editor).                      |
| `revertChangedFile` / `revertAllChangedFiles(taskId[, relPath])` | Revert one / every changed file to base.                              |
| `acceptChangedFile` / `acceptAllChangedFiles(taskId[, relPath])` | Promote one / every changed file's current state to the new baseline. |

### Event model

`subscribe()` delivers `ServerEvent { type: string; …event-specific }` — a **superset,
open-ended** stream (assistant text, reasoning, tool-call start/result, asks, task
lifecycle, token usage, changed-files, …). Front-ends match on `type`. An `ask` event is
answered back via `respondToAsk` (`AskResponse { askResponse, text?, images?, askId? }`).

Transports project this stream onto their own shape: HTTP/SSE emits it verbatim over SSE;
ACP maps the common cases onto its typed `session/update` variants and wraps the rest as
`passthrough` (see [acp.md](./acp.md#event-mapping)).

## HTTP/SSE binding

Shofer's **native, full-fidelity** transport (`transport/http-server.ts`), used by Shofer
Nodes. All routes under `/api/v1` except `/health`; bearer-token auth + version handshake.

```
GET  /health                      liveness + version + load metrics (open)
GET  /api/v1/whoami               { version } (authed; one-shot liveness+auth)
GET  /api/v1/event                SSE event stream            → subscribe()
POST /api/v1/task                 { prompt, taskId?, apiConfiguration? } → createTask()
POST /api/v1/task/:id/message     { message }                 → sendMessage()
POST /api/v1/task/:id/cancel                                  → cancelTask()
POST /api/v1/task/:id/ask         AskResponse                 → respondToAsk()
POST /api/v1/task/:id/checkpoint-diff       CheckpointDiffOptions → CheckpointDiffEntry[]
POST /api/v1/task/:id/checkpoint-restore    CheckpointRestoreOptions
GET  /api/v1/task/:id/changed-files                          → ChangedFilesPayload
POST /api/v1/task/:id/changed-files/diff    { relPath }      → { original, final }
POST /api/v1/task/:id/changed-files/revert  { relPath? }     (one file, or all when omitted)
POST /api/v1/task/:id/changed-files/accept  { relPath? }     (one file, or all when omitted)
```

Run it: `shofer serve` (headless executor). The controller connects with `ShoferHttpClient`.

## Per-task API Configuration

A remote node runs each task on the **API Configuration the controlling front-end picked
for that task** — resolved controller-side (named profile → mode's profile → global
default) and shipped in `createTask`'s `apiConfiguration`. It can differ per task, and it
carries the provider/model/base-URL/key (over the bearer-token-authed channel), so the
node needs no provider setup of its own. This is what lets a controller point every node
at a shared endpoint (e.g. an `llm-router` service reachable from both hosts).

**Manual override.** Start the node with any of `--provider` / `--model` / `--api-key` /
`--base-url` and it pins to that config: the incoming per-task `apiConfiguration` is
ignored and the node's own config always wins. With none of those flags, the node defers
to the controller (per task). The gate is computed once at boot (`serve.ts` →
`allowClientConfig`) and enforced in `ShoferApiAgent.createTask`; the in-process Local
adapter never receives a remote config (it reads the provider's live config directly).

## Where plugins fit

The [plugin system](../PLUGINS.md) runs **inside** the core agent, so plugin _behavior_
(contributed tools, `transformSystemPrompt`, lifecycle hooks) is baked into what the core
emits over `AgentApi` — it rides **any** binding transparently (given the executor host
wired the plugin `ctx` seams). Plugin **UI** (badge, panel, settings, `ctx.ui`) is a
VS-Code-webview concern wired in `ShoferProvider` over `postMessage`; it is **not** part of
`AgentApi` and does not cross any of these transports. A non-VS-Code front-end gets plugin
behavior, not plugin UI, unless it implements its own plugin-UI host.

## See also

- [acp.md](./acp.md) — the ACP adapter and how it differs from this surface.
- [v3_architecture.md](./v3_architecture.md) — host boundary + distributed execution (Shofer Nodes).
- [public_api.md](./public_api.md) / [headless.md](./headless.md) — the `ShoferAPI` / CLI surface `ShoferApiAgent` is built on.
