# Controller → Node Configuration Sync (Design)

**Status:** Implemented (branch `feat/config-sync`). This doc is the spec; the implementation follows it.
**Owner:** —
**Related:** [`v3_architecture.md`](v3_architecture.md), [`settings_overlay.md`](settings_overlay.md), [`agentapi.md`](agentapi.md), [`headless.md`](headless.md), [`outside-workspace-path-allowlist.md`](outside-workspace-path-allowlist.md) (a consumer)

---

## 1. Problem

In the [Shofer Nodes](v3_architecture.md#distributed-execution-horizontal-scaling) model, a
task can run on a **remote executor** (`shofer serve` on another host). The agent core —
including every decision that reads settings — runs **on that executor**, not on the
controller's VS Code front-end. Today the shipped node model **serves config
executor-locally**: a node evaluates against _its own_ local state.

That means controller-side configuration does **not** reach the node. Consequences:

- **Auto-approval** (`checkAutoApproval`, `@shofer/core`) reads `provider.getState()` on the
  executor. A path/command the user trusts in the controller's Settings UI is invisible to a
  remote node, which will re-prompt (RPC an ask back to the controller) or diverge.
- Any other node-scoped setting the front-end owns (context-management thresholds,
  write-delay, followup timeout, disabled tools, …) is likewise stranded.

The **only** controller→executor configuration that flows today is **per-task provider
config**: `CreateTaskInput.apiConfiguration`
([`agent-api.ts:35`](../packages/types/src/agent-api.ts)), applied by `ShoferApiAgent.createTask`
([`shofer-api-agent.ts:60`](../packages/core/src/transport/shofer-api-agent.ts)) so a task
runs on the same provider/model the front-end picked. Everything else is executor-local.

We want the node to require **zero local administration**: the user (or an external service)
configures once, **on the controller**, and it propagates.

## 2. Goal & principle

**Controller-authoritative configuration; nodes are replicas.**

- Configure trust/behavior **once on the controller**; it replicates to every node.
- **On registration** and **on every change** — so a node is correct the moment it connects
  and stays correct as settings change mid-session (no restart, no node-side edit).
- **Generalize the existing `apiConfiguration` pattern** — same idea (controller-resolved
  state the executor must honor), lifted from _per-task provider config_ to _node-scoped
  settings replicated continuously_.
- **No new source of truth.** The controller's globalState (`globalSettingsSchema`) stays
  authoritative; this is a _transport_ that mirrors a slice of it onto nodes.

Non-goals: syncing per-task provider config (that stays on `CreateTaskInput.apiConfiguration`
— it is per-task, not node-scoped); a bidirectional/merge model (nodes never push settings
up); the future split-host `HostConfig`-over-RPC model ([§9](#9-relationship-to-other-mechanisms)).

## 3. What is synced (and what is not)

Two axes decide whether a setting belongs on this channel:

| Setting kind                                          | Channel                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Per-task** provider/model/key/base-url              | Stays on `CreateTaskInput.apiConfiguration` (already shipped; can differ per task) |
| **Node-scoped** behavior settings (auto-approval, …)  | **This channel** — one node-wide config, replicated on registration + on change    |
| **LLM provider keys**                                 | _Not_ on this channel — per-task via `apiConfiguration` (see below)                |
| **Code-index (RAG) credentials**                      | **This channel**, as the separate `SyncedSecrets` argument → SecretStorage         |
| **Front-end-only** UI state (pinned tabs, dismissals) | Not synced (no executor effect)                                                    |

**In scope (v1): the whole node-scoped `globalSettings` set** — _every_ `globalSettingsSchema`
field that changes how the agent core behaves on the executor, not just the auto-approval
ones. Concretely that includes:

- **Auto-approval** (the motivating consumer): `autoApprovalEnabled`,
  `alwaysAllowReadOnly`/`Write`/`Browser`/`Mcp`/`ModeSwitch`/`Subtasks`/`Execute`/`Uncategorized`,
  the modifier toggles (`alwaysAllow*OutsideWorkspace`, `alwaysAllowWriteProtected`),
  `allowedCommands`/`deniedCommands`, the
  [path allowlist](outside-workspace-path-allowlist.md) (`allowedReadPaths`/`allowedWritePaths`),
  `followupAutoApproveTimeoutMs`.
- **Behavioral limits & context management** — `allowedMaxRequests`, `allowedMaxCost`,
  `autoCondenseContext`, `autoCondenseContextPercent`, `writeDelayMs`,
  `consecutiveMistakeLimit`, `commandExecutionTimeout`/`commandTimeoutAllowlist`,
  `preventCompletionWithOpenTodos`, `disabledTools`, environment-detail toggles, …

The synced slice is a **positive allowlist** (`SyncedSettings`), not "all of `GlobalSettings`
minus exclusions" — a newly added setting is _not_ silently synced until it is classified,
safer than an implicit catch-all.

**Encode the scope in the schema so the classification is authored once and never re-done.**
Rather than a hand-maintained `Pick<GlobalSettings, …>` that drifts every time a setting is
added, annotate each key's scope **at the schema**, co-located with `globalSettingsSchema` in
[`global-settings.ts`](../packages/types/src/global-settings.ts), and **derive** the synced
key list + `SyncedSettings` type from it. This mirrors the file's existing key-classification
pattern (`GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof().options`,
[`global-settings.ts:338`](../packages/types/src/global-settings.ts); the `SECRET_STATE_KEYS`
array + `isSecretStateKey` predicate, `:351`/`:399`). Concretely:

```ts
// Exhaustive over every globalSettings key — TS errors if a key is missing or misspelled,
// so adding a setting FORCES declaring its sync scope (no silent default, no future pass).
export const SETTING_SYNC_SCOPE = {
	autoApprovalEnabled: "node",
	alwaysAllowWrite: "node",
	allowedCommands: "node",
	allowedReadPaths: "node",
	allowedMaxCost: "node",
	writeDelayMs: "node" /* … */,
	pinnedApiConfigs: "frontend",
	dismissedUpsells: "frontend",
	taskHistory: "frontend",
	// per-task/provider selection is shipped via apiConfiguration, not this channel:
	apiProvider: "perTask",
	apiModelId: "perTask" /* … */,
} satisfies Record<(typeof GLOBAL_SETTINGS_KEYS)[number], "node" | "frontend" | "perTask">

export const SYNCED_SETTINGS_KEYS = GLOBAL_SETTINGS_KEYS.filter((k) => SETTING_SYNC_SCOPE[k] === "node")
export type SyncedSettings = Pick<GlobalSettings, (typeof SYNCED_SETTINGS_KEYS)[number]>
```

The `satisfies Record<…>` is the key move: it makes the map **exhaustive over the live
schema**, so the "classification pass" is a _compile-time obligation on whoever adds a
setting_, not a periodic manual audit. (Zod 3.25's `.meta()` could instead carry the scope on
each field; the co-located `satisfies` map is chosen to match the file's existing
array+predicate idiom and to keep the exhaustiveness guarantee obvious.)

**Classification rule (two-part test).** A key is `"node"` iff **both**: (1) the behavior it
controls runs in `@shofer/core` on the executor — a fast proxy is "consumed under
`packages/core`" vs only `src/` (the controller); **and** (2) its value is host-portable — a
boolean/count/byte-cap/timeout, not a machine-specific path or a front-end-only integration.
Failing (1) → controller-only, `frontend` (e.g. `defaultCostLimit`, applied at task creation
on the controller — `allowedMaxCost` is the synced enforcement knob; `enableLlmProviderIntegration`,
a VS Code LM companion). Passing (1) but failing (2) → executor behavior but the node must own
its own value, still excluded (e.g. `execaShellPath`, a host shell path). Two further
exclusions: a key already shipped per-task via `apiConfiguration` (`rateLimitSeconds` — also a
`ProviderSettings` field) is left out to avoid a double source; and `mcpEnabled` is **held**
(not synced): in the shipped shared-workspace-FS node model the node already has the mirrored
project `.shofer/mcp.json` and launches **stdio** servers node-locally, so it _self-determines_
MCP — syncing the global toggle is unnecessary and could override a locally-correct node. The
genuine cross-host gaps are narrow — the **global** `mcp_settings.json` (in globalStorage,
outside the workspace, so not mirrored) and **loopback/controller-hosted** HTTP servers a
remote node can't reach — and both are out of config-sync's scope; revisit with remote-MCP
support. These calls are pinned by the `SETTING_SYNC_SCOPE` classification tests.

Both allow-lists, and where a key that is *not* on them goes instead:

```mermaid
flowchart TD
    KEYS["GLOBAL_SETTINGS_KEYS<br/>every globalSettingsSchema key"]
    SCOPE{"SETTING_SYNC_SCOPE[key]<br/>exhaustive — satisfies Record"}
    NODE["node — SYNCED_SETTINGS_KEYS<br/>type SyncedSettings"]
    FE["frontend — controller only<br/>pinnedApiConfigs, dismissedUpsells, taskHistory"]
    PT["perTask — rides CreateTaskInput.apiConfiguration<br/>apiProvider, apiModelId, ..."]
    SEC["SYNCED_SECRET_KEYS — type SyncedSecrets<br/>code-index RAG credentials only"]
    WIRE["applyConfig(config, version, secrets)"]

    KEYS --> SCOPE
    SCOPE --> NODE
    SCOPE --> FE
    SCOPE --> PT
    NODE --> WIRE
    SEC --> WIRE
```

**Excluded** (per [the table above](#3-what-is-synced-and-what-is-not)): per-task provider
config (`apiConfiguration`) and front-end-only UI state (`pinnedApiConfigs`,
`dismissedUpsells`, `lastShownAnnouncementId`, task history) that has no executor effect.

**Secrets travel on their own allow-list, not in `SyncedSettings`.** Credentials are never
plaintext *settings* — `SyncedSettings` carries none, and a secret key in that slice is a
bug. They ride the same `applyConfig` call as a separate `SyncedSecrets` argument, written
on the node through `ContextProxy.storeSecret` (SecretStorage), never into globalState JSON.
The allow-list is deliberately narrow: only the code-index (RAG) credentials, because a
search-only node must embed a query and authenticate to Qdrant, and both keys are secrets
rather than settings — so the synced index config would otherwise describe a store the node
cannot open. **LLM provider keys are NOT on this channel**: they already reach a node
per-task via `apiConfiguration` (resolved by the controller, gated by `allowClientConfig`),
and replicating them globally would create a second, unversioned source for the same
credential. Adding a key to `SYNCED_SECRET_KEYS` means the controller pushes it to every
managed node — justify it before extending the list.

## 4. Design

Three thin additions, each mirroring an existing seam.

### 4a. `AgentApi.applyConfig` (the wire method)

Add one method to the transport-agnostic surface
([`AgentApi`](../packages/types/src/agent-api.ts:54)):

```ts
/** Node-scoped settings + secrets the controller replicates to this executor (§config_sync).
 *  A Partial<GlobalSettings> restricted to the synced allowlist; authoritative
 *  (last-write-wins) for the keys present. `version` is the controller-assigned,
 *  node-opaque token (a content hash of the canonical slice, §6) the node stores
 *  and echoes back on /health so the controller can detect drift. `secrets` is the
 *  allow-listed credential slice the node needs to act on `config` — `{}` when there
 *  is nothing to replicate. Both are ignored when the node has local CLI overrides
 *  (allowClientConfig === false), same rule as apiConfiguration. */
applyConfig(config: SyncedSettings, version: string, secrets: SyncedSecrets): Promise<void>
```

`SyncedSettings` is a `Pick<GlobalSettings, …node-scoped keys…>` in `@shofer/types`
(vscode-free, so both sides share it) — the positive allowlist defined in
[§3](#3-what-is-synced-and-what-is-not) (auto-approval + behavioral/context-management keys),
not just the auto-approval subset. `SyncedSecrets` is its credential counterpart: a
`Partial<Record<SYNCED_SECRET_KEYS[number], string>>` over the code-index (RAG) credentials,
which are secrets rather than settings and so cannot ride in `SyncedSettings`. LLM provider
keys are deliberately NOT in it — they already travel per-task on
`CreateTaskInput.apiConfiguration`. Transport bindings follow the existing pattern exactly:

- **HTTP route** ([`http-server.ts`](../packages/core/src/transport/http-server.ts:58)):
  `POST /api/v1/config → { config, version, secrets } → 202` (token-authed like every
  `/api/v1/*` route; an absent `secrets` defaults to `{}`).
- **Client** ([`http-client.ts`](../packages/core/src/transport/http-client.ts)):
  `applyConfig(config, version, secrets) → this.post("/config", { config, version, secrets })`.

Because `ShoferHttpClient implements AgentApi`, adding the method to the interface makes
client/server drift a compile error (the property the doc-comment at
[`http-client.ts:17`](../packages/core/src/transport/http-client.ts) relies on).

### 4b. Node side — apply to local state

`ShoferApiAgent.applyConfig`
([`shofer-api-agent.ts`](../packages/core/src/transport/shofer-api-agent.ts)) writes the
slice into the node's in-process settings so the very next `provider.getState()` (and thus
`checkAutoApproval`) sees it:

```ts
async applyConfig(config: SyncedSettings, version: string, secrets: SyncedSecrets): Promise<void> {
  if (!this.options.allowClientConfig) return   // node CLI override wins — ignore, like apiConfiguration
  await this.api.applySyncedSettings(config)     // → ContextProxy.setValues(slice) on the node
  await this.api.applySyncedSecrets(secrets)     // → ContextProxy.storeSecret per allow-listed key
  this.appliedConfigVersion = version            // opaque; echoed on /health (§6) so the controller sees convergence
}
```

Credentials are written after the settings they belong to, so a node never briefly holds a
store/embedder config it has no key for. `applySyncedSecrets` iterates `SYNCED_SECRET_KEYS`
rather than the payload's own keys — the slice arrives as untrusted JSON off the wire, so
driving the loop from the allow-list is what stops a controller writing a secret outside the
synced scope. A key the controller omits is left untouched, not cleared.

Reuse the **same `allowClientConfig` gate** that already governs `apiConfiguration`
([`shofer-api-agent.ts:14`](../packages/core/src/transport/shofer-api-agent.ts)): a node
started with explicit CLI config is self-administered and ignores controller pushes; a
"managed" node (no overrides) is a pure replica. **For a `shofer serve` node the gate
defaults open** (accept controller config) — see [§10](#10-decisions--open-questions); it
flips closed only when the operator supplies explicit local config, so the zero-node-admin
replica is the default and self-administration is the opt-out. The node-side apply is a `ContextProxy.setValues`
of the slice (the same write path `importConfiguration` uses,
[`settings_overlay.md` §10c](settings_overlay.md)), **not** a full import (no provider
profiles; the only secrets written are the `SYNCED_SECRET_KEYS` allow-list).

### 4c. Controller side — push on registration + on change

`NodeRegistry` ([`src/core/nodes/NodeRegistry.ts`](../src/core/nodes/NodeRegistry.ts)) already
owns the connection lifecycle (`connections` map, each `NodeConnection` exposing `.api` when
`connected`, [`NodeRegistry.ts:140`](../src/core/nodes/NodeRegistry.ts)) and the load-balancer
config subscription ([`NodeRegistry.ts:213`](../src/core/nodes/NodeRegistry.ts)). Two hooks:

- **On registration** — when a node transitions to `connected` (its handshake completes,
  [`node-connection.ts`](../packages/core/src/transport/node-connection.ts)), push the current
  slice: `conn.api.applyConfig(resolveSyncedSettings())`. Do the same on **reconnect** (state
  on the node may be stale or a fresh process).
- **On change** — subscribe to controller settings mutations and **broadcast** the new slice
  to every `connected` connection. The triggers are the existing write points:

    - Settings panel save (`updateSettings`),
    - the interactive **“approve this path / command”** grant (which already posts
      `updateSettings`),
    - auto-import / `importConfiguration`.

    Hook the broadcast to the controller's post-mutation signal (the same
    `ContextProxy`/`postStateToWebview` beat that refreshes the webview), filtered to the synced
    keys so unrelated state changes don't spam nodes.

`resolveSyncedSettings()` reads the authoritative controller state (mirrors how the webview
resolves `apiConfiguration` before `pool.createTaskOn(owner, { apiConfiguration })`,
[`NodeRegistry.ts:311`](../src/core/nodes/NodeRegistry.ts)) and projects it to the slice.

### 4d. Flow

```mermaid
sequenceDiagram
    autonumber
    participant C as Controller — NodeRegistry
    participant N as Node — ShoferApiAgent
    participant P as ContextProxy on the node
    participant A as checkAutoApproval

    Note over C: a settings change, or a node connects / reconnects
    C->>C: currentSyncedSlice + currentSyncedSecrets
    C->>C: computeConfigVersion of config and secrets = desiredVersion
    C->>N: POST /api/v1/config — applyConfig with config, version, secrets
    alt allowClientConfig is false
        N-->>C: ignored — the node is self-administered
    else managed replica
        N->>P: applySyncedSettings then applySyncedSecrets
        N->>N: appliedConfigVersion = version
    end
    C->>N: GET /health, every ~15s
    N-->>C: loadavg, cpus, configVersion
    A->>P: provider.getState reads the applied slice
```

## 5. Semantics

- **Authoritative, last-write-wins** for the keys present in a payload. v1 ships the full
  slice each time (small, simple, idempotent); a future optimization may diff.
- **Node-override precedence.** `allowClientConfig === false` (node launched with CLI
  provider/model/key/base-url overrides) ⇒ the node ignores pushes entirely, consistent with
  `apiConfiguration`. (Open question: should _settings_ overrides be independent of
  _provider_ overrides? — [§10](#10-open-questions).)
- **Union with local grants?** No. Unlike the [path-allowlist doc's](outside-workspace-path-allowlist.md)
  intra-controller union of config + interactive grants, the _controller→node_ relationship
  is **replace**: the node mirrors the controller's resolved state. A managed node has no
  independent grants to preserve (interactive approvals on a node RPC back to the controller,
  which then re-broadcasts).
- **Version-locked.** Same guarantee as the whole session transport
  ([`v3_architecture.md`](v3_architecture.md#two-seams--and-why-category-i-pays-off-here)):
  a controller only drives a node on the exact same build (the `whoami` version check,
  [`node-connection.ts:197`](../packages/core/src/transport/node-connection.ts)), so
  `SyncedSettings` shape can't skew across versions.

## 6. Convergence — config version & pool gating

Fire-and-forget is not enough: a push can fail for one node while succeeding for others, and
a just-connected or reconnected node may hold stale config. The model is a **controller-driven
convergence loop keyed on a config version**, so that **no task is ever routed to a node
running stale config**, yet a lagging node self-heals without manual intervention.

**The version.** The controller computes
`desiredVersion = hash(canonicalSerialize({ config, secrets }))` — a **content hash**, not a
monotonic counter. Content-addressing makes it stateless (survives a controller restart with
no drift), idempotent (identical content ⇒ identical version ⇒ no spurious churn), and
**opaque to the node**: it travels _with_ the config
(`applyConfig(config, version, secrets)`, [§4a](#4a-agentapiapplyconfig-the-wire-method)), and
the node merely stores and echoes it — the two sides never need matching hash logic.

The **secrets participate in the hash**. Hashing the settings slice alone would leave a
rotated credential invisible to the convergence loop: the settings never changed, so the
version never moves, so the reconciliation never re-pushes and the node holds the stale key
indefinitely. Note the consequence for `/health`, below.

**Reporting (piggybacked on the health ping).** The node echoes its last-applied version on
the existing `GET /health` body, which already carries `loadavg`/`cpus` and is parsed every
~15 s by `NodeConnection.ping()`
([`node-connection.ts:253`](../packages/core/src/transport/node-connection.ts)). Add
`configVersion` alongside the load sample → the controller learns each node's applied version
**for free**, on a channel that already exists (and again on the `whoami` handshake for the
connect-time read). Expose it as `conn.configVersion`.

**Three node states** (a refinement of today's two):

| State                     | Connected? | In pool?                                                |
| ------------------------- | ---------- | ------------------------------------------------------- |
| `disconnected`            | no         | no (already excluded)                                   |
| **`connected` but stale** | yes        | **no** — new: excluded until it echoes `desiredVersion` |
| `connected` and current   | yes        | yes                                                     |

```mermaid
stateDiagram-v2
    [*] --> disconnected
    disconnected --> stale: connect or reconnect handshake
    stale --> current: echoes the desired version
    current --> stale: desiredVersion moves — a setting or a secret changed
    stale --> stale: health-ping mismatch, re-send applyConfig
    current --> disconnected: connection lost
    stale --> disconnected: connection lost

    note right of stale
        connected but out of sync: excluded from
        ExecutorPool assignment, still health-pinged.
        In-flight tasks keep running.
    end note
```

**Pool eligibility gains one clause.** Today the `ExecutorPool` admits a node when
`status === "connected" && !!conn.api` ([`NodeRegistry.ts:726`](../src/core/nodes/NodeRegistry.ts)).
Add: **`&& conn.configVersion === desiredVersion`**. An out-of-sync node is removed from the
pool (no _new_ task routing) but stays connected and health-pinged — **recoverable**.

**The loop.**

- **On any settings change** — the controller recomputes `desiredVersion`, broadcasts
  `applyConfig(slice, desiredVersion)` to all connected nodes, and drops from the pool any
  node whose reported version ≠ `desiredVersion` until it converges.
- **On each health ping** — the controller compares reported vs desired; on mismatch it
  **re-sends** `applyConfig` (idempotent) and keeps the node out of the pool. This is the
  self-heal path for a node whose earlier push failed.
- **On (re)connect** — `NodeConnection` re-probes with backoff and re-enters `connected`
  ([`node-connection.ts`](../packages/core/src/transport/node-connection.ts)); it reports its
  (stale) version, gets pushed, converges, and only then rejoins the pool.

**This subsumes the connect-time race** (the former "gate the first task on the first ack"
question): version-match gating covers connect, reconnect, and mid-session change with one
uniform rule — no defaults window, no special first-task case.

**In-flight tasks are not killed.** Pool removal means _no new assignment_; a task already
running on a now-stale node keeps running and picks up the new config on its next
`getState()` read once the node applies it (same as a local task reacting to a mid-task
settings change — no per-task snapshotting in v1). _Optional hardening:_ the controller
stamps `desiredVersion` on `createTask` and the node rejects a task whose expected version ≠
its applied version — defense-in-depth against a pool-gating race.

## 7. Security

- **Authed transport.** `applyConfig` rides the token-gated `/api/v1/*` surface
  ([`http-server.ts:104`](../packages/core/src/transport/http-server.ts)); an unauthenticated
  caller cannot push config (which could otherwise widen auto-approval on a node).
- **Narrow credential allow-list.** The only secrets on this channel are
  `SYNCED_SECRET_KEYS` — the code-index (RAG) credentials
  ([§3](#3-what-is-synced-and-what-is-not)). They are written to SecretStorage via
  `ContextProxy.storeSecret`, never to globalState JSON, and the receiving loop iterates the
  allow-list rather than the wire payload's keys, so a compromised or buggy controller cannot
  write a secret outside that scope. LLM provider keys stay off this channel entirely.
- **Blast radius.** This channel can grant readwrite/exec auto-approval on a node
  non-interactively — treat `resolveSyncedSettings` output with the same care as
  `allowedCommands: ["*"]`. It only ever carries what the controller already trusts locally.
- **Version lock** prevents a newer controller from pushing keys an older node would
  mis-apply.
- **The `configVersion` on `/health` is an opaque digest.** `/health` is unauthenticated
  ([`http-server.ts:99`](../packages/core/src/transport/http-server.ts)), but a content hash
  leaks no settings content — it only lets the controller (and any prober) see _whether_ a
  node is current, not _what_ the config is. Config **writes** stay on the authed
  `/api/v1/config` route.

  Since [§6](#6-convergence--config-version--pool-gating) folds the synced secrets into that
  hash, the digest is now taken over credential values too. It stays a 32-bit non-cryptographic
  FNV-1a digest of the *whole* slice, so it is not a practical oracle for any individual key —
  but it is **not** a secrecy boundary and must never be treated as proof of knowing a secret,
  nor compared against an attacker-supplied value to authorize anything. It exists solely so
  the controller can tell a converged node from a stale one.

## 8. Failure handling

The convergence loop ([§6](#6-convergence--config-version--pool-gating)) is the failure model;
this section is what it implies.

- **Partial-fleet failure (push succeeds for some, fails for others).** Node A applies and
  echoes `desiredVersion` → stays poolable. Node B's push fails → keeps echoing the old
  version → **removed from the pool**, so no task lands on it while stale. The health-ping
  comparison keeps re-sending `applyConfig` to B until it echoes `desiredVersion`, then
  re-admits it. Fully per-connection; one node's failure never blocks others.
- **Node offline** — already pool-excluded (`disconnected`); on reconnect it reports its stale
  version, gets pushed, and is version-gated back in.
- **Delivery guarantee** — at-least-once is sufficient: the slice is tiny and `applyConfig` is
  idempotent, and the periodic health-ping reconciliation is the backstop that eventually
  converges every reachable node. No exactly-once machinery.
- **Malformed payload** — the node validates against the `SyncedSettings` Zod pick, rejects
  (`4xx`) **without** advancing its applied version, and logs. It therefore stays out of the
  pool (still echoing the old version) rather than partially applying — a rejected push can't
  masquerade as converged.
- **Controller restart** — `desiredVersion` is recomputed from the controller's authoritative
  globalState (content hash), so it is identical across restarts for identical content; nodes'
  echoed versions reconcile against it with no drift (a key reason to hash rather than count).

## 9. Relationship to other mechanisms

| Mechanism                               | Role                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`CreateTaskInput.apiConfiguration`**  | Per-task provider config. Stays. This channel is its node-scoped, continuously-synced sibling.                                                                                                                                                    |
| **Auto-import / `importConfiguration`** | Bootstrap/whole-config import on a standalone executor (CLI, or a node pre-seed _stopgap_). Not controller-driven.                                                                                                                                |
| **`HostConfig` over RPC (future)**      | The split-host model where an executor reads the _controller's_ config live over Category I RPC. Would **supersede** this push model (config becomes pull-through, no replication). Deferred substrate; this channel is the shipped-model answer. |
| **CLI overrides (`allowClientConfig`)** | Escape hatch: a self-administered node opts out of controller config entirely.                                                                                                                                                                    |

This channel is the pragmatic fit for the **shared-workspace node model** shipped today; if
the split-host `HostConfig`-RPC model lands later, config replication can be retired in favor
of pull-through.

## 10. Decisions & open questions

### Decided

- **Node availability is gated on a successful config sync.** A node becomes poolable _only_
  after it has applied the current config and echoes `desiredVersion`; connected-but-stale
  nodes are excluded until they converge. This is the version-gating in
  [§6](#6-convergence--config-version--pool-gating) — there is no "defaults window."
- **v1 syncs the broader node-scoped `globalSettings` set**, not just the auto-approval slice
  — defined as the positive allowlist in [§3](#3-what-is-synced-and-what-is-not).
- **One gate, not two — and it defaults open.** The existing `allowClientConfig` flag governs
  whether a node honors _both_ the controller's per-task provider config and these synced
  settings — no separate `allowClientSettings` opt-out in v1. **A `shofer serve` node defaults
  to open** (accept controller config), so a freshly-provisioned node is a managed replica
  with zero node-side setup; it flips closed only when the operator supplies explicit local
  config (CLI overrides). _(This is a deliberate change from the flag's current code default
  of `false`, which today is only the in-process/local adapter's value —
  [`shofer-api-agent.ts:14`](../packages/core/src/transport/shofer-api-agent.ts).)_ Splitting
  the gate (front-end policy + node's own provider) is a later refinement if a use-case appears.
- **Full-slice pushes, not diffs.** Each push carries the entire `SyncedSettings` slice
  (last-write-wins, idempotent); no per-key diffing. The slice is tiny, so there is no
  payload/perf reason to complicate it, and the content-hash version works unchanged.
- **Live reads, not per-task snapshots.** A running task always reads current config via
  `getState()`; it does **not** freeze the config at task start. Matches local-task behavior —
  a mid-task settings change (or a controller broadcast) takes effect on the task's next read.

- **Scope is annotated in the schema, not re-derived each time.** Each `globalSettings` key
  declares its sync scope (`node` / `frontend` / `perTask`) in a co-located, `satisfies`-guarded
  map next to `globalSettingsSchema`; `SyncedSettings` is _derived_ from it
  ([§3](#3-what-is-synced-and-what-is-not)). Adding a setting is then a compile-time obligation
  to classify it — no recurring manual pass, no silent drift.

### Open

1. **One-time authoring of `SETTING_SYNC_SCOPE`** (implementation task, not a design question).
   Fill the scope map for the ~96 current `globalSettingsSchema` keys. This is a single pass
   done _once_ at implementation; the `satisfies Record<…>` guard keeps it correct thereafter,
   so it never needs repeating ([§3](#3-what-is-synced-and-what-is-not)).

```

```
