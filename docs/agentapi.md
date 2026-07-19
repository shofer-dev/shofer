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

| Method                                                                    | Purpose                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTask({ prompt, mode, taskId?, apiConfiguration? })` → `{ taskId }` | Start a task. `mode` (**required**) is the mode slug it runs in. `apiConfiguration` ships the controller's resolved [API Configuration](#per-task-api-configuration) so a remote task runs on the same provider/model the front-end picked. |
| `sendMessage(taskId, message)`                                            | Send a follow-up message to a running task.                                                                                                                                                                                                 |
| `cancelTask(taskId)`                                                      | Abort a task.                                                                                                                                                                                                                               |
| `respondToAsk(taskId, AskResponse)`                                       | Answer an outstanding `ask` (interactive tool approval / follow-up). The reverse of the `ask` events on the stream, so a remote task's approvals round-trip like a local one's.                                                             |
| `subscribe(listener)` → `unsubscribe`                                     | Subscribe to the agent event stream ([`ServerEvent`](#event-model)).                                                                                                                                                                        |

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
GET  /api/v1/event                SSE event stream (node-wide: ALL tasks) → subscribe()
GET  /api/v1/task/:id/event       SSE event stream filtered to ONE task   → subscribe() + filter
POST /api/v1/task                 { prompt, mode, taskId?, apiConfiguration? } → createTask()
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

`GET /api/v1/event` is the whole node's firehose — every task's events. `GET
/api/v1/task/:id/event` is the same SSE filtered to one task (by `args[0]` /
`args[0].taskId`). A controller multiplexing many users' tasks on a **shared**
executor subscribes per authorized task, so it never receives — or has to demux —
other tenants' content; the node-wide stream stays for single-tenant / whole-node
consumers.

## Running `shofer serve`

`shofer serve` boots the headless executor and exposes the surface above; a controller
connects with `ShoferHttpClient`. Every option is a CLI flag (defined in
[`apps/cli/src/index.ts`](../apps/cli/src/index.ts), handled in
[`commands/cli/serve.ts`](../apps/cli/src/commands/cli/serve.ts)):

| Flag                     | Default                                          | Meaning                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --port <port>`      | `30099`                                          | Port to listen on.                                                                                                                                                                                                                                                                     |
| `--host <host>`          | `127.0.0.1`                                      | Bind address. **Use `0.0.0.0` to accept traffic from outside the process** (e.g. in a container).                                                                                                                                                                                      |
| `-w, --workspace <path>` | cwd                                              | Workspace directory. Custom modes are read from `<workspace>/.shofer/shofermodes`.                                                                                                                                                                                                     |
| `-e, --extension <path>` | auto (`ROO_EXTENSION_PATH` → sibling `src/dist`) | Path to the built extension bundle (`extension.js`).                                                                                                                                                                                                                                   |
| `--provider <provider>`  | `openrouter`                                     | LLM provider. Any of `--provider/--model/--api-key/--base-url` **pins** the node to that config (per-task `apiConfiguration` from the controller is then ignored).                                                                                                                     |
| `-m, --model <model>`    | provider default                                 | Model id. The `shofer` provider has **no** default model — pass one or task creation errors.                                                                                                                                                                                           |
| `-k, --api-key <key>`    | –                                                | Provider API key.                                                                                                                                                                                                                                                                      |
| `--base-url <url>`       | –                                                | Provider base URL (e.g. `http://llm-router:3000/v1`).                                                                                                                                                                                                                                  |
| `-t, --token <token>`    | `$SHOFER_NODE_TOKEN`                             | Bearer token required on every `/api/v1/*` call. Omit for an open (dev) node.                                                                                                                                                                                                          |
| `--interactive`          | off                                              | **Approval mode.** Off = non-interactive: the node **auto-approves every tool** (no local user to ask). On = the node surfaces approvals — `autoApprovalEnabled` is off, so a dangerous tool raises an `ask` over AgentApi that the controller brokers to its user via `respondToAsk`. |
| `-q, --quiet`            | off                                              | Suppress the per-task activity log on stderr.                                                                                                                                                                                                                                          |
| `-d, --debug`            | off                                              | Debug logging to `~/.shofer/cli-debug.log`.                                                                                                                                                                                                                                            |

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
