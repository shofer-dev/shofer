# TODO: Optimistic `Indexed` state for code indexer (Phase 3)

Layered on top of the Phase 1 (mtime+size fast-path) and Phase 2
(git-aware narrowing) work shipped under
[`extensions/shofer/docs/rag_indexing.md`](../extensions/shofer/docs/rag_indexing.md).
See `todos/done/code_indexer_speedup.md` for the full historical plan
and the layering rationale.

## Goal

UX-only. Stop blocking the badge on reconciliation; let the agent
search against existing vectors immediately on startup.

Cold-start with a fully-reconciled workspace should turn the badge
green within the time it takes to do `vectorStore.initialize()` +
`hasIndexedData()` (one Qdrant round-trip), regardless of workspace
size.

## Design

- **`src/services/code-index/state-manager.ts`** — extend the state
  machine with a non-blocking sub-flag `reconciling: boolean` rendered
  as a small spinner overlay on the green badge. Do **not** introduce
  a new top-level `IndexingState` value — the four existing values
  (`Standby | Indexing | Indexed | Error`) stay the source of truth
  per the Exhaustive Switch Rule.
- **`src/services/code-index/orchestrator.ts`** — at the top of
  `startIndexing()`, if `vectorStore.hasIndexedData()` is true:
    - Set `state = Indexed`, `reconciling = true` immediately.
    - Start the file watcher.
    - Kick off the reconciliation scan (Phase 2 fast-path, falling back
      to Phase 1) as a background promise.
    - On completion: clear `reconciling`; on error: transition to
      `Error` (existing path) and clear `reconciling`.
- **`webview-ui/src/components/chat/IndexingStatusBadge.tsx`** —
  render the `reconciling` sub-flag as a small overlay/spinner on the
  green badge. Add a new `embeddings:status.reconciling` key per the
  i18n String Rule.

## Tests

- Unit: when Qdrant has data, `state` goes to `Indexed` before
  `scanner.scanDirectory()` resolves.
- Unit: `reconciling` clears after the background scan finishes.
- Webview spec: badge renders overlay when `reconciling === true`.

## Acceptance

- Cold-start with a fully-reconciled workspace: badge is green within
  the time it takes to do `vectorStore.initialize()` +
  `hasIndexedData()` (one Qdrant round-trip), regardless of workspace
  size.

## Notes

- Per **No Backward Compatibility Unless Asked**, no migration code
  for state shape. Bump the extension **minor** version.
- Update [`rag_indexing.md`](../extensions/shofer/docs/rag_indexing.md)
  "State Machine" section to reflect the `reconciling` sub-flag when
  this ships.
