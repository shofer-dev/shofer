# TODO: Independent per-view focus for Shofer Nodes (split-view)

Follow-up to the Shofer Nodes work (L1/L2, see `docs/remote-agents.md`).
Deferred by decision — build only if side-by-side split-view is wanted.

## Goal

Let the **sidebar** and a **separate editor tab** (`openShoferInNewTab`)
show two *different* tasks at once — e.g. a local task in the sidebar
while a remote-node task streams in the editor tab. Today they can't:
both webviews share one focused task.

## Current behavior (why it's limited)

The render model is "one global current task", and remote-task focus
piggybacks on it:

- `NodeRegistry` holds a single `focusedShadowId` (plus a single
  `renderTarget` provider) — `src/core/nodes/NodeRegistry.ts`.
- `ShoferProvider.getStateToPostToWebview` calls
  `nodeRegistry.getFocusedShadow()` and, when set, substitutes that
  shadow's `shoferMessages` / `currentTaskItem` / `currentTaskId` for
  **any** webview that does a full-state push
  (`src/core/webview/ShoferProvider.ts` ~L3799, L3858–L3921).
- So a focused remote shadow renders in whichever view pushes state
  next; both views converge on the same task. L2 mitigates the common
  case by pointing `renderTarget` at the view that *started* the task,
  but a later full-state push from the other view still pulls it over.

The local current-task focus is likewise a single global (the task
stack / `getCurrentTask()`), so this is not a nodes-only concern.

## Terminology

"**Provider**" here means a **`ShoferProvider`** — the extension-side
class (`src/core/webview/ShoferProvider.ts`) that backs one webview view.
There is one instance per webview surface: the sidebar, plus each editor
tab opened via `openShoferInNewTab`. So "per-provider" == "**per-view /
per-webview**". It is NOT an LLM provider and NOT a Shofer *node*.

## Design

Make focus **per-view** (per `ShoferProvider` webview) rather than global:

- **`NodeRegistry`** — replace the single `focusedShadowId` /
  `renderTarget` with a per-view map keyed by the `ShoferProvider`
  instance (or a stable provider id): `Map<providerId, focusedShadowId>`.
  The `pool.subscribe` demux (Stage B) already knows the initiating
  view — target shadow render deltas to that view only, and resolve
  "focused shadow" per view.
- **`ShoferProvider.getStateToPostToWebview`** — resolve the shadow
  override from *this* view's focus, not a global getter. Thread the
  provider identity into `nodeRegistry.getFocusedShadow(provider)`.
- **Local task focus** — the harder half: a per-view local focus needs
  the current-task/focus notion to stop being a single global. Decide
  whether editor-tab views get their own task-stack focus or only remote
  shadows are per-view (a smaller first step: local stays global, only
  shadow focus is per-view — enough to watch one remote task in the tab
  while the sidebar shows the local one).
- **State-push fan-out** — full-state and delta pushes must be addressed
  to the right provider(s); audit every `postStateToWebview` /
  `postMessageToWebview` broadcast so a per-view focus isn't clobbered by
  a sibling view's push.

## Tests

- Two providers attached; focusing a remote shadow in provider B leaves
  provider A's `shoferMessages` (its own task) intact across a full-state
  push from either view.
- Shadow render deltas post only to the initiating provider.
- Local-only, single-view behavior unchanged (no regression).

## Acceptance

- Sidebar shows task A, editor tab shows remote-node task B,
  simultaneously; a state push from either view does not swap the other's
  conversation.

## Performance / scale

This feature is bounded by the number of open **views**, not the number
of tasks:

- Today the webview (FE) holds only the **focused** task's
  `shoferMessages` array; background tasks' messages live extension-side
  in their `Task` objects (local) or in `RemoteTaskShadow` buffers inside
  `NodeRegistry` (remote). Streaming deltas reach the FE only for the
  focused task.
- With per-view focus, each view holds *its own* focused task's array,
  and each view is a separate webview with its own memory. So **N open
  views ⇒ N arrays** (N realistically 1–3), independent of how many tasks
  run. Hundreds of concurrent tasks are never each held in any FE — only
  the ≤N focused ones are, and only those stream deltas. Per-view focus
  adds negligibly (one focused task *per view* vs one global).
- The real "hundreds of tasks" cost is **extension-side and already
  exists** independent of this feature: each running task is a `Task`
  object (local) or a shadow buffer + a slot in the merged `ExecutorPool`
  event feed (remote). If that ever bites, the mitigations are
  extension-side and orthogonal — evict/cap idle shadow buffers, the
  existing `hasMoreShoferMessages` pagination for long conversations —
  not affected by per-view focus.

## Notes

- Scope is broader than nodes code — it touches Shofer's global
  current-task/focus + state-push model. Size accordingly.
- Smaller first increment: make only **shadow** focus per-view (local
  focus stays global). Covers the main use case (watch a remote task in
  the tab) with far less blast radius.
- No back-compat shims (owner constraint). Bump extension **minor** when
  it ships and update `docs/remote-agents.md`.
