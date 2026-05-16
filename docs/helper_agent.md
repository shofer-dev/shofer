# Helper Agent — Design & Implementation

## Purpose

The Helper Agent is a **persistent, long-context LLM companion** that lives alongside the RAG indexer. Unlike per-task agents that are ephemeral and destroyed when a task terminates, the Helper Agent survives across tasks and even VSCode restarts. It runs on a **cheap model with a very large context window**, allowing it to accumulate codebase knowledge over time and answer simple questions that other agents (running in their own tasks) can leverage without re-loading the entire codebase. It is exposed to agents as the `ask_helper_agent` native tool.

The key design principles:

- **Persistent context** — the agent's conversation history survives task termination and VSCode restarts.
- **Cheap + large context** — user selects a low-cost model optimized for large windows (e.g., Gemini Flash, GPT-4o-mini, Claude Haiku).
- **File-aware** — notified of file changes (like the RAG indexer) so it can re-read changed files to keep its context fresh. File access respects `.shoferignore` — excluded files are never loaded into context.
- **Serialized access** — questions are queued; only one question is processed at a time.
- **KV-cache preserving** — the context window is append-only during normal operation. Files are never evicted when modified by tasks; instead a "recently modified" notification is attached to the next question. This keeps the LLM provider's attention cache warm, minimizing token costs and latency.
- **Cold start** — context window starts empty on first launch; fills organically as tasks ask questions.
- **Truncation, not summarization** — when the context window fills up, oldest messages are simply dropped. No lossy compression or summarization is ever applied, keeping the remaining context pristine.
- **Strictly read-only** — the helper agent has **no access** to code-writing tools, CLI commands, or MCP tools. It can only use the "Read" category of native tools (file reading, search, LSP symbol lookup). This is a hard constraint enforced by tool filtering.
- **Fixed system prompt** — the helper agent's system prompt is internally defined and not user-configurable. It instructs the agent to be a concise, read-only codebase Q&A assistant. The prompt includes a snapshot of the workspace directory/file hierarchy (like `find .` output), capped at ~10% of the context window, with `.shoferignore`-excluded files omitted.

---

## Architecture

`HelperAgentManager` is a thin orchestrator that owns the lifecycle, the
configuration, and the event emitters consumed by the webview. All heavy
lifting lives in focused single-responsibility collaborators it composes:

```
HelperAgentManager (singleton per workspace, vscode.Disposable)
 │
 ├── ConversationStore           — versioned JSON snapshot persistence
 │                                 (SHA-256 file-context validation, ENOENT-safe)
 ├── QuestionQueue                — bounded FIFO with per-entry AbortSignal
 │                                 (serializes question processing; bulk cancel)
 ├── ContextWindow                — token budget + LRU eviction
 │                                 (file contexts evicted before message pairs)
 ├── HelperAgentLlmClient         — wraps shared `buildApiHandler()` ApiHandler
 │                                 (streaming, abort-aware, full provider catalog)
 ├── HelperAgentDirectoryTree     — workspace scanner, ~10% context-window cap
 ├── HelperAgentFileWatcher       — VSCode FileSystemWatcher, 500ms debounce
 └── pricing                       — per-model USD cost from ApiHandler.getModel()

Configuration & secrets are read through `ContextProxy` so the helper
agent participates in the extension's typed settings/migration plumbing
(no direct vscode.workspace.getConfiguration / context.secrets).
Commands are registered through the typed `commandIds` plumbing.

State machine:  Standby → Initializing → Ready ⇄ Busy → Stopping → Standby
                                  ↓                ↓
                                Error  ←── any failure ──→ recoverFromError()
```

### Key Source Files

| File                                              | Lines | Role                                                                                                                                                                                                         |
| ------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/services/helper-agent/manager.ts`            | ~620  | Singleton orchestrator. Public API: `initialize`, `startAgent`, `stopAgent`, `askQuestion`, `clearContext`, getters for state/usage/cost, two event emitters.                                                |
| `src/services/helper-agent/conversation-store.ts` | ~140  | Versioned JSON snapshot persistence under `globalStorage`. SHA-256 hash validation of cached file contents on load; drops on mismatch or `ENOENT`.                                                           |
| `src/services/helper-agent/question-queue.ts`     | ~160  | Bounded FIFO with per-entry `AbortSignal`. Reentrant-safe drain loop; per-entry timeouts; bulk `cancelAll()`.                                                                                                |
| `src/services/helper-agent/context-window.ts`     | ~200  | In-memory window: messages + file contexts with token estimates. LRU eviction (file contexts first by `lastReferencedAt`, then oldest user/assistant pairs).                                                 |
| `src/services/helper-agent/llm-client.ts`         | ~210  | Adapter onto the shared `buildApiHandler()`. Maps the helper-agent's curated provider list to `ProviderSettings`; consumes `ApiStream` with abort support.                                                   |
| `src/services/helper-agent/pricing.ts`            | ~50   | Reads per-model USD pricing from `ApiHandler.getModel().info.{inputPrice,outputPrice}`; fallback constants when the handler does not expose pricing.                                                         |
| `src/services/helper-agent/directory-tree.ts`     | ~160  | Recursive workspace scan. `find .`-style tree generation. Excludes `.shofer/worktrees/` + common ignore dirs; capped at ~10% of context window.                                                              |
| `src/services/helper-agent/file-watcher.ts`       | ~100  | VSCode `FileSystemWatcher` wrapper. 500ms per-file debounce; skips worktrees and hidden paths. Notifies the manager which invalidates `ContextWindow` entries.                                               |
| `src/services/helper-agent/__tests__/`            |       | Vitest specs for `ConversationStore`, `QuestionQueue`, `ContextWindow` (25 cases, no `vscode` mocks needed).                                                                                                 |
| `packages/types/src/helper-agent.ts`              | ~180  | Zod schemas (`AgentMessage`, `FileContextEntry`, `HelperAgentConfig`, `QuestionResult`, `HelperAgentCostTracking`, `HelperAgentConversationData`); the fixed `HELPER_AGENT_SYSTEM_PROMPT`; all 11 constants. |
| `packages/types/src/global-settings.ts`           |       | `helperAgent{Enabled,Provider,ModelId,BaseUrl,MaxContextTokens,ContextFillThreshold}` keys on `globalSettingsSchema`; six `helperAgent*Key` entries on `GLOBAL_SECRET_KEYS`.                                 |
| `packages/types/src/vscode.ts`                    |       | Helper-agent command ids on the typed `commandIds` array (`helperAgent.{start,stop,clearContext,showChat,openSettings}`).                                                                                    |

### Module Contracts

The collaborators are **concrete classes**, not interfaces (no `interfaces/`
directory). The Manager depends directly on each class; substitution for
testing is achieved by constructor injection at the spec level. The public
shape of each module:

- **`ConversationStore`** — `load(): Promise<ConversationSnapshot>`, `save(snapshot)`, `filePath` getter. Snapshot shape: `{ version, messages, fileContexts, costTracking }`. Discards on version mismatch (no migrations).
- **`QuestionQueue`** — `setProcessor(fn)`, `enqueue(question, contextFiles?, timeoutMs?): Promise<QuestionResult>`, `cancelAll()`, `pendingCount`, `isProcessing`. Processor signature: `(question, contextFiles, signal) => Promise<QuestionResult>`.
- **`ContextWindow`** — `configure(opts)`, `restore(messages, fileContexts)`, `clear()`, `appendMessage`, `upsertFileContext`, `removeFileContext`, `invalidateFileContext`, `enforceLimit()`, `getUsage()`, `consumeEvictedTokens()`. Plus getters used by the Manager: `messages`, `fileContexts`, `fileContextPaths`, `estimatedTokenCount`, `maxContextTokens`, `contextFillThreshold`, `isNearlyFull`.
- **`HelperAgentLlmClient`** — constructor builds an `ApiHandler` via `buildApiHandler(toProviderSettings(config), { taskId: HELPER_AGENT_TASK_ID })`. `chat(messages, signal?): Promise<ChatResult>` drains `ApiStream`, accumulating `text` chunks into the answer and `usage` chunks into prompt/completion tokens; cooperatively aborts between chunks via the `AbortSignal`.
- **`HelperAgentDirectoryTree`** — `generate(): Promise<string>` returning the formatted tree string capped at `DIRECTORY_TREE_MAX_CONTEXT_FRACTION * maxContextTokens`.
- **`HelperAgentFileWatcher`** — constructor takes `(workspacePath, onChange)`; `dispose()`; debounces per file path.

### Data Types

**`AgentMessage`** — a conversation turn:

```typescript
{
	id: string                    // UUID
	role: "user" | "assistant" | "system"
	content: string
	timestamp: number             // Unix ms
	metadata?: {
		sourceTaskId?: string     // Which task asked this question
		fileReferences?: string[] // Files referenced in this turn
	}
}
```

**`FileContextEntry`** — a file loaded into the agent's context:

```typescript
{
	filePath: string
	contentHash: string // SHA-256 of the content at load time
	tokenEstimate: number
	loadedAt: number // Unix ms
	lastReferencedAt: number // Unix ms — for eviction priority
}
```

**`HelperAgentConfig`**:

```typescript
{
	enabled: boolean
	provider: string              // e.g., "openai", "gemini", "openai-compatible", "anthropic"
	modelId: string               // e.g., "gemini-2.0-flash", "gpt-4o-mini"
	apiKey: string                // stored in SecretStorage
	baseUrl?: string              // for openai-compatible providers
	maxContextTokens: number      // max tokens for the context window (default: model's max)
	contextFillThreshold: number  // 0.0–1.0, default 0.80 — "nearly full" warning threshold
}
```

The system prompt is **not configurable** — it is hardcoded in the service and instructs the helper agent to act as a concise, read-only codebase Q&A assistant. The prompt includes a **workspace directory tree** snapshot (see [Directory Tree Injection](#7-directory-tree-injection-directorytreets)).

The only user-configurable properties are the **API configuration** (provider, model, credentials) and the **Clear Context** action (which resets the conversation to just the system prompt and regenerates the directory tree).

**`QuestionResult`** — response from the helper agent:

```typescript
{
	answer: string
	tokensUsed: {
		prompt: number
		completion: number
		total: number
	}
	contextUsage: {
		currentTokens: number
		maxTokens: number
		fillFraction: number       // 0.0–1.0, current / max
		isNearlyFull: boolean      // true when fillFraction > fillThreshold
	}
	costSnapshot: {
		sessionInputTokens: number
		sessionOutputTokens: number
		sessionEstimatedCostUSD: number
	}
	contextFiles: string[]        // Files currently in context at time of answer
	durationMs: number
}
```

---

## State Machine

```
Standby ──startAgent()──→ Initializing ──ready──→ Ready
   ↑                           │                    │
   │                    stopAgent()           question arrives
   │                           │                    │
   └─────────────────────── Stopping            Busy (processing)
                                │                    │
                           (aborted)           answer returned
                                                    │
         Error ←─── any failure ──→ Ready/Busy ─────┘
           │
           └──recoverFromError()──→ Standby (clean slate)
```

State transitions:

| From           | Event                | To             | Notes                                                       |
| -------------- | -------------------- | -------------- | ----------------------------------------------------------- |
| `Standby`      | `startAgent()`       | `Initializing` | Loads config, creates LLM provider, restores conversation   |
| `Initializing` | success              | `Ready`        | Agent is idle, waiting for questions                        |
| `Initializing` | failure              | `Error`        | Config invalid, API unreachable, etc.                       |
| `Ready`        | question arrives     | `Busy`         | Dequeued from `QuestionQueue`                               |
| `Busy`         | answer returned      | `Ready`        | If queue is empty; otherwise stays `Busy` for next question |
| `Busy`         | error                | `Error`        | LLM call failed                                             |
| `Ready`        | `stopAgent()`        | `Stopping`     | Graceful shutdown                                           |
| `Busy`         | `stopAgent()`        | `Stopping`     | Cancels current question, rejects queued ones               |
| `Stopping`     | complete             | `Standby`      | Clean shutdown, context persisted                           |
| `Error`        | `recoverFromError()` | `Standby`      | Clears all service instances                                |

---

## Data Flow: Question Processing Pipeline

### 1. Activation (`extension.ts`)

During extension activation, for each workspace folder:

```
HelperAgentManager.getInstance(context, folder.uri.fsPath)
  → manager.initialize(contextProxy)   // non-blocking, runs in background
```

### 2. Initialization (`manager.ts` → `initialize()`)

```
Manager.initialize()
  → loadConfigFromContextProxy()  // reads helperAgent* state keys + secrets
  → check: enabled? configured?
  → ConversationStore.load() → snapshot { version, messages, fileContexts, costTracking }
      version mismatch → discard (no migrations)
  → ContextWindow.configure({ maxContextTokens, contextFillThreshold })
  → ContextWindow.restore(snapshot.messages, validatedFileContexts)
  → instantiate HelperAgentLlmClient (wraps buildApiHandler)
  → startAgent()
```

### 3. Agent Startup (`manager.ts` → `startAgent()`)

```
for each FileContextEntry restored from snapshot:
  re-read file from disk → SHA-256 hash
  if hash matches → keep in window
  if hash differs or ENOENT → drop (ContextWindow.removeFileContext)

HelperAgentDirectoryTree.generate() → cached tree string
new HelperAgentFileWatcher(workspacePath, onFileChanged)
state → Ready
```

### 4. Question Handling (`manager.ts` → `_processQuestion()` via `QuestionQueue`)

```
External Task calls ask_helper_agent tool (synchronous — task blocks until answer or timeout)
  → HelperAgentTool.invoke({ question, contextFiles?, timeoutMs? })
  → Start a single timeout timer covering the ENTIRE duration (queue wait + LLM processing)
  → QuestionQueue.enqueue({ question, sourceTaskId, timeoutMs })
  → Wait for queue position (if agent is Busy) — timeout is running
  → If timeout fires at any point (during queue wait OR during LLM call):
      abort the LLM call via AbortController (if in progress)
      retain any partial response and file reads already appended to context (KV-cache preserving)
      transition to Ready (or process next queued question)
      return timeout error to caller

When dequeued (QuestionQueue invokes the processor with an AbortSignal):
  → state → Busy
  → If contextFiles provided: read each, ContextWindow.upsertFileContext(path, content, sha256)
  → ContextWindow.appendMessage({ role: "user", content: question })
  → Drain recentlyModifiedFiles set (from tool invocation hooks)
  → Construct messages for HelperAgentLlmClient:
      [fixed system prompt]     // HELPER_AGENT_SYSTEM_PROMPT + cached directory tree (~10% cap)
      + [file contexts]         // one system message per FileContextEntry (KV-cache friendly)
      + [recently modified notification]  // ephemeral, not persisted
      + [conversation history]  // every prior turn (KV-cache friendly)
      + [current question]
  → HelperAgentLlmClient.chat(messages, signal)
      → buildApiHandler().createMessage(systemPrompt, otherMessages, { taskId })
      → drains ApiStream: accumulates `text` chunks, captures `usage` chunks, surfaces `error`
      → AbortSignal aborts between chunks
  → ContextWindow.appendMessage({ role: "assistant", content: answer })
  → ContextWindow.enforceLimit() → LRU eviction if over budget
  → pricing.computeCost(handler, usage) → update _costTracking
  → ConversationStore.save(snapshot)
  → state → Ready (or stay Busy if queue non-empty)
  → Return QuestionResult { answer, usage, costUSD, evictedTokens } to caller
```

### 5. File Change Handling (`file-watcher.ts`)

The helper agent stays aware of file modifications through **two complementary mechanisms**:

#### 5a. File System Watcher (`vscode.workspace.createFileSystemWatcher`)

Detects changes originating from outside Shofer (e.g., user edits in another editor, git checkout, external scripts). Implemented in `file-watcher.ts` using VSCode's native `FileSystemWatcher` (no `chokidar` dependency).

```
FileSystemWatcher detects change (create/modify/delete)
  → Skip .shofer/worktrees/ and hidden paths
  → Debounce by FILE_CHANGE_DEBOUNCE_MS (500ms) per path
  → Manager.onFileChanged(filePath)
      → ContextWindow.invalidateFileContext(filePath)  // marks stale, retains slot
      → On delete: ContextWindow.removeFileContext(filePath)
      → Modify: do NOT auto-reload — lazy load on next question referencing it
        (avoids burning tokens on files that may not be asked about)
```

#### 5b. Tool Invocation Hooks (recently-modified file notifications)

Detects changes made by Shofer tasks through native tools. **Critically, files are NOT evicted from context** when modified — evicting and re-adding a file would invalidate the LLM provider's KV cache (attention cache), forcing a costly recomputation of the entire context window on the next request.

Instead, the helper agent accumulates a list of **recently modified file paths** and attaches it to each question. This preserves the KV cache while keeping the agent informed:

```
Task tool modifies file (write_to_file, apply_diff, insert_edit, sed, file rm/mv, rename_symbol)
  → Tool execution completes successfully
  → HelperAgentManager.onFileModifiedByTask(filePath)  // hook invoked
  → Check against .shoferignore — skip if ignored
  → Check against .shofer/worktrees/ — skip worktree files
  → Add filePath to recentlyModifiedFiles set          // NO eviction — KV cache preserved
```

On the next question:

```
Question dequeued from queue
  → Drain recentlyModifiedFiles set
  → Attach as metadata to the question:
      "[Note: the following files have been modified since you last read them:
        src/foo.ts, src/bar.ts. Consider re-reading them if relevant to this question.]"
  → List is also passed to the helper agent's LLM call as a system-level hint
  → The model can then use read_file to re-read stale files if needed
  → recentlyModifiedFiles set is cleared after being attached
```

This approach:

- **Preserves the KV cache** — the existing context window is never mutated, so the LLM provider can reuse cached attention computations, keeping requests fast and cheap.
- **Informs without forcing** — the model knows which files are stale and can decide whether to re-read them based on relevance to the current question.
- **Aligns with worktree best practices** — since tasks normally operate in worktrees (`.shofer/worktrees/<name>/`), main-branch files are rarely modified directly. The primary case where files appear in this list is after a worktree merge back into master. The helper agent does not depend on git — it just sees "file X was modified."
- **Clears on use** — the set is drained after each question, so stale notifications don't accumulate across questions.

Integration point: `HelperAgentManager` subscribes to tool execution events (filtered by `"shofer_edited"` source) via [`FileContextTracker.trackFileContext`](src/core/context-tracking/FileContextTracker.ts:39) or an equivalent centralized event bus emitted by the tool execution pipeline.

```

```

### 7. Directory Tree Injection (`directory-tree.ts`)

On agent startup (and after Clear Context), the helper agent scans the workspace and injects a directory/file hierarchy into the system prompt. This gives the agent immediate awareness of the project structure without needing to call `list_files` on every question.

```
startAgent() or clearContext():
  → Scan workspace root with find/list_files equivalent
  → Apply .shoferignore filter — skip excluded paths
  → Apply .shofer/worktrees/ filter — skip worktree directories
  → Generate tree output (similar to `find . -not -path './.shoferignore-patterns'`):
      src/
        services/
          user-service.ts
          auth-service.ts
        components/
          Button.tsx
          Modal.tsx
      docs/
        README.md
      package.json
      tsconfig.json
  → Estimate token count of tree output
  → Cap at DIRECTORY_TREE_MAX_CONTEXT_FRACTION * maxContextTokens
      (default: 10% of context window, e.g. 12,800 tokens for a 128K window)
  → If tree exceeds cap:
      truncate deepest nesting levels first
      collapse large directories into "[N files in <dir>/]" summaries
  → Inject tree into system prompt as:
      "[Workspace structure:\n<tree>\n\n.shogerignore patterns are respected.]"
```

The directory tree is:

- **Generated once** at agent startup and regenerated on Clear Context
- **Never truncated** by the normal truncation policy — it is part of the immutable system prompt prefix
- **Capped at ~10%** of the context window to leave room for conversation and file contents
- **Excludes** `.shoferignore`-listed paths and `.shofer/worktrees/` directories
- **Provides immediate orientation** — the agent knows the project layout without tool calls

Integration point: `src/services/helper-agent/directory-tree.ts` — generates and token-counts the tree.

### 8. Context Window Management (`context-window.ts`)

The helper agent uses **truncation, not summarization**. The context window is a ring-buffer-like structure where old content is simply dropped when the limit is reached. No summarization is ever performed — the idea is to keep the context window nearly full (configurable up to a fill threshold) with raw conversation and file content.

```
Token budget = helperAgentMaxContextTokens (user-configurable)
Fill threshold = helperAgentContextFillThreshold (default 0.80 = 80%)

Warning zone:
  → When current_tokens > fill_threshold * maxContextTokens:
      the agent includes a "context_nearly_full" flag in responses
      callers can choose to clear context or let truncation occur naturally

When adding file context:
  → estimate tokens of new file content
  → if would exceed maxContextTokens:
      evict least-recently-referenced file contexts first (LRU)
      if still insufficient: truncate oldest conversation turns
  → add FileContextEntry

When conversation history grows:
  → if total tokens (history + file contexts) > maxContextTokens:
      truncate oldest user+assistant pairs from the messages array
      (preserve system prompt and last N turns up to the limit)
  → insert a system note: "[N earlier messages were truncated due to context limit]"

Truncation policy (NO summarization):
  → Oldest user+assistant pairs are removed entirely — no compression
  → File contexts with lowest `lastReferencedAt` are evicted first
  → The system prompt (including the directory tree) is NEVER truncated
  → The directory tree is part of the immutable system prompt prefix
  → Truncated content is permanently lost from the agent's memory
  → A marker message is inserted so the model knows truncation occurred
```

---

## Storage Topology

| Data                      | Storage Location                                                                                                | Survives Reboot?                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Conversation history**  | VS Code globalStorage: `~/.config/Code/User/globalStorage/shofer.dev/shofer-helper-agent-<workspace-hash>.json` | ✓ Yes — persisted alongside VS Code settings |
| **File context registry** | Same JSON file as conversation history (nested under `fileContexts` key)                                        | ✓ Yes — persisted in globalStorage           |
| **API keys & secrets**    | VS Code `SecretStorage` (keyed as `helperAgentOpenAiKey`, `helperAgentGeminiKey`, etc.)                         | ✓ Yes — OS-level credential store            |
| **Configuration**         | VS Code `globalState` (via `ContextProxy`)                                                                      | ✓ Yes — synced with VS Code settings         |

### Persistence Format

The conversation store persists a single JSON file:

```json
{
	"version": 1,
	"workspacePath": "/home/user/projects/my-app",
	"createdAt": 1715678900000,
	"updatedAt": 1715680000000,
	"messages": [
		{
			"id": "uuid-1",
			"role": "user",
			"content": "What does the UserService class do?",
			"timestamp": 1715678900000,
			"metadata": { "sourceTaskId": "task-123" }
		},
		{
			"id": "uuid-2",
			"role": "assistant",
			"content": "The UserService class handles...",
			"timestamp": 1715678901000
		}
	],
	"fileContexts": [
		{
			"filePath": "src/services/user-service.ts",
			"contentHash": "abc123def456...",
			"tokenEstimate": 2500,
			"loadedAt": 1715678900500,
			"lastReferencedAt": 1715678900500
		}
	],
	"costTracking": {
		"totalInputTokens": 125000,
		"totalOutputTokens": 8500,
		"totalTokensTruncated": 30000,
		"estimatedCostUSD": 0.042,
		"lastUpdated": 1715680000000
	}
}
```

### Reboot Behavior

After a system reboot:

- ✓ Conversation history restored from globalStorage
- ✓ File contexts restored; each file re-read from disk
- ⚠ If a file was modified while offline → hash mismatch → evicted from context
- ⚠ If a file was deleted while offline → removed from context
- ✓ Agent resumes in `Ready` state, waiting for questions

No restart of the agent is needed — it rehydrates automatically on extension activation.

---

## Tool Integration

### `ask_helper_agent` — Native Tool

A new native tool exposed to all tasks. The tool is **synchronous (blocking)** — the calling task waits until the helper agent finishes processing the question and returns an answer, or until the optional timeout expires. On timeout, processing is **aborted** but any partial work (file reads, partial response) already added to the context window is **retained** to preserve the LLM provider's KV cache.

```
Tool: ask_helper_agent
Description: Ask a question to the persistent helper agent that maintains
             long-term context about the codebase. This is a synchronous tool —
             the calling task will block until the answer is returned or the
             timeout is reached. Use this for simple questions about the code
             that don't require the full task context to be loaded.

Parameters:
  - question (string, required): The question to ask the helper agent.
  - contextFiles (string[], optional): File paths that are relevant
    to this question. The helper agent will load these into its
    context window if they aren't already present.
  - timeoutMs (number, optional): Maximum time to wait for an answer
    in milliseconds. Defaults to 300000 (5 minutes). If the timeout
    is exceeded, processing is aborted, any partial work already
    added to the context window is retained (to preserve KV cache),
    and the tool returns a timeout error.

Returns:
  - answer (string): The helper agent's response.
  - tokensUsed (object): Token counts for the request.
  - contextFiles (string[]): Files currently in the helper's context.
```

Tool implementation: `src/core/tools/HelperAgentTool.ts`
Tool schema: `src/core/prompts/tools/native-tools/ask_helper_agent.ts`

### Tool Availability

- The `ask_helper_agent` tool is **conditionally available** only when `HelperAgentManager` is enabled + configured + in `Ready` or `Busy` state.
- If the agent is in `Standby`, `Initializing`, `Error`, or `Stopping` state, the tool is filtered out (similar to `rag_search` filtering).
- Filter logic in `src/core/prompts/tools/filter-tools-for-mode.ts`.

### Auto-Approval

The `ask_helper_agent` tool is **auto-approved by default** (like `rag_search`), since it is read-only and uses a separate, cost-optimized model. Configured in `src/core/auto-approval/tools.ts`.

### Helper Agent's Own Tool Restrictions

The helper agent itself runs as an internal task with a **severely restricted tool set**. It is strictly read-only and cannot modify any state:

| Tool Category     | Available? | Tools Included                                                                           |
| ----------------- | ---------- | ---------------------------------------------------------------------------------------- |
| **Read**          | ✓ Yes      | `read_file`, `list_files`, `grep_search`, `list_code_usages`, `rag_search`, `lsp_search` |
| **Write/Edit**    | ✗ No       | `write_to_file`, `apply_diff`, `insert_edit`, `sed`                                      |
| **CLI/Execution** | ✗ No       | `execute_command`                                                                        |
| **MCP**           | ✗ No       | All MCP-provided tools (browser, k3s, mimir, loki, tempo, etc.)                          |
| **Task Control**  | ✗ No       | `new_task`, `switch_mode`, `attempt_completion`                                          |
| **Ask**           | ✓ Yes      | `ask_followup_question` — only as a fallback if clarification needed                     |

These restrictions are enforced at the tool-filtering layer (`filter-tools-for-mode.ts`) based on a dedicated `helper_agent` internal mode slug. The helper agent's system prompt explicitly instructs it that it cannot make changes — it can only read and answer questions about the codebase. This ensures:

- **Safety** — no accidental code modifications from the helper
- **Cost control** — the cheap model is never used for expensive operations
- **Predictability** — callers know the helper agent's response is purely informational

---

## Integration Points

### Extension Host

| Point      | File                                          | Details                                                                                               |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Activation | `src/extension.ts`                            | Creates `HelperAgentManager` per workspace folder, initializes in background                          |
| Chat View  | `src/core/webview/HelperAgentChatProvider.ts` | Registers webview panel for the helper agent chat view; streams live responses                        |
| Provider   | `src/core/webview/ShoferProvider.ts`          | Subscribes to `onAgentStateChange` to push helper agent status to webview                             |
| Status Bar | `src/activate/registerStatusBar.ts`           | Registers status bar button next to RAG indexer, shows agent state + model name                       |
| Commands   | `src/activate/registerCommands.ts`            | Registers `helperAgent.start`, `helperAgent.stop`, `helperAgent.clearContext`, `helperAgent.showChat` |

### Settings & Webview

| Point            | File                                        | Details                                                                    |
| ---------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Settings save    | `src/core/webview/webviewMessageHandler.ts` | `saveHelperAgentSettingsAtomic` → saves secrets + `handleSettingsChange()` |
| Status request   | `webviewMessageHandler.ts`                  | `requestHelperAgentStatus`                                                 |
| Start/stop/clear | `webviewMessageHandler.ts`                  | `startHelperAgent`, `stopHelperAgent`, `clearHelperAgentContext`           |
| Secret status    | `webviewMessageHandler.ts`                  | `requestHelperAgentSecretStatus`                                           |

### Tool System

| Point             | File                                                    | Details                                                                |
| ----------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Tool registration | `src/core/task/build-tools.ts`                          | Gets `HelperAgentManager` for current workspace, passes to tool filter |
| Tool filtering    | `src/core/prompts/tools/filter-tools-for-mode.ts`       | Removes `ask_helper_agent` if agent is disabled/unconfigured/not-ready |
| Tool dispatch     | `src/core/assistant-message/presentAssistantMessage.ts` | Routes to `HelperAgentTool`                                            |
| Auto-approval     | `src/core/auto-approval/tools.ts`                       | `askHelperAgent` is auto-approved by default                           |
| System prompt     | `src/core/prompts/system.ts`                            | Includes helper agent status + model info in system prompt context     |

### Configuration Schema

State keys live on the extension-wide `globalSettingsSchema` in `packages/types/src/global-settings.ts`; secret keys are listed in `GLOBAL_SECRET_KEYS` in the same file. Both are accessed through the typed `ContextProxy` (`getValue` / `getSecret` / `setValue`) — the helper agent never calls `vscode.workspace.getConfiguration` or `context.secrets` directly.

```typescript
// globalSettingsSchema (state, persisted in globalState)
helperAgentEnabled: boolean
helperAgentProvider: "openai" | "gemini" | "openai-compatible" | "anthropic" | "ollama" | "openrouter"
helperAgentModelId: string
helperAgentBaseUrl?: string                // openai-compatible / ollama only
helperAgentMaxContextTokens: number        // default DEFAULT_MAX_CONTEXT_TOKENS (128_000)
helperAgentContextFillThreshold: number    // 0.0–1.0, default 0.80

// GLOBAL_SECRET_KEYS (secrets, persisted in SecretStorage)
helperAgentOpenAiKey | helperAgentGeminiKey | helperAgentOpenAiCompatibleKey
  | helperAgentAnthropicKey | helperAgentOllamaKey | helperAgentOpenRouterKey
```

The Zod runtime schemas for the on-disk conversation snapshot — `helperAgentConfigSchema`, `agentMessageSchema`, `fileContextEntrySchema`, `helperAgentCostTrackingSchema`, `helperAgentConversationDataSchema`, `questionResultSchema` — live in `packages/types/src/helper-agent.ts`. The fixed `HELPER_AGENT_SYSTEM_PROMPT` is also defined there.

The system prompt is **not exposed** in settings — it is internally defined. The only user-facing controls are the API configuration dropdown and the **Clear Context** button.

### Cost Tracking

The helper agent tracks cumulative token usage and estimated cost across its entire lifecycle:

```typescript
interface HelperAgentCostTracking {
	totalInputTokens: number
	totalOutputTokens: number
	totalTokensTruncated: number // tokens dropped by truncation
	estimatedCostUSD: number // calculated from provider's published pricing
	lastUpdated: number // Unix ms timestamp
}
```

Cost is calculated in `pricing.ts` from `ApiHandler.getModel().info.{inputPrice,outputPrice}` (per-million-token rates). When the active handler does not expose pricing, fallback constants are used. The aggregate is persisted alongside the conversation and accumulated across sessions; on reboot, cost tracking resumes from the persisted snapshot. The cost is displayed to the user in:

- The status bar tooltip
- The info panel (on left-click)
- The webview settings page

---

## Key Constants

All exported from `packages/types/src/helper-agent.ts`:

| Constant                              | Value                                                          | Purpose                                                               |
| ------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `DEFAULT_MAX_CONTEXT_TOKENS`          | 128000                                                         | Default context window size (model-dependent, overridable)            |
| `DEFAULT_CONTEXT_FILL_THRESHOLD`      | 0.80                                                           | Default fill threshold (80%) — "nearly full" warning at this fraction |
| `DEFAULT_MAX_RESPONSE_TOKENS`         | 4096                                                           | Default max tokens for each response                                  |
| `MAX_QUESTION_QUEUE_SIZE`             | 50                                                             | Maximum pending questions in the queue                                |
| `QUESTION_TIMEOUT_MS`                 | 300000                                                         | Default timeout for a single question (5 min)                         |
| `FILE_CHANGE_DEBOUNCE_MS`             | 500                                                            | Debounce window for file change notifications                         |
| `MIN_CONVERSATION_TURNS_TO_KEEP`      | 10                                                             | Minimum turns preserved when truncating                               |
| `FILE_CONTEXT_SYSTEM_MESSAGE_PREFIX`  | `"[File context: {path}]\n"`                                   | Prefix for injected file content in messages                          |
| `DIRECTORY_TREE_MAX_CONTEXT_FRACTION` | 0.10                                                           | Max fraction of context window for the directory tree (10%)           |
| `TRUNCATION_MARKER_MESSAGE`           | `"[{N} earlier messages were truncated due to context limit]"` | Inserted when truncation occurs                                       |
| `CONVERSATION_STORE_VERSION`          | 1                                                              | Version for the persistence format                                    |

---

## Multi-Workspace Support

`HelperAgentManager` uses the same **singleton-per-workspace** pattern as `CodeIndexManager`, via `Map<string, HelperAgentManager>` keyed by `workspacePath`. Each workspace gets its own:

- Independent conversation history
- Independent file context registry
- Independent configuration (different model per workspace)
- Independent question queue

---

## Worktree Interaction

Shofer uses **embedded worktrees** — per-task git worktrees created under `.shofer/worktrees/<name>/` within the main workspace. Each worktree represents a different git branch, allowing tasks to work in isolation.

The helper agent interacts with worktrees as follows:

- **Exclusion from context**: The helper agent **never loads files from `.shofer/worktrees/`** directories. These represent ephemeral, task-scoped branches whose content is transient and would pollute the persistent context with unrelated branch state. This exclusion is enforced by `.shoferignore` patterns and additionally by a hardcoded path filter in the file watcher and lazy-load paths.

- **File path disambiguation**: Since worktree files live at `.shofer/worktrees/<name>/src/foo.ts` while main-branch files live at `src/foo.ts`, they are naturally distinct paths. The helper agent's context only ever contains main-workspace file paths.

- **Worktree file watcher**: The `HelperAgentFileWatcher` watches the entire workspace but skips events for paths under `.shofer/worktrees/`. Changes within worktrees do not trigger context eviction.

- **One helper agent per workspace**: Since all worktrees share the same VS Code window (embedded model), there is a single helper agent serving all tasks regardless of which worktree they operate in. The helper agent's knowledge represents the **main branch** state, not individual worktree branches.

- **Worktree creation/deletion**: When a worktree is created or deleted, the helper agent ignores those directory changes entirely — they fall under the excluded paths.

---

## UI: Status Bar Button

The Helper Agent status bar button sits **next to the RAG indexer button** on the status bar. It displays:

- **Icon**: A chat bubble or brain icon (distinct from RAG's database icon)
- **Blinking behavior**: The icon **blinks** when the agent is `Busy` (processing a question), matching the RAG indexer's blinking pattern during indexing.
- **State indicator** (status bar text, always visible):
    - `🔵 Initializing...` — agent is starting up
    - `🟢 Ready (42%)` — agent is idle; the percentage shows context window fill (`current / max` tokens)
    - `🟡 Busy (42%)` — processing a question (blinking); shows queue depth if > 0 queued
    - `🟠 Nearly Full (87%)` — context is above the fill threshold, truncation imminent
    - `🔴 Error` — configuration or connection issue
    - `⚪ Standby` — agent is configured but not started
- **Left-click**: Opens a detailed **info panel** (quick pick) showing:
    - **Status**: Current state, model name, provider
    - **Context**: Token usage bar (`current / max`, fill percentage with visual progress bar)
    - **Context fill threshold**: Configured percentage and whether it's been exceeded
    - **Cost tracking**: Total input tokens, output tokens, truncated tokens, estimated cost (USD)
    - **Files in context**: Count and scrollable list of file paths
    - **Conversation**: Number of message turns, oldest turn timestamp
    - **Quick actions**:
        - **View Chat** — opens the dedicated chat panel showing full conversation history
        - **Clear Context** — resets the conversation to just the system prompt (all messages and file contexts are dropped; cost tracking is preserved)
        - **Configure API** — opens the API configuration settings
- **Tooltip**: Shows model name, token usage (`12.5K / 128K`), fill percentage, and estimated cost

### Helper Agent Chat View

A dedicated **chat panel** lets the user observe everything the helper agent is doing in real time. It is accessible from:

- The status bar info panel: **"View Chat"** action (left-click the status bar button, then select "View Chat")
- A dedicated VS Code webview panel (similar to the Shofer task chat UI)

The chat view displays:

- **Full conversation history** — all question/answer pairs, scrollable, newest at the bottom
- **Live streaming** — when the agent is `Busy`, the current answer streams in token-by-token
- **Message metadata** per turn:
    - Which task asked the question (`sourceTaskId`, shown as a clickable task reference)
    - Timestamp of each message
    - Token counts for each Q&A pair (prompt / completion)
    - Files referenced in each question (clickable to open in editor)
- **Message styling**:
    - User questions: left-aligned, with task origin badge
    - Agent answers: right-aligned, with model name badge
    - System messages (file contexts loaded, truncation markers): centered, muted style
- **Context sidebar** (collapsible):
    - Current files in context with token estimates
    - Token usage bar (fill percentage)
    - Estimated cost breakdown

The chat view is **read-only** — the user cannot send messages directly to the helper agent. All messages come from tasks via the `ask_helper_agent` tool. This keeps the interaction model simple and prevents the user from accidentally polluting the context window.

Integration point: `src/core/webview/HelperAgentChatProvider.ts` — registers a webview panel provider that subscribes to conversation store updates and streams live responses via `EventEmitter`.

---

## Error Handling & Recovery

- **Queue resilience**: If an LLM call fails, the question is rejected with an error, and the agent transitions to `Error` state. The queue is drained with rejection for all pending questions.
- **Recovery**: `recoverFromError()` clears all service instances and the LLM provider, forcing a clean re-initialization on next `startAgent()`.
- **Conversation preservation**: Conversation history is saved after every successful question/answer pair. If the agent crashes mid-question, the conversation state from before the question is preserved.
- **Token overflow**: If the context window is exceeded, `ContextWindow.enforceLimit()` truncates oldest file contexts (by `lastReferencedAt`) and then oldest user/assistant turn pairs before failing the request. Truncated content is permanently lost — no summarization is retained.
- **Telemetry**: All errors are captured via `TelemetryService.captureEvent(TelemetryEventName.HELPER_AGENT_ERROR, {...})` with location context.

---

## Comparison with RAG Indexer

| Aspect               | RAG Indexer (`rag_search`)                  | Helper Agent (`ask_helper_agent`)                         |
| -------------------- | ------------------------------------------- | --------------------------------------------------------- |
| **Purpose**          | Semantic code search via vector embeddings  | Conversational Q&A with persistent context                |
| **Storage**          | Qdrant (vector DB) + local hash cache       | VS Code globalStorage (JSON conversation file)            |
| **Context**          | Stateless — each query is independent       | Stateful — accumulates conversation + file context        |
| **Model**            | Embedding model (e.g., `text-embedding-3`)  | Chat/completion model (e.g., `gemini-2.0-flash`)          |
| **Cost profile**     | Cheap embeddings, fixed per-code-block cost | Cheap per-token chat; cumulative cost tracked per session |
| **Startup**          | Full or incremental scan of all files       | Cold start with empty context                             |
| **File awareness**   | Re-indexes changed files (re-embeds)        | Evicts stale files; lazy re-reads on next reference       |
| **Concurrency**      | Read-only search, no queuing needed         | Questions serialized via FIFO queue                       |
| **Survival**         | Survives reboots (Qdrant PVC + hash cache)  | Survives reboots (globalStorage JSON)                     |
| **Context overflow** | N/A (stateless)                             | Truncation (oldest messages dropped, no summarization)    |
| **Cost visibility**  | Not tracked per-query                       | Cumulative input/output token counts + USD estimate       |

---

## Implementation Phases

The feature is designed to be implemented in **5 incremental phases**, each producing a testable, working artifact. No phase depends on future phases for basic functionality — each phase layers on additional capability.

### Phase 1: Core Manager + Configuration (Minimal Viable Agent)

**Goal:** The helper agent can be configured, initialized, and can answer a single question via direct API call. No tool integration yet — testable via VS Code commands.

**Files to create/modify:**
| File | Action | Notes |
|------|--------|-------|
| `packages/types/src/helper-agent.ts` | Create | Zod schemas, TypeScript interfaces, constants |
| `packages/types/src/index.ts` | Modify | Add `export * from "./helper-agent.js"` |
| `packages/types/src/tool.ts` | Modify | Add `"ask_helper_agent"` to `toolNames`, `TOOL_DISPLAY_NAMES`, `TOOL_GROUPS.read` |
| `src/services/helper-agent/manager.ts` | Create | Singleton Manager with `initialize()`, `askQuestion()`, conversation persistence, LLM calling (OpenAI-compatible + Gemini) |
| `src/extension.ts` | Modify | Import, create per-workspace instances, background `initialize()`, `disposeAll()` in deactivate |
| `src/shared/tools.ts` | Modify | Add `ask_helper_agent` to `NativeToolArgs` |

**What works at end of Phase 1:**

- User sets `helperAgentEnabled`, provider, model, API key via settings
- Extension activation creates `HelperAgentManager` per workspace
- `manager.initialize()` loads config + persisted conversation
- `manager.askQuestion("what is X?")` → returns answer from LLM
- Conversation persists across VSCode restarts
- Testable via `vscode.commands.executeCommand` or a temporary test command

**Out of scope for Phase 1:** Tool integration, status bar, file watcher, directory tree, chat view, timeouts.

---

### Phase 2: Native Tool + Tool System Integration

**Goal:** Tasks can call `ask_helper_agent` via the native tool system. The tool is conditionally available based on helper agent state.

**Files to create/modify:**
| File | Action | Notes |
|------|--------|-------|
| `src/core/prompts/tools/native-tools/ask_helper_agent.ts` | Create | OpenAI tool schema (description, parameters) |
| `src/core/prompts/tools/native-tools/index.ts` | Modify | Import + register in `getNativeTools()` |
| `src/core/tools/AskHelperAgentTool.ts` | Create | `BaseTool<"ask_helper_agent">` implementation |
| `src/core/assistant-message/presentAssistantMessage.ts` | Modify | Import + dispatch case for `"ask_helper_agent"` |
| `src/core/prompts/tools/filter-tools-for-mode.ts` | Modify | Add `helperAgentManager` parameter, conditional exclusion logic |
| `src/core/task/build-tools.ts` | Modify | Import `HelperAgentManager`, pass to `filterNativeToolsForMode` |
| `src/core/auto-approval/tools.ts` | Modify | Add `askHelperAgent` to auto-approved tools |
| `src/services/helper-agent/manager.ts` | Modify | Add `isHelperAgentAvailable` getter |

**What works at end of Phase 2:**

- `ask_helper_agent` appears in the agent's tool set when helper is enabled+configured+initialized
- Tool is auto-approved (read-only, separate model)
- Tool is filtered out when helper agent is disabled/unconfigured

**Out of scope for Phase 2:** Timeout handling, recently-modified file notifications, status bar UI.

---

### Phase 3: Queue + Timeout + KV-Cache-Preserving Notifications

**Goal:** Questions are serialized via FIFO queue. Timeout covers queue wait + LLM processing. File modifications from tasks are accumulated as "recently modified" hints without evicting context.

**Files to modify:**
| File | Action | Notes |
|------|--------|-------|
| `src/services/helper-agent/manager.ts` | Modify | Add question queue, timeout handling, `notifyFileModified()`, `recentlyModifiedFiles` set, abort support |
| `src/core/tools/AskHelperAgentTool.ts` | Modify | Pass `timeoutMs`, handle timeout errors gracefully |

**What works at end of Phase 3:**

- Multiple tasks can ask questions concurrently; they serialize via FIFO
- Each `ask_helper_agent` call blocks up to `timeoutMs` (default 5 min)
- Timeout fires during queue wait OR LLM processing
- On timeout: LLM call aborted, partial work retained in context, error returned
- `manager.notifyFileModified(filePath)` hooks exist (wired in Phase 5)
- Recently modified files attached to next question as system hint

---

### Phase 4: Status Bar + Info Panel + Clear Context

**Goal:** User-visible status bar button (next to RAG indexer) with state indicators, fill percentage, and info panel. Clear Context button works.

**Files to create/modify:**
| File | Action | Notes |
|------|--------|-------|
| `src/extension.ts` | Modify | Register helper agent status bar button (blinking pattern, left-click info panel) |
| `src/services/helper-agent/manager.ts` | Modify | Add `getContextUsage()`, `clearContext()`, `onStateChange`/`onConversationUpdate` events |
| `src/activate/registerCommands.ts` | Modify | Register `helperAgent.start`, `helperAgent.stop`, `helperAgent.clearContext`, `helperAgent.showInfo` |

**What works at end of Phase 4:**

- Status bar shows helper agent state + fill percentage
- Icon blinks when Busy (matching RAG pattern)
- Left-click opens info panel: status, model, token usage bar, fill %, cost, files in context
- Clear Context button resets conversation to system prompt (cost tracking preserved)
- All actions (View Chat, Clear Context, Configure API, Start Agent) accessible via info panel quick pick

---

### Phase 5: Directory Tree + File Watcher + Chat View

**Goal:** System prompt includes workspace directory tree. File watcher detects external changes. Chat view panel lets user observe agent activity.

**Files to create/modify:**
| File | Action | Notes |
|------|--------|-------|
| `src/services/helper-agent/directory-tree.ts` | Create | Scan workspace, generate `find .`-style tree, exclude `.shoferignore` + worktree paths, cap at 10% of context window |
| `src/services/helper-agent/file-watcher.ts` | Create | VSCode FileSystemWatcher wrapper, 500ms debounce, notify ContextWindow |
| `src/services/helper-agent/manager.ts` | Modify | Integrate directory tree into system prompt on init + Clear Context, integrate file watcher, hook `notifyFileModified` from tool execution pipeline |
| `src/core/webview/HelperAgentChatProvider.ts` | Create | Webview panel provider for read-only chat view |
| `src/core/webview/ShoferProvider.ts` | Modify | Register chat view provider, subscribe to events |
| `src/core/context-tracking/FileContextTracker.ts` | Modify | Emit events on file modification that `HelperAgentManager` subscribes to |

**What works at end of Phase 5:**

- Directory tree injected into system prompt (capped, `.shoferignore`-respecting)
- File watcher detects external changes (lazy re-read on next reference)
- Tool-based file modifications trigger `notifyFileModified()` → accumulated for next question
- Chat view panel shows live conversation (read-only, agent-to-agent)
- `FileContextTracker` events wired to helper agent

---

### Dependency Graph

```
Phase 1 (Core Manager)
  └── Phase 2 (Native Tool Integration)
        └── Phase 3 (Queue + Timeout + Notifications)
              ├── Phase 4 (Status Bar + Info Panel)
              └── Phase 5 (Directory Tree + File Watcher + Chat View)
```

Phases 4 and 5 can be implemented in parallel after Phase 3 is complete.

---

## Implementation Status (Completed 2026-05-14)

### Commit History

| Phase | Commit                                                                               | Files Changed                                                                       |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1     | `3a26139d5` `feat(helper-agent): Phase 1 — Core Manager + Configuration`             | 2 new: `packages/types/src/helper-agent.ts`, `src/services/helper-agent/manager.ts` |
| 2     | `d1309e281` `feat(helper-agent): Phase 2 — Native Tool + Tool System Integration`    | 2 new, 5 modified                                                                   |
| 3     | `4bab12a81` `feat(helper-agent): Phase 3 — Queue + Timeout + KV-Cache Notifications` | 1 modified: `manager.ts` (+256/-63)                                                 |
| 4     | `9d4c50554` `feat(helper-agent): Phase 4 — Status Bar + Info Panel + Clear Context`  | 1 modified: `extension.ts` (+189)                                                   |
| 5a    | `d80dbdc8c` `feat(helper-agent): Phase 5 — Directory Tree + File Watcher`            | 2 new, 1 modified                                                                   |
| 5b    | `3a90b5003` `feat(helper-agent): Phase 5b — Chat View + FileContextTracker hooks`    | 1 new, 2 modified                                                                   |
| R     | `794e6d0ac` `shofer: refactor helper agent into focused modules + typed plumbing`    | 5 new modules, 3 new test specs, 7 modified (incl. types + registerCommands)        |

_Fix:_ `80fef4f63` — pre-existing `toolParamNames` missing `rating`/`feedback` for `attempt_completion`.

### Status Summary

| Phase                                                        | Status      |
| ------------------------------------------------------------ | ----------- |
| Phase 1: Core Manager + Configuration                        | ✅ Complete |
| Phase 2: Native Tool + Tool System Integration               | ✅ Complete |
| Phase 3: Queue + Timeout + KV-Cache-Preserving Notifications | ✅ Complete |
| Phase 4: Status Bar + Info Panel + Clear Context             | ✅ Complete |
| Phase 5a: Directory Tree + File Watcher                      | ✅ Complete |
| Phase 5b: Chat View + FileContextTracker hooks               | ✅ Complete |
| R: Refactor into focused modules + typed plumbing            | ✅ Complete |

### Files Created (13)

| File                                                                                                                                                   | Phase | Lines | Description                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/types/src/helper-agent.ts`](extensions/shofer/packages/types/src/helper-agent.ts:1)                                                         | 1     | 176   | Zod schemas for AgentMessage, FileContextEntry, HelperAgentConfig, QuestionResult, CostTracking; HELPER_AGENT_SYSTEM_PROMPT; all 11 constants                |
| [`src/services/helper-agent/manager.ts`](extensions/shofer/src/services/helper-agent/manager.ts:1)                                                     | 1, R  | 621   | Singleton-per-workspace orchestrator. Owns lifecycle, config, event emitters; delegates everything else to focused collaborators.                            |
| [`src/services/helper-agent/conversation-store.ts`](extensions/shofer/src/services/helper-agent/conversation-store.ts:1)                               | R     | 141   | Versioned JSON snapshot persistence. SHA-256 file-context validation on load; ENOENT-safe; discards on version mismatch.                                     |
| [`src/services/helper-agent/question-queue.ts`](extensions/shofer/src/services/helper-agent/question-queue.ts:1)                                       | R     | 158   | Bounded FIFO with per-entry AbortSignal + timeout. Reentrant-safe drain loop. `cancelAll()` for shutdown.                                                    |
| [`src/services/helper-agent/context-window.ts`](extensions/shofer/src/services/helper-agent/context-window.ts:1)                                       | R     | 197   | In-memory window for messages + file contexts. LRU eviction (file contexts first by `lastReferencedAt`, then oldest user/assistant pairs). Token estimation. |
| [`src/services/helper-agent/llm-client.ts`](extensions/shofer/src/services/helper-agent/llm-client.ts:1)                                               | R     | 212   | Adapter wrapping `buildApiHandler()`. Maps the helper-agent provider list to `ProviderSettings`; consumes `ApiStream` with abort support.                    |
| [`src/services/helper-agent/pricing.ts`](extensions/shofer/src/services/helper-agent/pricing.ts:1)                                                     | R     | 48    | Per-model USD cost from `ApiHandler.getModel().info.{inputPrice,outputPrice}`; fallback constants when the handler omits pricing.                            |
| [`src/services/helper-agent/directory-tree.ts`](extensions/shofer/src/services/helper-agent/directory-tree.ts:1)                                       | 5a    | 158   | Recursive workspace scan, `find .`-style tree generation, ~10% token cap, common-dir exclusion set                                                           |
| [`src/services/helper-agent/file-watcher.ts`](extensions/shofer/src/services/helper-agent/file-watcher.ts:1)                                           | 5a    | 106   | VSCode FileSystemWatcher wrapper, 500ms per-file debounce, worktree + hidden-path skipping                                                                   |
| [`src/services/helper-agent/__tests__/conversation-store.spec.ts`](extensions/shofer/src/services/helper-agent/__tests__/conversation-store.spec.ts:1) | R     |       | Vitest spec for versioned persistence + hash validation.                                                                                                     |
| [`src/services/helper-agent/__tests__/question-queue.spec.ts`](extensions/shofer/src/services/helper-agent/__tests__/question-queue.spec.ts:1)         | R     |       | Vitest spec for FIFO ordering, abort, timeout, bulk cancel.                                                                                                  |
| [`src/services/helper-agent/__tests__/context-window.spec.ts`](extensions/shofer/src/services/helper-agent/__tests__/context-window.spec.ts:1)         | R     |       | Vitest spec for LRU eviction + token-budget enforcement.                                                                                                     |
| [`src/core/prompts/tools/native-tools/ask_helper_agent.ts`](extensions/shofer/src/core/prompts/tools/native-tools/ask_helper_agent.ts:1)               | 2     | 51    | OpenAI ChatCompletionTool schema: question (required), contextFiles, timeoutMs                                                                               |
| [`src/core/tools/AskHelperAgentTool.ts`](extensions/shofer/src/core/tools/AskHelperAgentTool.ts:1)                                                     | 2     | 102   | BaseTool<"ask_helper_agent"> delegating to HelperAgentManager                                                                                                |
| [`src/core/webview/HelperAgentChatProvider.ts`](extensions/shofer/src/core/webview/HelperAgentChatProvider.ts:1)                                       | 5b    | 134   | Read-only WebviewPanel with conversation history, auto-refresh on state changes, accessible via status bar info panel                                        |

### Files Modified (13)

| File                                                    | Phase    | Changes                                                                                                                      |
| ------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/index.ts`                           | 1        | Added `export * from "./helper-agent.js"`                                                                                    |
| `packages/types/src/tool.ts`                            | 1        | Added `"ask_helper_agent"` to `toolNames`, `TOOL_DISPLAY_NAMES`, `TOOL_GROUPS.read`                                          |
| `packages/types/src/telemetry.ts`                       | 1        | Added `HELPER_AGENT_ERROR = "Helper Agent Error"` to TelemetryEventName                                                      |
| `packages/types/src/global-settings.ts`                 | R        | Added 6 `helperAgent*` keys to `globalSettingsSchema`; 6 `helperAgent*Key` to `GLOBAL_SECRET_KEYS`                           |
| `packages/types/src/vscode.ts`                          | R        | Added 5 helper-agent command ids to the typed `commandIds` array                                                             |
| `src/shared/tools.ts`                                   | 1, fix   | Added `ask_helper_agent` to `NativeToolArgs`; pre-existing fix for `toolParamNames`                                          |
| `src/extension.ts`                                      | 1,4,5b,R | Per-workspace activation, disposeAll(), status bar button, chat view import; commands now registered via registerCommands.ts |
| `src/activate/registerCommands.ts`                      | R        | Registers the 5 helper-agent commands through the typed `commandIds` plumbing                                                |
| `src/core/prompts/tools/native-tools/index.ts`          | 2        | Import + registration in `getNativeTools()`                                                                                  |
| `src/core/assistant-message/presentAssistantMessage.ts` | 2        | Import, description, dispatch case                                                                                           |
| `src/core/prompts/tools/filter-tools-for-mode.ts`       | 2        | Added `helperAgentManager` (8th parameter), conditional `ask_helper_agent` exclusion                                         |
| `src/core/task/build-tools.ts`                          | 2        | Import `HelperAgentManager`, pass to `filterNativeToolsForMode`                                                              |
| `src/core/auto-approval/tools.ts`                       | 2        | Added `askHelperAgent: "ask_helper_agent"` auto-approval entry                                                               |
| `src/core/context-tracking/FileContextTracker.ts`       | 5b       | Added `_notifyHelperAgent()` hook on `shofer_edited` events                                                                  |

### Implementation Deviations from Design

All deviations originally listed here have been resolved. The current implementation
matches the design contract: typed config via `ContextProxy`, typed `CommandId`
plumbing, the shared `buildApiHandler()` for LLM transport, and dedicated modules
for conversation storage, the question queue, the context window, and pricing.

| Original Deviation                                                                   | Status   | Resolution                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All functionality consolidated in `manager.ts` (~1020 lines)                         | Resolved | Split into focused modules: `conversation-store.ts`, `question-queue.ts`, `context-window.ts`, `llm-client.ts`, `pricing.ts`. `manager.ts` is now a thin orchestrator. |
| Config read from `vscode.workspace.getConfiguration(...)` + `context.secrets.get()`  | Resolved | Reads/writes go through `ContextProxy.getInstance(context)`. Config keys added to `globalSettingsSchema`; secrets added to `GLOBAL_SECRET_KEYS`.                       |
| `_callLLM()` did direct `fetch()` calls per provider                                 | Resolved | `HelperAgentLlmClient` wraps the shared `buildApiHandler()`. Streaming-only, abort-aware via `AbortSignal`. Adds OpenRouter + Anthropic without bespoke code.          |
| Inline `_loadConversation()` / `_saveConversation()`                                 | Resolved | Extracted into `ConversationStore` with versioned snapshot, hash-based file-context validation, and async I/O helpers.                                                 |
| Inline `_questionQueue` array + `_processNextQuestion()`                             | Resolved | Extracted into `QuestionQueue` with per-entry `AbortSignal`, FIFO processing, queue-size cap, and bulk cancellation.                                                   |
| Commands registered directly in `extension.ts` via `vscode.commands.registerCommand` | Resolved | Helper agent command IDs added to `commandIds` in `packages/types/src/vscode.ts`; registered in `src/activate/registerCommands.ts` like every other command.           |

### Deferred Items

| Item                                                                      | Design Reference                 | Reason                                                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ShoferProvider.ts` — subscribe to helper agent events                    | Phase 5 Integration Points table | Would push helper agent status/events to the Shofer webview. A separate wiring pass after the core tool pipeline is stabilized. |
| `webviewMessageHandler.ts` — settings save, status request, secret status | Integration Points table         | Settings UI integration for the webview.                                                                                        |
| `system.ts` — helper agent status in system prompt context                | Integration Points table         | Inclusion of helper agent availability + model info in the task agent's system prompt.                                          |

### Build Verification

All 5 phase commits pass:

- **ESLint**: `pnpm run lint` — zero warnings
- **TypeScript**: `pnpm run check-types` — only pre-existing test file errors (unrelated `AttemptCompletionToolUse` rating type issue)
- **VSCE Packaging**: `./deploy.sh dev build shofer` — produces `shofer-0.5.0.vsix` (31.74 MB)
