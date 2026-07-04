# TODO: Independent per-view focus for Shofer Nodes (split-view)

Follow-up to the Shofer Nodes work (L1/L2).

## Status

- **DONE — per-view SHADOW focus (the shadow-first increment).** REMOTE-task
  (shadow) focus is now **per-view**: each `ShoferProvider` webview tracks its
  own focused shadow, so the sidebar can show a local task while a separate
  editor tab streams a remote-node task without the two clobbering each other.
- **REMAINING (future):** focusing an *existing* shadow via the
  TaskSelector / `showTaskWithId` (v1 only focuses the shadow the view itself
  *started*, via `routeNewTask`), and **per-view LOCAL focus** (local
  current-task focus stays GLOBAL for now).

## Goal

Let the **sidebar** and a **separate editor tab** (`openShoferInNewTab`)
show two *different* tasks at once — e.g. a local task in the sidebar
while a remote-node task streams in the editor tab.

## Current behavior (after the shadow-first increment)

- `NodeRegistry` holds a per-view map `focusedShadows: Map<NodeProviderHost,
  taskId>` (the provider object reference is the key — no separate id) —
  `src/core/nodes/NodeRegistry.ts`. A view absent from the map renders the
  GLOBAL local current task (unchanged behavior).
- `ShoferProvider.getStateToPostToWebview` resolves the shadow override from
  *this* view via `nodeRegistry.getFocusedShadow(this)`, so a full-state push
  from view A (no shadow) renders A's local task while view B (shadow) renders
  its shadow — the two never swap.
- Shadow render deltas (Message append/update, token usage, changed-files,
  restore rebuild) **fan out** only to the view(s) focused on that shadow.
- v1 focus mechanism is the **`routeNewTask` initiator**: starting a remote
  task from a view focuses the new shadow in *that* view. A view that closes
  (`detachProvider`) releases its shadow focus; the shadow keeps buffering in
  `NodeRegistry.shadows` for any other view.

The local current-task focus is still a single global (the task stack /
`getCurrentTask()`), so per-view LOCAL focus remains future work.

## Terminology

"**Provider**" here means a **`ShoferProvider`** — the extension-side
class (`src/core/webview/ShoferProvider.ts`) that backs one webview view.
There is one instance per webview surface: the sidebar, plus each editor
tab opened via `openShoferInNewTab`. So "per-provider" == "**per-view /
per-webview**". It is NOT an LLM provider and NOT a Shofer *node*.

## Remaining design (future increments)

- **Focus an EXISTING shadow per view** — the TaskSelector / `showTaskWithId`
  path should be able to point a specific view at an already-buffered shadow
  (v1 only focuses the shadow the view itself created via `routeNewTask`).
- **Per-view LOCAL focus** — the harder half: a per-view local focus needs
  the current-task/focus notion (the task stack / `getCurrentTask()`) to stop
  being a single global, so editor-tab views can hold their own local task.
- **State-push fan-out audit** — the shadow delta/full-state sites are already
  per-view; re-audit any remaining `postMessageToWebview` broadcast when local
  focus goes per-view.

## Tests

- DONE — Two providers attached; focusing a remote shadow in provider B leaves
  provider A's focus (`getFocusedShadow(a)`) empty and posts deltas only to B,
  across the demux — `src/core/nodes/__tests__/NodeRegistry.spec.ts`.
- DONE — Detaching a view clears its shadow focus; the shadow keeps buffering.
- DONE — Local-only, single-view behavior unchanged (the map has ≤1 entry, so
  behavior is byte-for-byte identical; existing suites stay green).

## Acceptance

- Sidebar shows task A, editor tab shows remote-node task B, simultaneously;
  a state push from either view does not swap the other's conversation.
  (Met for the remote-shadow case; per-view LOCAL focus is future.)

## Performance / scale

This feature is bounded by the number of open **views**, not the number
of tasks:

- The webview (FE) holds only the **focused** task's `shoferMessages` array;
  background tasks' messages live extension-side in their `Task` objects
  (local) or in `RemoteTaskShadow` buffers inside `NodeRegistry` (remote).
  Streaming deltas reach the FE only for the focused task.
- With per-view focus, each view holds *its own* focused task's array, and
  each view is a separate webview with its own memory. So **N open views ⇒ N
  arrays** (N realistically 1–3), independent of how many tasks run.
- The real "hundreds of tasks" cost is **extension-side and already exists**
  independent of this feature: each running task is a `Task` object (local) or
  a shadow buffer + a slot in the merged `ExecutorPool` event feed (remote).
  Mitigations (evict/cap idle shadow buffers, `hasMoreShoferMessages`
  pagination) are extension-side and orthogonal to per-view focus.

## Notes

- Scope of the *remaining* work is broader than nodes code — per-view LOCAL
  focus touches Shofer's global current-task/focus + state-push model.
- No back-compat shims (owner constraint). Bump extension **minor** when the
  next increment ships.
