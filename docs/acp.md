# ACP — Agent Client Protocol (inbound)

> **📐 Proposed (foundation landed).** The pure shofer↔ACP mapping
> ([`src/acp/acp-mapping.ts`](../src/acp/acp-mapping.ts)) is implemented and
> tested; the `shofer acp` stdio entrypoint + `@agentclientprotocol/sdk` wiring is
> the remainder, gated on §9 (host-agnostic core) so the agent runs without VS
> Code. See `todos/opencode_inspired_work.md` §12.

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

## Remaining work

1. Add `@agentclientprotocol/sdk`; implement the `packages/.../acp/` service over
   it using the mapping above.
2. Ship a `shofer acp` stdio entrypoint (mirroring `opencode acp`).
3. Depends on §9: the agent must run host-agnostic (no `vscode`) for an ACP
   client to drive it. Reuses §3 (events → `sessionUpdate`), §4 (permissions →
   `requestPermission`), §6 (cancel) — so most of the mapping already exists.
