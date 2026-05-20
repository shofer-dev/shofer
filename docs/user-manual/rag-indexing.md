# Semantic Code Search (RAG Indexing)

Shofer can build a **semantic search index** of your codebase, letting the AI
agent find code by _meaning_ rather than just by exact keyword matches. This is
powered by vector embeddings stored in a Qdrant database and exposed through the
`rag_search` tool.

For a lighter, zero-config alternative that works out of the box, Shofer also
provides [`lsp_search`](#lsp_search--symbol-search), which uses VS Code's
built-in language server for symbol-based search.

## Quick Start

1. **Set up Qdrant** — you need a running Qdrant instance (local or cloud).
2. **Choose an embedding provider** — OpenAI, Ollama (local), Gemini, Mistral,
   AWS Bedrock, OpenRouter, or any OpenAI-compatible API.
3. **Enter credentials** — API keys are stored securely in VS Code's
   `SecretStorage`.
4. **Enable indexing** in the Settings panel under **RAG / Code Index**.

Shofer will start scanning your workspace files, building embeddings, and
storing them in Qdrant. The **indexing status badge** in the chat input bar
shows progress:

<!-- XXX: Screenshot — ChatTextArea (the chat input bar at the bottom) with the
     IndexingStatusBadge visible in the toolbar row, showing "Indexing" state
     with a spinner animation. The badge should be clearly callout-able. -->

Once complete, the agent can use `rag_search` to query your codebase
semantically.

## Indexing Status Badge

The badge in the chat input bar shows one of five states:

| State        | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| **Standby**  | Indexing is enabled but not running (not yet started, or stopped). |
| **Indexing** | Currently scanning and embedding files. A spinner is shown.        |
| **Indexed**  | Indexing is complete and the index is up to date.                  |
| **Error**    | Something went wrong (e.g., Qdrant unreachable, bad API key).      |
| **Stopping** | Indexing is being cancelled.                                       |

<!-- XXX: Screenshot — Close-up of the IndexingStatusBadge in "Indexed" state
     (checkmark icon), with the CodeIndexPopover open next to it showing the
     file count ("12,430 files indexed"), the current state label, and the
     Start/Stop/Clear buttons. -->

Click the badge to open the **Code Index Popover**, which shows the number of
indexed files and provides buttons to start, stop, or clear the index.

## Choosing an Embedding Provider

Shofer supports 8 embedding providers. Each has different cost, latency, and
privacy characteristics:

| Provider              | Requires                 | Best for                             |
| --------------------- | ------------------------ | ------------------------------------ |
| **OpenAI**            | API key                  | Quick setup, high quality embeddings |
| **Ollama**            | Local Ollama server      | Privacy, no API costs, air-gapped    |
| **OpenAI-Compatible** | Base URL + API key       | Self-hosted embedding servers        |
| **Gemini**            | API key                  | Google Cloud users                   |
| **Mistral**           | API key                  | European-hosted option               |
| **Vercel AI Gateway** | API key                  | Vercel ecosystem users               |
| **AWS Bedrock**       | Region + AWS credentials | AWS-native, no internet egress       |
| **OpenRouter**        | API key                  | Multi-provider routing               |

Configure these in **Settings → RAG / Code Index → Embedding Provider**.

<!-- XXX: Screenshot — The Settings panel scrolled to the RAG / Code Index
     section, showing the Embedding Provider dropdown expanded with all 8
     options visible, and the sub-fields (API key input, model ID, base URL)
     shown for the currently selected provider. -->

If you're just trying it out locally, **Ollama** is the fastest path — install
Ollama, pull an embedding model (e.g., `nomic-embed-text`), and point Shofer at
`http://localhost:11434`.

## Configuration Reference

All settings live under the **RAG / Code Index** section in Settings. They can
also be set via `settings.json`:

```jsonc
{
	// Enable/disable the entire RAG indexing feature
	"shofer.codebaseIndexEnabled": true,

	// Qdrant connection
	"shofer.codebaseIndexQdrantUrl": "http://localhost:6333",

	// Embedding provider & model
	"shofer.codebaseIndexEmbedderProvider": "openai",
	"shofer.codebaseIndexEmbedderModelId": "text-embedding-3-small",
	"shofer.codebaseIndexEmbedderModelDimension": 1536,

	// Search defaults
	"shofer.codebaseIndexSearchMinScore": 0.4, // 0–1, lower = more results
	"shofer.codebaseIndexSearchMaxResults": 50, // 10–200

	// Provider-specific overrides (examples)
	"shofer.codebaseIndexOpenAiCompatibleBaseUrl": "https://my-embedder.example.com",
	"shofer.codebaseIndexBedrockRegion": "us-east-1",
}
```

Secrets (API keys) are stored via VS Code's `SecretStorage` and configured
through the settings UI — they are **never** written to `settings.json`.

## What Gets Indexed

Shofer indexes files whose extensions are in a curated list of ~30 supported
languages. This includes:

- **Languages**: JavaScript, TypeScript, Python, Go, Rust, Java, C/C++, C#,
  Ruby, PHP, Swift, Kotlin, Scala, Elixir, Lua, Zig, OCaml, Solidity, Vue,
  Elisp, and more.
- **Documents**: Markdown (`.md`, `.markdown`) — parsed by heading structure.
- **Data/config**: JSON, TOML.

<!-- XXX: Screenshot — The Settings panel showing the "Advanced Configuration"
     read-only section with the CODEBASE_INDEX_FILE_EXTENSIONS list displayed as
     a scrollable chip/pill list, plus CODEBASE_INDEX_IGNORED_DIRS shown below
     it. -->

Directories like `node_modules`, `.git`, `dist`, `build`, `vendor`,
`__pycache__` are always skipped. Shofer also respects your `.gitignore` and
`.shoferignore` files.

Files larger than **1 MB** are skipped. Individual code blocks are capped at
**1,000 characters** (with 15% tolerance). Blocks shorter than **10 characters**
are dropped as noise.

## `rag_search` vs `lsp_search` vs `grep_search`

Shofer provides three search tools. Here's when to use each:

| Tool          | How it works                                  | Needs setup? | Best for                                     |
| ------------- | --------------------------------------------- | ------------ | -------------------------------------------- |
| `rag_search`  | Semantic vector search (embeddings in Qdrant) | ✅ Yes       | "How does auth work?", finding by concept    |
| `lsp_search`  | VS Code workspace symbol provider             | ❌ No        | Finding function/class definitions by name   |
| `grep_search` | Regex text search across files                | ❌ No        | Exact string matches, finding all call sites |

**The agent decides which to use automatically.** You don't need to tell it —
the system prompt describes all three tools and the agent picks the right one
for each query.

## Reboots & Cache

The vector index lives on **Qdrant** (durable storage) and survives reboots.
Shofer also maintains a local **file cache** in VS Code's global storage
(`~/.config/Code/User/globalStorage/.../shofer-index-cache-<hash>.json`).

On restart:

- **If the cache is intact** → Shofer checks each file's modification time and
  size against the cache. Unchanged files are skipped (no re-reading, no
  re-hashing). Only changed or new files are re-indexed. This makes startup
  nearly instant on large workspaces.
- **If the cache is lost** → Shofer re-indexes everything from scratch. The
  Qdrant vectors are still there (they survive reboots), but without the cache,
  Shofer can't tell which files are unchanged and must re-embed all of them.

<!-- XXX: Screenshot — The CodeIndexPopover immediately after a VS Code restart,
     showing "Indexed" with a file count, and the text "Index is up to date"
     visible. This demonstrates the fast-path incremental reconciliation working
     without a full re-scan. -->

## When to Clear & Re-Index

You generally don't need to clear the index. It updates incrementally as files
change. However, you may want to clear and re-index if:

- You switch embedding providers (different embedding dimensions).
- Qdrant data becomes inconsistent (rare).
- You want to force a full re-scan for debugging.

Use the **Clear Index** button in the Code Index Popover, then click **Start
Indexing** to rebuild.

## Limitations

- **~30 file extensions** are indexed. If your language isn't in the list, files
  are silently skipped. Check **Settings → Advanced Configuration** for the
  current list.
- **Swift and Visual Basic .NET** use line-based fallback chunking (no AST
  parsing) because their tree-sitter parsers are unstable or unavailable.
- **Multi-workspace**: each workspace folder gets its own Qdrant collection.
  The status badge reflects the active workspace only.
- **Performance**: embedding all files in a large repo requires API calls. With
  a cloud provider, indexing a 50k-file workspace may take several minutes and
  incur API costs. With local Ollama, it's free but CPU-bound.
