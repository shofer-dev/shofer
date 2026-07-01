# ACP — Agent Client Protocol (inbound)

> **✅ Implemented (adapter + entrypoint).** The full agent-side ACP path is built:
> the pure mapping ([`acp-mapping.ts`](../src/acp/acp-mapping.ts)), a JSON-RPC-2.0
> connection ([`acp-connection.ts`](../src/acp/acp-connection.ts)), the agent server
> ([`acp-agent-server.ts`](../src/acp/acp-agent-server.ts)) over the transport-agnostic
> `AgentApi`, and a **`shofer acp` CLI entrypoint** that runs it on stdio over a
> headless extension host. 19 tests. The wire framing is implemented directly (the
> upstream SDK is not in this environment's registry) and is swappable for
> `@zed-industries/agent-client-protocol` later. Not yet validated against a live
> ACP client. See `docs/v3_architecture.md` §12.

## What ACP is (and isn't)

ACP is a **standard inbound protocol**: any ACP-speaking client (Zed today; more
editors over time) can drive shofer as a backend agent with **zero per-editor
work**, instead of N bespoke editor integrations. It is distinct from:

- **MCP** — tools shofer _calls_ (outbound).
- shofer's own **multi-agent orchestration** (`new_task`, peer messaging).

ACP here is **agent-side** (clients drive shofer). Acting as an ACP _client_
(driving external ACP agents) is a separate, lower-priority direction.

## Mapping (the real work)

The wire protocol is off-the-shelf; the substance is mapping shofer's surface
onto ACP methods. Implemented in [`acp-mapping.ts`](../src/acp/acp-mapping.ts):

| ACP method          | shofer concept                                            |
| ------------------- | --------------------------------------------------------- |
| `initialize`        | capability negotiation                                    |
| `authenticate`      | provider credentials                                      |
| `newSession`        | create a `Task`                                           |
| `loadSession`       | resume a `Task` from history                              |
| `listSessions`      | task history                                              |
| `prompt`            | send a user message to the `Task`                         |
| `cancel`            | `Task.abortTask` (§6 structured cancellation)             |
| `setSessionMode`    | switch mode (§4 modes) — `shoferModeToAcpSessionMode`     |
| `setSessionModel`   | select model (§7 catalog)                                 |
| `requestPermission` | auto-approval decision → `toAcpPermissionOutcome` (§4)    |
| `sessionUpdate`     | typed events → `toAcpSessionUpdate` notifications (§3/§8) |

Pure mapping functions (all unit-tested in
[`__tests__/acp-mapping.spec.ts`](../src/acp/__tests__/acp-mapping.spec.ts)):

- `toAcpPermissionOutcome(decision)` — `approve`→allow-once, `deny`→reject,
  `ask`→client prompt.
- `toAcpSessionUpdate(event)` — assistant text / reasoning / tool-call /
  tool-result map to ACP update variants; anything else is wrapped as
  `passthrough` so no event is dropped.
- `shoferModeToAcpSessionMode` / `acpSessionModeToShoferMode` — 1:1 mode mapping.

## Implemented

- `acp-connection.ts` — a minimal JSON-RPC 2.0 peer over newline-delimited JSON
  (requests/notifications, in- and out-bound), the ACP framing.
- `acp-agent-server.ts` — `AcpAgentServer` binds the ACP method set (`initialize`,
  `session/new`, `session/prompt`, `session/set_mode`, `session/cancel`) to the
  transport-agnostic `AgentApi` via the mapping; forwards the event stream as
  `session/update` notifications; resolves a prompt turn on
  `TaskCompleted`/`TaskAborted`/`TaskError`.
- `runAcpAgentOverShoferApi` (exported from the extension bundle) → `ShoferApiAgent`
  → the ACP server; the `shofer acp` CLI command boots a headless host and runs it
  on stdin/stdout (`disableOutput` keeps stdout clean for the protocol).

## Remaining work

1. Swap the direct JSON-RPC framing for `@zed-industries/agent-client-protocol` once
   it's available in the registry (drop-in — `JsonRpcPeer` mirrors its connection).
2. Wire `session/request_permission` (agent→client) onto the auto-approval flow — the
   mapping (`toAcpPermissionOutcome`) exists; it needs an approval hook on `AgentApi`.
3. Validate end-to-end against a live ACP client (Zed); reconcile the raw event →
   `ShoferStreamEvent` normalization with the real message payload shapes.
