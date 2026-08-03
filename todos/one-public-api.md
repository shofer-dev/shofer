# One public API — `ShoferExtensionApi extends ShoferApi`

> **Status: ✅ DONE (shofer 2.47.0).** The ordering below is the record of what
> was done.

## The decision

There is **one root control contract**, and the plain name belongs to it:

```ts
// packages/types/src/shofer-api.ts   (was shofer-api.ts / `ShoferApi`)
export interface ShoferApi { … }               // task-addressed, DTO-only, what transports bind

// packages/types/src/api.ts          (was `ShoferExtensionApi`)
export interface ShoferExtensionApi extends ShoferApi, EventEmitter<ShoferEvents> { … }
```

Two renames and one `extends`:

| Today                | Becomes              | Why                                                                                                                 |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ShoferApi`          | `ShoferApi`          | The primary contract — every transport binds it, most consumers want it — gets the plainest, most discoverable name |
| `ShoferExtensionApi` | `ShoferExtensionApi` | The VS Code-host-only superset is the qualified, narrower thing; its name should say so                             |

**Why the `extends` at all.** Today the two interfaces are unrelated
declarations that overlap by hand, and the overlap is where the bugs live.
`ShoferExtensionApi` is _current-task-oriented_ (`cancelCurrentTask()`,
`pressPrimaryButton()`, `sendMessage(message?, images?, taskId?)`) — a shape
inherited from the webview, which has exactly one focused task. `ShoferApi` is
_task-addressed_: every method leads with `taskId`, because a client
multiplexes concurrent tasks and has no "current". The task-addressed model
already won on evidence — the current-task delivery path raced concurrent tasks
and dropped messages on headless hosts (the note survives in
`shofer-api-agent.spec.ts`).

With `extends`, the subset relationship is enforced by the compiler instead of
by prose, and "what is safe to expose remotely" stays answered structurally: a
transport binds the **base** interface, so the host-only surface cannot leak
onto the wire by accident.

> **Do both renames in ONE change.** `ShoferExtensionApi` and `ShoferApi` differ only in
> case; a tree where both exist is a trap for greps, imports and reviewers.
> There must be no intermediate commit in which both names are live.

## The two halves of today's `ShoferExtensionApi`

| Half                    | Members                                                                                                                                         | Fate                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Control**             | `startNewTask`, `sendMessage`, `cancelCurrentTask`, `pressPrimaryButton`/`pressSecondaryButton`, `respondToAsk`, `pluginRequest`, task events   | Becomes the inherited `ShoferApi` surface (below)           |
| **Host administration** | provider-profile CRUD, config import/export, task-history mutation (rename/archive/pin/delete/show), inline exports, `getOutputLogs`, workflows | Stays — this is what `ShoferExtensionApi` _adds_, host-only |

The administration half deliberately gets no wire counterpart: a host's
configuration is provisioned, never pushed over the wire.

## Member-by-member

| `ShoferApi` member                  | Today in `ShoferExtensionApi`               | Action                                                                        |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `createTask({prompt, mode, …})`     | `startNewTask({text, initialMode, …})`      | Adopt `createTask`; delete `startNewTask`                                     |
| `cancelTask(taskId)`                | `cancelCurrentTask()`                       | Adopt `cancelTask`; delete `cancelCurrentTask`                                |
| `sendMessage(taskId, message)`      | `sendMessage(message?, images?, taskId?)`   | **Signature conflict — the one real blocker.** See below                      |
| `respondToAsk(taskId, response)`    | same shape                                  | Already compatible — nothing to do                                            |
| `pluginRequest(taskId, …)`          | identical                                   | Already compatible — nothing to do                                            |
| `getTaskSnapshot(taskId)`           | absent                                      | Implement on `API` (it already has `getTaskConversation`/history)             |
| `subscribe(listener) → unsubscribe` | absent (`EventEmitter`)                     | Implement over the emitter — the logic already exists in `ShoferApiAgent`     |
| —                                   | `pressPrimaryButton`/`pressSecondaryButton` | Delete; they are `respondToAsk(taskId, {askResponse: "yes/noButtonClicked"})` |

**The `sendMessage` conflict.** TypeScript refuses the `extends` while the two
signatures disagree, so this is the gating change: the extension API adopts the
task-addressed form, and `ShoferApi.sendMessage` grows an optional
`images?: string[]` (the webview sends images with follow-ups; data URIs are
already what `AskResponse` carries, so it is wire-safe). Resolve this first —
everything else in the table is additive or already compatible.

## Call sites

**Rename `ShoferApi` → `ShoferApi`:** `packages/types/src/shofer-api.ts` (rename
the file to `shofer-api.ts`) and its `index.ts` export, plus every implementer
and type reference — `ShoferApiAgent`, `ShoferHttpClient`, `createHttpServer` /
`createRequestHandler`, `AcpAgentServer` and the ACP entry points, the
attachment primitive from Phase 2, and their specs. Mechanical; the compiler
finds all of it.

**Rename `ShoferExtensionApi` → `ShoferExtensionApi`:** `packages/types/src/api.ts`,
`src/extension/api.ts`, the CLI's `ExtensionHost` (`host.api`), the IPC layer,
and `docs/shofer-api.md`. Note this renames the type companion extensions
consume (the `activate()` export object itself is unchanged).

**Migrate off the current-task methods:**

- `src/core/webview/ShoferProvider.ts` — `cancelCurrentTask` use.
- `apps/cli/src/agent/extension-host.ts` — the control-plane bridge
  (`runTask`/`cancelTask`/`sendMessage`/`approveAction`/`rejectAction`).
- `apps/cli/src/ui/hooks/useGlobalInput.ts` — TUI cancel.
- `apps/cli/scripts/api_test_runner.ts`.
- ~12 suites under `apps/vscode-e2e/src/suite/` that drive `startNewTask` /
  `cancelCurrentTask` directly, plus the unit specs beside each file above.

**`packages/core/src/transport/shofer-api-agent.ts` mostly dissolves.** With no
translation left to do, what remains is policy: the `allowClientConfig` gate on
per-task `apiConfiguration` and the forwarded-event filter. Keep a thin class
for those or fold them into the `serve` entrypoint — decide once the
translation is gone. (If it survives, rename it: `ShoferApiAgent` next to
`ShoferApi` reads like the same thing.)

## Consequences

- One inheritance chain, so a method cannot exist on the wire contract without
  existing on the extension API.
- Bump the minor version — the extension API's shape changes.

### One doc: `docs/shofer-api.md`

`shofer-api.md`, `shofer-api.md` **and `shofer-api.md`** collapse into a single
`docs/shofer-api.md` — one place answering "how do I drive Shofer
programmatically", in the order the contract nests:

1. **`ShoferApi`** — the root contract: the method set, the event model, the
   ask-brokering rule.
2. **Transport bindings** — the HTTP/SSE routes, auth + version handshake,
   `shofer serve` flags.
3. **`ShoferExtensionApi`** — the host-only additions (profiles, config
   import/export, history management, exports, logs, workflows) and how a
   companion extension or the CLI acquires it.
4. **ACP** — the adapter onto the external Agent Client Protocol: the method
   map, the event/permission mapping, and what it cannot express.

The ACP section keeps one property the others do not, and the doc must say so
where it lives: **that contract is not ours.** Its method set and version come
from upstream, so a change there is tracking someone else's standard, not
designing ours — which is exactly why it is the last section rather than
interleaved with the root contract.

## Ordering

1. `ShoferApi.sendMessage` gains `images?`; the extension API adopts the
   task-addressed signature; migrate its call sites. Tree green.
2. Add `createTask`/`cancelTask`/`subscribe`/`getTaskSnapshot` to the
   implementation; migrate call sites off `startNewTask`/`cancelCurrentTask`/
   `pressPrimaryButton`/`pressSecondaryButton`; delete them (no compatibility
   aliases — the repo's no-back-compat rule). Tree green.
3. Declare the `extends`; strip what `ShoferApiAgent` no longer translates.
4. **Both renames in one commit** (`ShoferApi` → `ShoferApi`, `ShoferExtensionApi` →
   `ShoferExtensionApi`), including the `shofer-api.ts` → `shofer-api.ts` file
   move.
5. Merge the two docs; bump the minor version.
