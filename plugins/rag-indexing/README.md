# RAG Indexing

Semantic search over your codebase — and, optionally, over its git history.

The agent gets two tools:

| Tool         | Answers                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `rag_search` | "where is the code that does X" — by meaning, not by literal text                 |
| `git_search` | "when and why did this change" — commit messages the current tree cannot tell you |

Bundled with Shofer but **off by default**: it needs an embedding provider, a credential
and a reachable [Qdrant](https://qdrant.tech). Turn it on in Settings → Plugins → RAG
Indexing.

## Setting it up

1. **Run a vector store.** Qdrant at `http://localhost:6333` is the default:
   `docker run -p 6333:6333 qdrant/qdrant`.
2. **Pick an embedder.** `openai`, `openai-compatible`, `openrouter`, `gemini`,
   `mistral`, `bedrock`, `ollama` or `vercel-ai-gateway`. Set the model id if you do not
   want the provider's default.
3. **Paste the key.** Every credential field is a password box; the value goes to your OS
   keychain, never to the settings file and never back to the UI.
4. **Enable `enabled`,** then watch the panel: `Standby → Indexing → Indexed`.

`gitIndexEnabled` adds the commit-history index on top, with its own depth
(`gitMaxHistoryDays`, `gitMaxCommits`) and poll interval.

## What it indexes

- Source files whose extension is in Shofer's index policy, minus `.gitignore`d paths
  (resolved with `git ls-files`, so nested ignores and negations are honoured) and minus
  anything `.shoferignore` blocks.
- Files are **chunked semantically** with tree-sitter — a function, a class, a markdown
  section — not by byte count, so a hit is a thing rather than a window.
- Re-scans are incremental: a stat-only fast path, then per-segment hashes, so an edit
  re-embeds the segments that changed rather than the file.

## Status and controls

The panel shows what each index is doing and offers **Start**, **Stop**, **Clear index**
and a per-workspace toggle. The chip in the chat input carries the same state while you
type, because a search that silently returns nothing looks like a bad model rather than an
index that never finished.

## With Shofer Nodes

Enable it on the controller only. The controller replicates the settings and credentials
to every node it drives and pins those nodes to **search-only** against the collection it
resolved — nodes answer searches, the controller does the writing. Nothing to configure
per node.

## Files

| Path                     | What it is                                                        |
| ------------------------ | ----------------------------------------------------------------- |
| `src/main.ts`            | Plugin entry: the two tools, the request surface, `node-config`   |
| `src/manager.ts`         | Code-index lifecycle (configure → services → scan → watch)        |
| `src/orchestrator.ts`    | A scan run: git-aware narrowing, batching, progress, cancellation |
| `src/indexing/`          | The directory scanner and the file watcher                        |
| `src/git/git-source.ts`  | `git` CLI queries that narrow an incremental scan                 |
| `src/git-index-service/` | The commit-history index                                          |
| `src/engine/`            | Embedders, the Qdrant store, chunking, the shared interfaces      |
| `src/core-shared.ts`     | The pure helpers borrowed from `@shofer/core` at build time       |
| `ui/`                    | The settings panel and the status chip                            |
| `locales/backend/`       | The `embeddings:` strings, in 18 languages                        |

Build with `node build-ui.mjs` (the extension bundle runs it on every `pnpm bundle`).
Unlike the other bundled plugins, the built `main.mjs` is **not committed** — it is 4.5 MB
because it bundles the provider SDKs, so it is regenerated rather than versioned. Typecheck standalone with
`npx tsgo -p plugins/rag-indexing`. Run the tests from `packages/core`:

```bash
cd packages/core && npx vitest run --config vitest.plugins.config.ts rag-indexing
```

## See also

- [`DESIGN.md`](./DESIGN.md) — how it is put together, and why
- [`TODO.md`](./TODO.md) — what it does not do
- [`plugins/rag-indexing/DESIGN.md`](DESIGN.md) — the core-side view
