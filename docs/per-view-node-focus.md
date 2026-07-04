# Per-view task focus (Shofer Nodes)

When a remote-node task runs, the extension can show it in one webview view while
another view (the sidebar, or a separate editor tab) shows a *different* task —
without the two swapping. This describes what focus is per-view versus global and
how it works.

## Terminology

"**Provider**" here means a **`ShoferProvider`** (`src/core/webview/ShoferProvider.ts`)
— the extension-side class that backs one webview view. There is one instance per
webview surface: the sidebar, plus each editor tab opened via `openShoferInNewTab`.
So "per-provider" == "**per-view / per-webview**". It is NOT an LLM provider and NOT
a Shofer *node*.

## What is per-view vs global

- **Remote-task (shadow) focus is per-view.** Each view tracks its own focused
  remote-task shadow, so the sidebar can stream a local task while a separate editor
  tab streams a remote-node task at the same time.
- **Local-task focus is global.** The local current task (the task stack /
  `getCurrentTask()`) is shared across views; a view not focused on a shadow renders
  the global local current task.

## How it works

- `NodeRegistry` holds `focusedShadows: Map<NodeProviderHost, taskId>` (the provider
  object reference is the key — no separate id). A view absent from the map renders
  the global local current task.
- `ShoferProvider.getStateToPostToWebview` resolves the shadow override from *this*
  view via `nodeRegistry.getFocusedShadow(this)`, so a full-state push from view A
  (no shadow) renders A's local task while view B (shadow) renders its shadow — the
  two never swap.
- Shadow render deltas (message append/update, token usage, changed-files, restore
  rebuild) **fan out** only to the view(s) focused on that shadow.
- A view focuses a shadow by **starting** a remote task from it (the `routeNewTask`
  initiator). Closing a view (`detachProvider`) releases its shadow focus; the shadow
  keeps buffering in `NodeRegistry.shadows` for any other view.

## Performance / scale

Bounded by the number of open **views**, not the number of tasks:

- The webview (FE) holds only the **focused** task's `shoferMessages` array;
  background tasks' messages live extension-side in their `Task` objects (local) or in
  `RemoteTaskShadow` buffers inside `NodeRegistry` (remote). Streaming deltas reach the
  FE only for the focused task.
- With per-view focus, each view holds *its own* focused task's array, and each view is
  a separate webview with its own memory. So **N open views ⇒ N arrays** (N realistically
  1–3), independent of how many tasks run.
- The real "hundreds of tasks" cost is **extension-side and already exists** independent
  of this feature: each running task is a `Task` object (local) or a shadow buffer + a
  slot in the merged `ExecutorPool` event feed (remote). Mitigations (evict/cap idle
  shadow buffers, `hasMoreShoferMessages` pagination) are extension-side and orthogonal
  to per-view focus.

## Tests

`src/core/nodes/__tests__/NodeRegistry.spec.ts` covers the non-clobber invariant:
focusing a remote shadow in view B leaves view A's focus empty and posts deltas only to
B; detaching a view clears its shadow focus (the shadow keeps buffering); single-view
behavior is unchanged (the map has ≤1 entry).

## Future work

- **Focus an existing shadow per view** — let the `TaskSelector` / `showTaskWithId`
  path point a specific view at an already-buffered shadow (today a view only focuses the
  shadow it itself started via `routeNewTask`).
- **Per-view local focus** — making local-task focus per-view requires the current-task
  notion (the task stack / `getCurrentTask()`) to stop being a single global, so
  editor-tab views can hold their own local task. Re-audit any `postMessageToWebview`
  broadcast when that lands.
