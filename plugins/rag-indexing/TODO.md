# RAG Indexing — known gaps

What this plugin knowingly does not do, and what the move out of core cost.

## Reduced from the built-in version

- **No error telemetry.** The indexer used to send `CODE_INDEX_ERROR` events through the
  product's typed telemetry catalog. A plugin has no telemetry seam, and adding one would
  let any plugin write into that catalog — so the events are gone. The **metrics** remain
  (`shofer_code_index_errors_total` and friends, through `ctx.host.metrics`), which is what
  an operator actually watches; what is lost is the aggregated field signal.
- **The settings form is the generic plugin one.** Provider, model, URLs and the seven
  credentials are rendered by the Plugins panel from the manifest schema, not by a bespoke
  990-line form. That means no provider-specific model dropdown and no "test connection"
  button; the panel shows the state the index reaches, which is the same information one
  step later.
- **The status chip polls.** It used to receive push updates over a dedicated IPC message.
  Plugin UI has a request channel, so the chip asks every three seconds while it is
  mounted. Cheap (an in-process call), but not instantaneous.
- **No dedicated Settings tab.** It lives under Settings → Plugins → RAG Indexing, like
  every other plugin.

## Not implemented

- **One vector store.** Qdrant only. `IVectorStore` is an interface, but nothing else
  implements it.
- **No index sharing between unrelated workspaces.** Identity is the resolved index key
  (or the workspace path's hash); two checkouts of the same repository share, two
  repositories never do.
- **Commit _diffs_ are not indexed**, only messages — see [`docs/git-history.md`](./docs/git-history.md).
- **`ctx.ai.embed` uses this plugin's embedder.** Deliberate (a query embedded with a
  different model than the vectors is meaningless), but it does mean a plugin that only
  wants embeddings must configure the indexer.

## Depends on core

- **Tree-sitter grammars are the host's.** The plugin bundles the loader but not the 62 MB
  of `.wasm`; it reads them from the extension's asset directory. A globally-installed copy
  of this plugin outside the extension would have to ship its own.
- **Four pure helpers are borrowed at build time** (`src/core-shared.ts`): the tree-sitter
  loader, the embedding-model catalog, `.gitmodules` discovery, the OpenAI error normaliser,
  `listFiles` and the ignore controller. Bundled, so there is no runtime dependency — but
  the plugin builds only inside this repository.
