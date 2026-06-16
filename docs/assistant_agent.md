# Assistant Agent — Design & Implementation

## Purpose

The Assistant Agent is a **persistent, long-context LLM companion** that lives alongside the RAG indexer. Unlike per-task agents that are ephemeral and destroyed when a task terminates, the Assistant Agent survives across tasks and even VSCode restarts. It runs on a **cheap model with a very large context window**, allowing it to accumulate codebase knowledge over time and answer simple questions that other agents (running in their own tasks) can leverage without re-loading the entire codebase. It is exposed to agents as the `ask_assistant_agent` native tool.

The key design principles:

- **Persistent context** — the agent's conversation history survives task termination and VSCode restarts.
- **Cheap + large context** — user selects a low-cost model optimized for large windows (e.g., Gemini Flash, GPT-4o-mini, Claude Haiku).
- **File-aware** — notified of file changes (like the RAG indexer) so it can re-read changed files to keep its context fresh. File access respects `.shofer/shoferignore` — excluded files are never loaded into context.
- **Serialized access** — questions are queued; only one question is processed at a time.
- **KV-cache preserving** — the context window is append-only during normal operation. Files are never evicted when modified by tasks; instead a "recently modified" notification is attached to the next question. This keeps the LLM provider's attention cache warm, minimizing token costs and latency.
- **Cold start** — context window starts empty on first launch; fills organically as tasks ask questions.
- **Truncation, not summarization** — when the context window fills up, oldest messages are simply dropped. No lossy compression or summarization is ever applied, keeping the remaining context pristine.
- **Strictly read-only** — the assistant agent has **no access** to code-writing tools, CLI commands, or MCP tools. It can only use the "Read" category of native tools (file reading, search, LSP symbol lookup). This is a hard constraint enforced by tool filtering.
- **Fixed system prompt** — the assistant agent's system prompt is internally defined and not user-configurable. It instructs the agent to be a concise, read-only codebase Q&A assistant. The prompt includes a snapshot of the workspace directory/file hierarchy (like `find .` output), capped at ~10% of the context window, with `.shofer/shoferignore`-excluded files omitted.

---

## Architecture

`AssistantAgentManager` is a thin orchestrator that owns the lifecycle, the
configuration, and the event emitters consumed by the webview. All heavy
lifting lives in focused single-responsibility collaborators it composes:

```
AssistantAgentManager (singleton per workspace, vscode.Disposable)
 │
 ├── ShoferIgnoreController       — .shofer/shoferignore pattern validation
 │                                 (shared with rest of extension; filters all paths)
 ├── ConversationStore           — versioned JSON snapshot persistence
 │                                 (SHA-256 file-context validation, ENOENT-safe)
 ├── QuestionQueue                — bounded FIFO with per-entry AbortSignal
 │                                 (serializes question processing; bulk cancel)
 ├── ContextWindow                — token budget + LRU eviction
 │                                 (file contexts evicted before message pairs)
 ├── AssistantAgentLlmClient         — wraps shared `buildApiHandler()` ApiHandler
 │                                 (streaming, abort-aware, full provider catalog)
 ├── AssistantAgentToolExecutor   — read-only tool dispatcher (wraps ripgrep, glob,
 │                                 extract-text, CodeIndexManager; no Task dependency)
 ├── AssistantAgentDirectoryTree     — workspace scanner, ~10% context-window cap
 │                                 (.shofer/shoferignore-filtered via ShoferIgnoreController)
 ├── AssistantAgentFileWatcher       — VSCode FileSystemWatcher, 500ms debounce
 │                                 (.shofer/shoferignore-filtered via ShoferIgnoreController)
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

| File                                                 | Lines | Role                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/assistant-agent/manager.ts`            | ~910  | Singleton orchestrator. Public API: `initialize`, `startAgent`, `stopAgent`, `askQuestion`, `clearContext`, getters for state/usage/cost, two event emitters.                                                                                                                                       |
| `src/services/assistant-agent/conversation-store.ts` | ~140  | Versioned JSON snapshot persistence under `globalStorage`. SHA-256 hash validation of cached file contents on load; drops on mismatch or `ENOENT`.                                                                                                                                                  |
| `src/services/assistant-agent/question-queue.ts`     | ~160  | Bounded FIFO with per-entry `AbortSignal`. Reentrant-safe drain loop; per-entry timeouts; bulk `cancelAll()`.                                                                                                                                                                                       |
| `src/services/assistant-agent/context-window.ts`     | ~200  | In-memory window: messages + file contexts with token estimates. LRU eviction (file contexts first by `lastReferencedAt`, then oldest user/assistant pairs).                                                                                                                                        |
| `src/services/assistant-agent/llm-client.ts`         | ~320  | Adapter onto the shared `buildApiHandler()`. Maps the assistant-agent's curated provider list to `ProviderSettings`; consumes `ApiStream` with abort support.                                                                                                                                       |
| `src/services/assistant-agent/tool-executor.ts`      | ~380  | Read-only tool dispatcher wrapping ripgrep, glob, extract-text, and CodeIndexManager. No Task dependency — pure utility layer. Only `TOOL_GROUPS.read` tools (minus `ask_assistant_agent` itself).                                                                                                  |
| `src/services/assistant-agent/pricing.ts`            | ~50   | Reads per-model USD pricing from `ApiHandler.getModel().info.{inputPrice,outputPrice}`; fallback constants when the handler does not expose pricing.                                                                                                                                                |
| `src/services/assistant-agent/directory-tree.ts`     | ~170  | Recursive workspace scan. `find .`-style tree generation. Filtered through `.shofer/shoferignore` (via `ShoferIgnoreController.validateAccess()`); hardcoded `SKIP_PARTS` set (exported, shared with file-watcher) as fast-path pre-filter. Capped at ~10% of context window.                       |
| `src/services/assistant-agent/file-watcher.ts`       | ~110  | VSCode `FileSystemWatcher` wrapper. 500ms per-file debounce. Filtered through `.shofer/shoferignore` (via `ShoferIgnoreController.validateAccess()`); `SKIP_PARTS` set (imported from `directory-tree.ts`) as fast-path pre-filter. Notifies the manager which invalidates `ContextWindow` entries. |
| `src/services/assistant-agent/__tests__/`            |       | Vitest specs for `ConversationStore`, `QuestionQueue`, `ContextWindow` (25 cases, no `vscode` mocks needed).                                                                                                                                                                                        |
| `packages/types/src/assistant-agent.ts`              | ~230  | Zod schemas (`AgentMessage`, `FileContextEntry`, `AssistantAgentConfig`, `QuestionResult`, `AssistantAgentCostTracking`, `AssistantAgentConversationData`); the fixed `ASSISTANT_AGENT_SYSTEM_PROMPT`; 13 constants.                                                                                |
| `packages/types/src/global-settings.ts`              |       | `assistantAgent{Enabled,ApiConfigId,MaxContextTokens,ContextFillThreshold}` keys on `globalSettingsSchema`. Credentials come from the linked API Configuration profile (no assistant-agent-specific `GLOBAL_SECRET_KEYS`).                                                                          |
| `packages/types/src/vscode.ts`                       |       | Assistant-agent command ids on the typed `commandIds` array (`assistantAgent.{start,stop,clearContext,showChat,openSettings}`).                                                                                                                                                                     |

### Module Contracts

The collaborators are **concrete classes**, not interfaces (no `interfaces/`
directory). The Manager depends directly on each class; substitution for
testing is achieved by constructor injection at the spec level. The public
shape of each module:

- **`ConversationStore`** — `load(): Promise<ConversationSnapshot>`, `save(snapshot)`, `filePath` getter. In-memory `ConversationSnapshot` shape: `{ messages, fileContexts, costTracking }` (version lives on the persisted `AssistantAgentConversationData`). Discards on version mismatch (no migrations).
- **`QuestionQueue`** — `setProcessor(fn)`, `enqueue(question, contextFiles?, timeoutMs?, softLimits?): Promise<QuestionResult>`, `cancelAll()`, `pendingCount`, `isProcessing`. `softLimits` carries `{ softTimeoutSec?, softResultLength? }` — prompt-embedded recommendations, not enforced. Processor signature: `(question, contextFiles, signal, softLimits) => Promise<QuestionResult>`.
- **`ContextWindow`** — `configure(opts)`, `restore(messages, fileContexts)`, `clear()`, `appendMessage`, `upsertFileContext`, `removeFileContext`, `invalidateFileContext`, `enforceLimit()`, `getUsage()`, `consumeEvictedTokens()`. Plus getters used by the Manager: `messages`, `fileContexts`, `fileContextPaths`, `estimatedTokenCount`, `maxContextTokens`, `contextFillThreshold`, `isNearlyFull`.
- **`AssistantAgentLlmClient`** — constructor builds an `ApiHandler` via `buildApiHandler(toProviderSettings(config), { taskId: ASSISTANT_AGENT_TASK_ID })`. `chat(messages, signal?): Promise<ChatResult>` drains `ApiStream`, accumulating `text` chunks into the answer and `usage` chunks into prompt/completion tokens; cooperatively aborts between chunks via the `AbortSignal`.
- **`AssistantAgentDirectoryTree`** — constructor `(workspacePath, maxContextTokens, shoferIgnoreController?)`; `generate(): Promise<string>` returning the formatted tree string capped at `DIRECTORY_TREE_MAX_CONTEXT_FRACTION * maxContextTokens`. Filters entries through `validateAccess()` when a controller is provided. Hardcoded `SKIP_PARTS` set (`node_modules`, `.git`, `.shofer`, `__pycache__`, `.cache`, `dist`, `out`, `build`, `target`, `.next`, `.turbo`) acts as a fast-path pre-filter.
- **`AssistantAgentFileWatcher`** — constructor `(workspacePath, onChange, shoferIgnoreController?)`; `start()`, `dispose()`; 500ms per-file debounce. Filters change events through `validateAccess()` when a controller is provided. `SKIP_PARTS` set (imported from `directory-tree.ts`) acts as a fast-path pre-filter.

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

**`AssistantAgentConfig`**:

```typescript
{
	enabled: boolean
	apiConfigId: string // ID of the linked API Configuration profile
	apiConfigName: string // Display name of the linked profile
	providerSettings: ProviderSettings // Resolved profile fed into buildApiHandler
	maxContextTokens: number // Overridable; defaults to model's reported contextWindow
	contextWindowSource: "override" | "model-info" | "unresolved"
	contextFillThreshold: number // 0.0–1.0, default 0.80 — "nearly full" warning threshold
}
```

The system prompt is **not configurable** — it is hardcoded in the service and instructs the assistant agent to act as a concise, read-only codebase Q&A assistant. The prompt includes a **workspace directory tree** snapshot (see [Directory Tree Injection](#7-directory-tree-injection-directorytreets)).

The only user-configurable properties are the **API configuration** (provider, model, credentials) and the **Clear Context** action (which resets the conversation to just the system prompt and regenerates the directory tree).

**`QuestionResult`** — response from the assistant agent:

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
AssistantAgentManager.getInstance(context, folder.uri.fsPath)
  → manager.initialize(contextProxy)   // non-blocking, runs in background
```

### 2. Initialization (`manager.ts` → `initialize()`)

```
Manager.initialize()
  → loadConfigFromContextProxy()  // reads assistantAgent* state keys + secrets
  → check: enabled? configured?
  → ConversationStore.load() → snapshot { version, messages, fileContexts, costTracking }
      version mismatch → discard (no migrations)
  → ContextWindow.configure({ maxContextTokens, contextFillThreshold })
  → ContextWindow.restore(snapshot.messages, validatedFileContexts)
  → instantiate AssistantAgentLlmClient (wraps buildApiHandler)
  → startAgent()
```

### 3. Agent Startup (`manager.ts` → `startAgent()`)

```
for each FileContextEntry restored from snapshot:
  re-read file from disk → SHA-256 hash
  if hash matches → keep in window
  if hash differs or ENOENT → drop (ContextWindow.removeFileContext)

AssistantAgentDirectoryTree.generate() → cached tree string
new AssistantAgentFileWatcher(workspacePath, onFileChanged)
state → Ready
```

### 4. Question Handling (`manager.ts` → `_processQuestion()` via `QuestionQueue`)

```
External Task calls ask_assistant_agent tool (synchronous — task blocks until answer or timeout)
  → AssistantAgentTool.invoke({ question, contextFiles?, timeoutMs?, softTimeoutSec?, softResultLength? })
  → Start a single timeout timer covering the ENTIRE duration (queue wait + LLM processing)
  → QuestionQueue.enqueue({ question, sourceTaskId, timeoutMs, softTimeoutSec, softResultLength })
  → Wait for queue position (if agent is Busy) — timeout is running
  → If timeout fires at any point (during queue wait OR during LLM call):
      abort the LLM call via AbortController (if in progress)
      retain any partial response and file reads already appended to context (KV-cache preserving)
      transition to Ready (or process next queued question)
      return timeout error to caller

When dequeued (QuestionQueue invokes the processor with an AbortSignal):
  → state → Busy
  → If contextFiles provided: read each, ContextWindow.upsertFileContext(path, content, sha256)
  → ContextWindow.enforceLimit() → LRU eviction if over budget  ← (1) pre-loop enforcement
  → Drain recentlyModifiedFiles set (from tool invocation hooks)
  → Build system prompt once (stable across iterations):
      _buildSystemPrompt(recentlyModified, softLimits)
        [ASSISTANT_AGENT_SYSTEM_PROMPT + directory tree (~10% cap)]
        + [file context entries from window]
        + [recently modified notification]
        + [soft constraints hint]
        + [system-role messages from window]
  → Build initial base conversation from window:
      _buildBaseConversation(question)
        [user/assistant messages from window] + [current question]
  → Agent loop (max 25 tool-call iterations):
      for each iteration:
        → AssistantAgentLlmClient.chatWithTools({ systemPrompt, messages: conversation, tools, signal })
            → drains ApiStream: accumulates `text` chunks, captures `usage` chunks
            → if toolCalls.length === 0 → got final answer, break
        → Append assistant turn (text + tool_use blocks) to in-flight conversation
        → Execute tool calls, append tool_result blocks to in-flight conversation
        → ContextWindow.enforceLimit()                  ← (2) loop enforcement
        → rebuild base from trimmed window:
            _buildBaseConversation(question)
            conversation.splice(0, baseLength, ...freshBase)   // refresh base, keep in-flight
  → ContextWindow.appendMessage({ role: "user", content: question })
  → ContextWindow.appendMessage({ role: "assistant", content: finalAnswer })
  → ContextWindow.enforceLimit() → LRU eviction if over budget  ← (3) post-append enforcement
  → accumulate evicted tokens into costTracking
  → ConversationStore.save(snapshot)
  → state → Ready (or stay Busy if queue non-empty)
  → Return QuestionResult { answer, usage, costSnapshot, evictedTokens } to caller
```

### 5. File Change Handling (`file-watcher.ts`)

The assistant agent stays aware of file modifications through **two complementary mechanisms**:

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

Instead, the assistant agent accumulates a list of **recently modified file paths** and attaches it to each question. This preserves the KV cache while keeping the agent informed:

```
Task tool modifies file (write_to_file, apply_diff, insert_edit, sed, file rm/mv, rename_symbol)
  → Tool execution completes successfully
  → AssistantAgentManager.onFileModifiedByTask(filePath)  // hook invoked
  → Check against .shofer/shoferignore — skip if ignored
  → Check against .shofer/worktrees/ — skip worktree files
  → Add filePath to recentlyModifiedFiles set          // NO eviction — KV cache preserved
```

On the next question:

```
Question dequeued from queue
  → Drain recentlyModifiedFiles set
  → Append the note to the trailing QUESTION turn (NOT the system prompt):
      "<question>\n\n[Note: the following files have been modified since you last
        read them: src/foo.ts, src/bar.ts. Consider re-reading them if relevant
        to this question.]"
  → The model can then use read_file to re-read stale files if needed
  → recentlyModifiedFiles set is cleared after being attached
```

> **Placement matters for the KV cache.** The recently-modified note (and the
> per-question soft constraints) are appended to the **trailing question turn**,
> never to the system-prompt prefix. Providers cache on the longest stable
> prefix; injecting per-question-varying content into the system prefix would
> invalidate the cache on every question — defeating the very eviction-avoidance
> this mechanism exists to protect. `_buildSystemPrompt()` therefore carries only
> cross-question-stable content (directory tree, file-context manifest, folded
> system markers); `_buildQuestionHints()` produces the volatile suffix that
> rides on the question. (Earlier revisions placed these hints in the system
> prompt — a self-inconsistency with the cache-preservation goal, now fixed.)

This approach:

- **Preserves the KV cache** — the existing context window is never mutated, so the LLM provider can reuse cached attention computations, keeping requests fast and cheap.
- **Informs without forcing** — the model knows which files are stale and can decide whether to re-read them based on relevance to the current question.
- **Aligns with worktree best practices** — since tasks normally operate in worktrees (`.shofer/worktrees/<name>/`), main-branch files are rarely modified directly. The primary case where files appear in this list is after a worktree merge back into master. The assistant agent does not depend on git — it just sees "file X was modified."
- **Clears on use** — the set is drained after each question, so stale notifications don't accumulate across questions.

Integration point: `AssistantAgentManager` subscribes to tool execution events (filtered by `"shofer_edited"` source) via [`FileContextTracker.trackFileContext`](src/core/context-tracking/FileContextTracker.ts:39) or an equivalent centralized event bus emitted by the tool execution pipeline.

```

```

### 6. Directory Tree Injection (`directory-tree.ts`)

On agent startup (and after Clear Context), the assistant agent scans the workspace and injects a directory/file hierarchy into the system prompt. This gives the agent immediate awareness of the project structure without needing to call `list_files` on every question.

```
startAgent() or clearContext():
  → Scan workspace root with find/list_files equivalent
  → Apply .shofer/shoferignore filter — skip excluded paths
  → Apply .shofer/worktrees/ filter — skip worktree directories
  → Generate tree output (similar to `find . -not -path './.shofer/shoferignore-patterns'`):
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
- **Excludes** `.shofer/shoferignore`-listed paths and `.shofer/worktrees/` directories
- **Provides immediate orientation** — the agent knows the project layout without tool calls

Integration point: `src/services/assistant-agent/directory-tree.ts` — generates and token-counts the tree.

### 7. Context Window Management (`context-window.ts`)

The assistant agent uses **truncation, not summarization**. The context window is a ring-buffer-like structure where old content is simply dropped when the limit is reached. No summarization is ever performed — the idea is to keep the context window nearly full (configurable up to a fill threshold) with raw conversation and file content.

`enforceLimit()` is called at **three points** during question processing:

```
(1) Pre-loop — in _loadFileIntoContext(), after contextFiles are upserted
(2) Loop — at the end of each agent-loop iteration, after tool results are appended
(3) Post-append — after the final user+assistant Q&A pair is appended to the window
```

At the loop call site (2), the base portion of the in-flight conversation is
**refreshed from the possibly-trimmed window** via `_buildBaseConversation()`
so the next LLM iteration benefits from the eviction immediately. The in-flight
tool_use/tool_result turns are preserved by splicing only the base zone.

```
Token budget = assistantAgentMaxContextTokens (user-configurable)
Fill threshold = assistantAgentContextFillThreshold (default 0.80 = 80%)

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

Loop-time enforcement:
  → After each iteration: enforceLimit() trims the persisted window
  → _buildBaseConversation() rebuilds the base from the trimmed window
  → conversation.splice(0, baseLength, ...freshBase) replaces the base zone
  → In-flight tool_use/tool_result turns are preserved across the splice
  → The system prompt (built once per question) remains stable
```

---

## Storage Topology

| Data                      | Storage Location                                                                                                   | Survives Reboot?                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Conversation history**  | VS Code globalStorage: `~/.config/Code/User/globalStorage/shofer.dev/shofer-assistant-agent-<workspace-hash>.json` | ✓ Yes — persisted alongside VS Code settings |
| **File context registry** | Same JSON file as conversation history (nested under `fileContexts` key)                                           | ✓ Yes — persisted in globalStorage           |
| **API keys & secrets**    | VS Code `SecretStorage` (managed via the linked API Configuration profile, not per-agent keys)                     | ✓ Yes — OS-level credential store            |
| **Configuration**         | VS Code `globalState` (via `ContextProxy`)                                                                         | ✓ Yes — synced with VS Code settings         |

### Persistence Format

The conversation store persists a single JSON file:

```json
{
	"version": 2,
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

### `ask_assistant_agent` — Native Tool

A new native tool exposed to all tasks. The tool is **synchronous (blocking)** — the calling task waits until the assistant agent finishes processing the question and returns an answer, or until the optional timeout expires. On timeout, processing is **aborted** but any partial work (file reads, partial response) already added to the context window is **retained** to preserve the LLM provider's KV cache.

```
Tool: ask_assistant_agent
Description: Ask a question to the persistent assistant agent that maintains
             long-term context about the codebase. This is a synchronous tool —
             the calling task will block until the answer is returned or the
             timeout is reached. Use this for simple questions about the code
             that don't require the full task context to be loaded.

Parameters:
  - question (string, required): The question to ask the assistant agent.
  - contextFiles (string[], optional): File paths that are relevant
    to this question. The assistant agent will load these into its
    context window if they aren't already present.
  - timeoutMs (number, optional): HARD maximum time to wait for an
    answer in milliseconds. Defaults to 300000 (5 minutes). If the
    timeout is exceeded, processing is aborted, any partial work
    already added to the context window is retained (to preserve KV
    cache), and the tool returns a timeout error.
  - softTimeoutSec (number, optional): SOFT recommendation in seconds
    for how long the assistant should spend on this question (default:
    DEFAULT_ASSISTANT_SOFT_TIMEOUT_SEC = 60). Embedded in the assistant's
    prompt as guidance; not enforced via cancellation.
  - softResultLength (number, optional): SOFT recommendation in
    characters for the maximum length of the assistant's final answer
    (default: DEFAULT_ASSISTANT_SOFT_RESULT_LENGTH = 2000). Embedded in
    the prompt as guidance; not enforced via truncation.

Returns:
  - answer (string): The assistant agent's response.
  - tokensUsed (object): Token counts for the request.
  - contextFiles (string[]): Files currently in the assistant's context.
```

Tool implementation: `src/core/tools/AssistantAgentTool.ts`
Tool schema: `src/core/prompts/tools/native-tools/ask_assistant_agent.ts`

### Tool Availability

- The `ask_assistant_agent` tool is **conditionally available** only when `AssistantAgentManager` is enabled + configured + in `Ready` or `Busy` state.
- If the agent is in `Standby`, `Initializing`, `Error`, or `Stopping` state, the tool is filtered out (similar to `rag_search` filtering).
- Filter logic in `src/core/prompts/tools/filter-tools-for-mode.ts`.

### Auto-Approval

The `ask_assistant_agent` tool is **auto-approved by default** (like `rag_search`), since it is read-only and uses a separate, cost-optimized model. Configured in `src/core/auto-approval/tools.ts`.

### Assistant Agent's Own Tool Restrictions

The assistant agent itself runs as an internal task with a **severely restricted tool set**. It is strictly read-only and cannot modify any state:

| Tool Category     | Available? | Tools Included                                                                                                                                                                                |
| ----------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**          | ✓ Yes      | `read_file`, `list_files`, `grep_search`, `find_files`, `rag_search`, `read_project_structure`, `list_code_usages`, `get_errors`, `get_project_setup_info`, `get_changed_files`, `lsp_search` |
| **Write/Edit**    | ✗ No       | `write_to_file`, `apply_diff`, `insert_edit`, `sed`                                                                                                                                           |
| **CLI/Execution** | ✗ No       | `execute_command`                                                                                                                                                                             |
| **MCP**           | ✗ No       | All MCP-provided tools (browser, k3s, mimir, loki, tempo, etc.)                                                                                                                               |
| **Task Control**  | ✗ No       | `new_task`, `switch_mode`, `attempt_completion`                                                                                                                                               |

These restrictions are enforced at the tool-filtering layer (`filter-tools-for-mode.ts`) based on a dedicated `assistant_agent` internal mode slug. The assistant agent's system prompt explicitly instructs it that it cannot make changes — it can only read and answer questions about the codebase. This ensures:

- **Safety** — no accidental code modifications from the assistant
- **Cost control** — the cheap model is never used for expensive operations
- **Predictability** — callers know the assistant agent's response is purely informational

---

## Integration Points

### Extension Host

| Point      | File                                                           | Details                                                                                                           |
| ---------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Activation | `src/extension.ts`                                             | Creates `AssistantAgentManager` per workspace folder, initializes in background                                   |
| Chat View  | `src/core/webview/AssistantAgentChatProvider.ts`               | Registers webview panel for the assistant agent chat view; streams live responses                                 |
| Provider   | `src/core/webview/ShoferProvider.ts`                           | Subscribes to `onAgentStateChange` to push assistant agent status to webview                                      |
| Toolbar    | `webview-ui/src/components/chat/AssistantAgentStatusBadge.tsx` | Badge + popover in the Shofer chat-input toolbar; hosts start/stop/clear/chat actions via `assistantAgentAction`  |
| Commands   | `src/activate/registerCommands.ts`                             | Registers `assistantAgent.start`, `assistantAgent.stop`, `assistantAgent.clearContext`, `assistantAgent.showChat` |

### Settings & Webview

| Point            | File                                        | Details                                                                       |
| ---------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Settings save    | `src/core/webview/webviewMessageHandler.ts` | `saveAssistantAgentSettingsAtomic` → saves secrets + `handleSettingsChange()` |
| Status request   | `webviewMessageHandler.ts`                  | `requestAssistantAgentStatus`                                                 |
| Start/stop/clear | `webviewMessageHandler.ts`                  | `startAssistantAgent`, `stopAssistantAgent`, `clearAssistantAgentContext`     |
| Secret status    | `webviewMessageHandler.ts`                  | `requestAssistantAgentSecretStatus`                                           |

### Tool System

| Point             | File                                                    | Details                                                                                                 |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Tool registration | `src/core/task/build-tools.ts`                          | Gets `AssistantAgentManager` for current workspace, passes to tool filter                               |
| Tool filtering    | `src/core/prompts/tools/filter-tools-for-mode.ts`       | Removes `ask_assistant_agent` if agent is disabled/unconfigured/not-ready                               |
| Tool dispatch     | `src/core/assistant-message/presentAssistantMessage.ts` | Routes to `AssistantAgentTool`                                                                          |
| Auto-approval     | `src/core/auto-approval/tools.ts`                       | `askAssistantAgent` is auto-approved by default                                                         |
| System prompt     | `src/core/prompts/sections/assistant-agent.ts`          | `getAssistantAgentSection()` — injects availability, model info, context fill % into task system prompt |

### Configuration Schema

State keys live on the extension-wide `globalSettingsSchema` in `packages/types/src/global-settings.ts`; secret keys are listed in `GLOBAL_SECRET_KEYS` in the same file. Both are accessed through the typed `ContextProxy` (`getValue` / `getSecret` / `setValue`) — the assistant agent never calls `vscode.workspace.getConfiguration` or `context.secrets` directly.

```typescript
// globalSettingsSchema (state, persisted in globalState)
assistantAgentEnabled: boolean // master on/off toggle
assistantAgentApiConfigId: string // ID of the linked API Configuration profile
assistantAgentMaxContextTokens: number // optional override; default from linked model's contextWindow
assistantAgentContextFillThreshold: number // 0.0–1.0, default 0.80

// GLOBAL_SECRET_KEYS (secrets, persisted in SecretStorage)
// No assistant-agent-specific secrets — credentials come from the linked API Configuration profile.
```

The Zod runtime schemas for the on-disk conversation snapshot — `assistantAgentConfigSchema`, `agentMessageSchema`, `fileContextEntrySchema`, `assistantAgentCostTrackingSchema`, `assistantAgentConversationDataSchema`, `questionResultSchema` — live in `packages/types/src/assistant-agent.ts`. The fixed `ASSISTANT_AGENT_SYSTEM_PROMPT` is also defined there.

The system prompt is **not exposed** in settings — it is internally defined. The only user-facing controls are the API configuration dropdown and the **Clear Context** button.

### Cost Tracking

The assistant agent tracks cumulative token usage and estimated cost across its entire lifecycle:

```typescript
interface AssistantAgentCostTracking {
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

All exported from `packages/types/src/assistant-agent.ts`:

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
| `CONVERSATION_STORE_VERSION`          | 2                                                              | Version for the persistence format                                    |

---

## Multi-Workspace Support

`AssistantAgentManager` uses the same **singleton-per-workspace** pattern as `CodeIndexManager`, via `Map<string, AssistantAgentManager>` keyed by `workspacePath`. Each workspace gets its own:

- Independent conversation history
- Independent file context registry
- Independent configuration (different model per workspace)
- Independent question queue

---

## Worktree Interaction

Shofer uses **embedded worktrees** — per-task git worktrees created under `.shofer/worktrees/<name>/` within the main workspace. Each worktree represents a different git branch, allowing tasks to work in isolation.

The assistant agent interacts with worktrees as follows:

- **Exclusion from context**: The assistant agent **never loads files from `.shofer/worktrees/`** directories. These represent ephemeral, task-scoped branches whose content is transient and would pollute the persistent context with unrelated branch state. This exclusion is enforced by `.shofer/shoferignore` patterns and additionally by a hardcoded path filter in the file watcher and lazy-load paths.

- **File path disambiguation**: Since worktree files live at `.shofer/worktrees/<name>/src/foo.ts` while main-branch files live at `src/foo.ts`, they are naturally distinct paths. The assistant agent's context only ever contains main-workspace file paths.

- **Worktree file watcher**: The `AssistantAgentFileWatcher` watches the entire workspace but skips events for paths under `.shofer/worktrees/`. Changes within worktrees do not trigger context eviction.

- **One assistant agent per workspace**: Since all worktrees share the same VS Code window (embedded model), there is a single assistant agent serving all tasks regardless of which worktree they operate in. The assistant agent's knowledge represents the **main branch** state, not individual worktree branches.

- **Worktree creation/deletion**: When a worktree is created or deleted, the assistant agent ignores those directory changes entirely — they fall under the excluded paths.

---

## UI: Toolbar Badge + Popover

The Assistant Agent status indicator lives in the **Shofer chat-input toolbar** (via `AssistantAgentStatusBadge` → `AssistantAgentPopover`), not in the VS Code status bar. It displays:

- **Icon badge**: Shows agent state with color-coded indicator
- **Pulsing animation**: The badge pulses when the agent is `Busy` (processing a question)
- **State indicator**:
    - `Initializing...` — agent is starting up
    - `Ready (42%)` — agent is idle; the percentage shows context window fill (`current / max` tokens)
    - `Busy (42%)` — processing a question; shows queue depth if > 0 queued
    - `Nearly Full (87%)` — context is above the fill threshold, truncation imminent
    - `Error` — configuration or connection issue
    - `Standby` — agent is configured but not started
- **Click**: Opens a **popover** showing:
    - **Status**: Current state, model name, provider
    - **Context**: Token usage bar (`current / max`, fill percentage with visual progress bar)
    - **Context window source**: How `maxContextTokens` was resolved (`override` | `model-info` | `unresolved`)
    - **Cost tracking**: Total input tokens, output tokens, truncated tokens, estimated cost (USD)
    - **Files in context**: Count and list of file paths
    - **Conversation**: Number of message turns
    - **Quick actions** (via `assistantAgentAction` webview message):
        - **Start** / **Stop** — control agent lifecycle
        - **View Chat** — opens the dedicated chat panel
        - **Clear Context** — resets conversation (cost tracking preserved)
        - **Open Settings** — opens API configuration settings

### Assistant Agent Chat View

A dedicated **chat panel** lets the user observe everything the assistant agent is doing in real time. It is accessible from:

- The toolbar popover: **"View Chat"** action
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

The chat view is **read-only** — the user cannot send messages directly to the assistant agent. All messages come from tasks via the `ask_assistant_agent` tool. This keeps the interaction model simple and prevents the user from accidentally polluting the context window.

Integration point: `src/core/webview/AssistantAgentChatProvider.ts` — manages a `WebviewPanel` with coalesced `postMessage` ticks; subscribes to manager state/conversation changes and forwards `state` messages containing the full message list and context usage to the webview for client-side diff-rendering.

---

## Error Handling & Recovery

- **Queue resilience**: If an LLM call fails, the question is rejected with an error, and the agent transitions to `Error` state. The queue is drained with rejection for all pending questions.
- **Recovery**: `recoverFromError()` clears all service instances and the LLM provider, forcing a clean re-initialization on next `startAgent()`.
- **Conversation preservation**: Conversation history is saved after every successful question/answer pair. If the agent crashes mid-question, the conversation state from before the question is preserved.
- **Token overflow**: If the context window is exceeded, `ContextWindow.enforceLimit()` truncates oldest file contexts (by `lastReferencedAt`) and then oldest user/assistant turn pairs before failing the request. Truncated content is permanently lost — no summarization is retained.
- **Telemetry**: All errors are captured via `TelemetryService.captureEvent(TelemetryEventName.ASSISTANT_AGENT_ERROR, {...})` with location context.

---

## Comparison with RAG Indexer

| Aspect               | RAG Indexer (`rag_search`)                  | Assistant Agent (`ask_assistant_agent`)                   |
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

**Goal:** The assistant agent can be configured, initialized, and can answer a single question via direct API call. No tool integration yet — testable via VS Code commands.

**Files to create/modify:**
| File | Action | Notes |
|------|--------|-------|
| `packages/types/src/assistant-agent.ts` | Create | Zod schemas, TypeScript interfaces, constants |
| `packages/types/src/index.ts` | Modify | Add `export * from "./assistant-agent.js"` |
| `packages/types/src/tool.ts` | Modify | Add `"ask_assistant_agent"` to `toolNames`, `TOOL_DISPLAY_NAMES`, `TOOL_GROUPS.read` |
| `src/services/assistant-agent/manager.ts` | Create | Singleton Manager with `initialize()`, `askQuestion()`, conversation persistence, LLM calling (OpenAI-compatible + Gemini) |
| `src/extension.ts` | Modify | Import, create per-workspace instances, background `initialize()`, `disposeAll()` in deactivate |
| `src/shared/tools.ts` | Modify | Add `ask_assistant_agent` to `NativeToolArgs` |

**What works at end of Phase 1:**

- User sets `assistantAgentEnabled`, provider, model, API key via settings
- Extension activation creates `AssistantAgentManager` per workspace
- `manager.initialize()` loads config + persisted conversation
- `manager.askQuestion("what is X?")` → returns answer from LLM
- Conversation persists across VSCode restarts
- Testable via `vscode.commands.executeCommand` or a temporary test command

**Out of scope for Phase 1:** Tool integration, status bar, file watcher, directory tree, chat view, timeouts.

---

### Phase 2: Native Tool + Tool System Integration

**Goal:** Tasks can call `ask_assistant_agent` via the native tool system. The tool is conditionally available based on assistant agent state.

**Files to create/modify:**
| File | Action | Notes |
|------|--------|-------|
| `src/core/prompts/tools/native-tools/ask_assistant_agent.ts` | Create | OpenAI tool schema (description, parameters) |
| `src/core/prompts/tools/native-tools/index.ts` | Modify | Import + register in `getNativeTools()` |
| `src/core/tools/AskAssistantAgentTool.ts` | Create | `BaseTool<"ask_assistant_agent">` implementation |
| `src/core/assistant-message/presentAssistantMessage.ts` | Modify | Import + dispatch case for `"ask_assistant_agent"` |
| `src/core/prompts/tools/filter-tools-for-mode.ts` | Modify | Add `assistantAgentManager` parameter, conditional exclusion logic |
| `src/core/task/build-tools.ts` | Modify | Import `AssistantAgentManager`, pass to `filterNativeToolsForMode` |
| `src/core/auto-approval/tools.ts` | Modify | Add `askAssistantAgent` to auto-approved tools |
| `src/services/assistant-agent/manager.ts` | Modify | Add `isAssistantAgentAvailable` getter |

**What works at end of Phase 2:**

- `ask_assistant_agent` appears in the agent's tool set when helper is enabled+configured+initialized
- Tool is auto-approved (read-only, separate model)
- Tool is filtered out when assistant agent is disabled/unconfigured

**Out of scope for Phase 2:** Timeout handling, recently-modified file notifications, status bar UI.

---

### Phase 3: Queue + Timeout + KV-Cache-Preserving Notifications

**Goal:** Questions are serialized via FIFO queue. Timeout covers queue wait + LLM processing. File modifications from tasks are accumulated as "recently modified" hints without evicting context.

**Files to modify:**
| File | Action | Notes |
|------|--------|-------|
| `src/services/assistant-agent/manager.ts` | Modify | Add question queue, timeout handling, `notifyFileModified()`, `recentlyModifiedFiles` set, abort support |
| `src/core/tools/AskAssistantAgentTool.ts` | Modify | Pass `timeoutMs`, handle timeout errors gracefully |

**What works at end of Phase 3:**

- Multiple tasks can ask questions concurrently; they serialize via FIFO
- Each `ask_assistant_agent` call blocks up to `timeoutMs` (default 5 min)
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
| `src/extension.ts` | Modify | Register assistant agent status bar button (blinking pattern, left-click info panel) |
| `src/services/assistant-agent/manager.ts` | Modify | Add `getContextUsage()`, `clearContext()`, `onStateChange`/`onConversationUpdate` events |
| `src/activate/registerCommands.ts` | Modify | Register `assistantAgent.start`, `assistantAgent.stop`, `assistantAgent.clearContext`, `assistantAgent.openSettings` |

**What works at end of Phase 4:**

- Status bar shows assistant agent state + fill percentage
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
| `src/services/assistant-agent/directory-tree.ts` | Create | Scan workspace, generate `find .`-style tree, exclude `.shofer/shoferignore` + worktree paths, cap at 10% of context window |
| `src/services/assistant-agent/file-watcher.ts` | Create | VSCode FileSystemWatcher wrapper, 500ms debounce, notify ContextWindow |
| `src/services/assistant-agent/manager.ts` | Modify | Integrate directory tree into system prompt on init + Clear Context, integrate file watcher, hook `notifyFileModified` from tool execution pipeline |
| `src/core/webview/AssistantAgentChatProvider.ts` | Create | Webview panel provider for read-only chat view |
| `src/core/webview/ShoferProvider.ts` | Modify | Register chat view provider, subscribe to events |
| `src/core/context-tracking/FileContextTracker.ts` | Modify | Emit events on file modification that `AssistantAgentManager` subscribes to |

**What works at end of Phase 5:**

- Directory tree injected into system prompt (capped, `.shofer/shoferignore`-respecting)
- File watcher detects external changes (lazy re-read on next reference)
- Tool-based file modifications trigger `notifyFileModified()` → accumulated for next question
- Chat view panel shows live conversation (read-only, agent-to-agent)
- `FileContextTracker` events wired to assistant agent

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

| Phase | Commit                                                                                        | Files Changed                                                                             |
| ----- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1     | `3a26139d5` `feat(assistant-agent): Phase 1 — Core Manager + Configuration`                   | 2 new: `packages/types/src/assistant-agent.ts`, `src/services/assistant-agent/manager.ts` |
| 2     | `d1309e281` `feat(assistant-agent): Phase 2 — Native Tool + Tool System Integration`          | 2 new, 5 modified                                                                         |
| 3     | `4bab12a81` `feat(assistant-agent): Phase 3 — Queue + Timeout + KV-Cache Notifications`       | 1 modified: `manager.ts` (+256/-63)                                                       |
| 4     | `9d4c50554` `feat(assistant-agent): Phase 4 — Status Bar + Info Panel + Clear Context`        | 1 modified: `extension.ts` (+189)                                                         |
| 5a    | `d80dbdc8c` `feat(assistant-agent): Phase 5 — Directory Tree + File Watcher`                  | 2 new, 1 modified                                                                         |
| 5b    | `3a90b5003` `feat(assistant-agent): Phase 5b — Chat View + FileContextTracker hooks`          | 1 new, 2 modified                                                                         |
| R     | `794e6d0ac` `shofer: refactor assistant agent into focused modules + typed plumbing`          | 5 new modules, 3 new test specs, 7 modified (incl. types + registerCommands)              |
| L     | `9cb81669f` `fix(assistant-agent): enforce context budget during agent loop and after append` | 1 modified: `manager.ts` (+53/-20); split `_buildAgentPrompt`, add 3-point enforcement    |

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

### Files Created (14)

| File                                                                                                                                                         | Phase | Lines | Description                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/types/src/assistant-agent.ts`](extensions/shofer/packages/types/src/assistant-agent.ts:1)                                                         | 1     | 228   | Zod schemas for AgentMessage, FileContextEntry, AssistantAgentConfig, QuestionResult, CostTracking; ASSISTANT_AGENT_SYSTEM_PROMPT; 13 constants              |
| [`src/services/assistant-agent/manager.ts`](extensions/shofer/src/services/assistant-agent/manager.ts:1)                                                     | 1, R  | 912   | Singleton-per-workspace orchestrator. Owns lifecycle, config, event emitters; delegates everything else to focused collaborators.                            |
| [`src/services/assistant-agent/conversation-store.ts`](extensions/shofer/src/services/assistant-agent/conversation-store.ts:1)                               | R     | 141   | Versioned JSON snapshot persistence. SHA-256 file-context validation on load; ENOENT-safe; discards on version mismatch.                                     |
| [`src/services/assistant-agent/question-queue.ts`](extensions/shofer/src/services/assistant-agent/question-queue.ts:1)                                       | R     | 158   | Bounded FIFO with per-entry AbortSignal + timeout. Reentrant-safe drain loop. `cancelAll()` for shutdown.                                                    |
| [`src/services/assistant-agent/context-window.ts`](extensions/shofer/src/services/assistant-agent/context-window.ts:1)                                       | R     | 197   | In-memory window for messages + file contexts. LRU eviction (file contexts first by `lastReferencedAt`, then oldest user/assistant pairs). Token estimation. |
| [`src/services/assistant-agent/llm-client.ts`](extensions/shofer/src/services/assistant-agent/llm-client.ts:1)                                               | R     | 320   | Adapter wrapping `buildApiHandler()`. Maps the assistant-agent provider list to `ProviderSettings`; consumes `ApiStream` with abort support.                 |
| [`src/services/assistant-agent/tool-executor.ts`](extensions/shofer/src/services/assistant-agent/tool-executor.ts:1)                                         | R     | 383   | Read-only tool dispatcher for the Assistant Agent. Wraps ripgrep, glob, extract-text, CodeIndexManager; no Task dependency. Only `TOOL_GROUPS.read` tools.   |
| [`src/services/assistant-agent/pricing.ts`](extensions/shofer/src/services/assistant-agent/pricing.ts:1)                                                     | R     | 48    | Per-model USD cost from `ApiHandler.getModel().info.{inputPrice,outputPrice}`; fallback constants when the handler omits pricing.                            |
| [`src/services/assistant-agent/directory-tree.ts`](extensions/shofer/src/services/assistant-agent/directory-tree.ts:1)                                       | 5a    | 158   | Recursive workspace scan, `find .`-style tree generation, ~10% token cap, common-dir exclusion set                                                           |
| [`src/services/assistant-agent/file-watcher.ts`](extensions/shofer/src/services/assistant-agent/file-watcher.ts:1)                                           | 5a    | 106   | VSCode FileSystemWatcher wrapper, 500ms per-file debounce, worktree + hidden-path skipping                                                                   |
| [`src/services/assistant-agent/__tests__/conversation-store.spec.ts`](extensions/shofer/src/services/assistant-agent/__tests__/conversation-store.spec.ts:1) | R     |       | Vitest spec for versioned persistence + hash validation.                                                                                                     |
| [`src/services/assistant-agent/__tests__/question-queue.spec.ts`](extensions/shofer/src/services/assistant-agent/__tests__/question-queue.spec.ts:1)         | R     |       | Vitest spec for FIFO ordering, abort, timeout, bulk cancel.                                                                                                  |
| [`src/services/assistant-agent/__tests__/context-window.spec.ts`](extensions/shofer/src/services/assistant-agent/__tests__/context-window.spec.ts:1)         | R     |       | Vitest spec for LRU eviction + token-budget enforcement.                                                                                                     |
| [`src/core/prompts/tools/native-tools/ask_assistant_agent.ts`](extensions/shofer/src/core/prompts/tools/native-tools/ask_assistant_agent.ts:1)               | 2     | 74    | OpenAI ChatCompletionTool schema: question (required), contextFiles, timeoutMs, softTimeoutSec, softResultLength                                             |
| [`src/core/tools/AskAssistantAgentTool.ts`](extensions/shofer/src/core/tools/AskAssistantAgentTool.ts:1)                                                     | 2     | 151   | BaseTool<"ask_assistant_agent"> delegating to AssistantAgentManager                                                                                          |
| [`src/core/webview/AssistantAgentChatProvider.ts`](extensions/shofer/src/core/webview/AssistantAgentChatProvider.ts:1)                                       | 5b    | 467   | Read-only WebviewPanel with conversation history, live streaming via coalesced postMessage ticks, client-side markdown rendering                             |

### Files Modified (13)

| File                                                    | Phase    | Changes                                                                                                                                                                                 |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/index.ts`                           | 1        | Added `export * from "./assistant-agent.js"`                                                                                                                                            |
| `packages/types/src/tool.ts`                            | 1        | Added `"ask_assistant_agent"` to `toolNames`, `TOOL_DISPLAY_NAMES`, `TOOL_GROUPS.read`                                                                                                  |
| `packages/types/src/telemetry.ts`                       | 1        | Added `ASSISTANT_AGENT_ERROR = "Assistant Agent Error"` to TelemetryEventName                                                                                                           |
| `packages/types/src/global-settings.ts`                 | R        | Added 4 `assistantAgent*` keys to `globalSettingsSchema` (`assistantAgentEnabled`, `assistantAgentApiConfigId`, `assistantAgentMaxContextTokens`, `assistantAgentContextFillThreshold`) |
| `packages/types/src/vscode.ts`                          | R        | Added 5 assistant-agent command ids to the typed `commandIds` array                                                                                                                     |
| `src/shared/tools.ts`                                   | 1, fix   | Added `ask_assistant_agent` to `NativeToolArgs`; pre-existing fix for `toolParamNames`                                                                                                  |
| `src/extension.ts`                                      | 1,4,5b,R | Per-workspace activation, disposeAll(), status bar button, chat view import; commands now registered via registerCommands.ts                                                            |
| `src/activate/registerCommands.ts`                      | R        | Registers the 5 assistant-agent commands through the typed `commandIds` plumbing                                                                                                        |
| `src/core/prompts/tools/native-tools/index.ts`          | 2        | Import + registration in `getNativeTools()`                                                                                                                                             |
| `src/core/assistant-message/presentAssistantMessage.ts` | 2        | Import, description, dispatch case                                                                                                                                                      |
| `src/core/prompts/tools/filter-tools-for-mode.ts`       | 2        | Added `assistantAgentManager` (9th parameter), conditional `ask_assistant_agent` exclusion                                                                                              |
| `src/core/task/build-tools.ts`                          | 2        | Import `AssistantAgentManager`, pass to `filterNativeToolsForMode`                                                                                                                      |
| `src/core/auto-approval/tools.ts`                       | 2        | Added `askAssistantAgent: "ask_assistant_agent"` auto-approval entry                                                                                                                    |
| `src/core/context-tracking/FileContextTracker.ts`       | 5b       | Added `_notifyAssistantAgent()` hook on `shofer_edited` events                                                                                                                          |

### Implementation Deviations from Design

All deviations originally listed here have been resolved. The current implementation
matches the design contract: typed config via `ContextProxy`, typed `CommandId`
plumbing, the shared `buildApiHandler()` for LLM transport, and dedicated modules
for conversation storage, the question queue, the context window, and pricing.

| Original Deviation                                                                   | Status   | Resolution                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All functionality consolidated in `manager.ts` (~1020 lines)                         | Resolved | Split into focused modules: `conversation-store.ts`, `question-queue.ts`, `context-window.ts`, `llm-client.ts`, `pricing.ts`. `manager.ts` is now a thin orchestrator. |
| Config read from `vscode.workspace.getConfiguration(...)` + `context.secrets.get()`  | Resolved | Reads/writes go through `ContextProxy.getInstance(context)`. Config keys added to `globalSettingsSchema`; secrets added to `GLOBAL_SECRET_KEYS`.                       |
| `_callLLM()` did direct `fetch()` calls per provider                                 | Resolved | `AssistantAgentLlmClient` wraps the shared `buildApiHandler()`. Streaming-only, abort-aware via `AbortSignal`. Adds OpenRouter + Anthropic without bespoke code.       |
| Inline `_loadConversation()` / `_saveConversation()`                                 | Resolved | Extracted into `ConversationStore` with versioned snapshot, hash-based file-context validation, and async I/O helpers.                                                 |
| Inline `_questionQueue` array + `_processNextQuestion()`                             | Resolved | Extracted into `QuestionQueue` with per-entry `AbortSignal`, FIFO processing, queue-size cap, and bulk cancellation.                                                   |
| Commands registered directly in `extension.ts` via `vscode.commands.registerCommand` | Resolved | Assistant agent command IDs added to `commandIds` in `packages/types/src/vscode.ts`; registered in `src/activate/registerCommands.ts` like every other command.        |

### Deferred Items

_No deferred items remain. All originally deferred work has been completed._

| Item                                                          | Design Reference         | Status                                                                                                                  |
| ------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `system.ts` — assistant agent status in system prompt context | Integration Points table | ✅ Resolved (2026-06-13) — see [`assistant-agent.ts`](extensions/shofer/src/core/prompts/sections/assistant-agent.ts:1) |

### Build Verification

All 5 phase commits pass:

- **ESLint**: `pnpm run lint` — zero warnings
- **TypeScript**: `pnpm run check-types` — only pre-existing test file errors (unrelated `AttemptCompletionToolUse` rating type issue)
- **VSCE Packaging**: `./deploy2.sh dev build shofer` — produces `shofer-0.5.0.vsix` (31.74 MB)

---

## Gaps, Issues & Areas for Improvement

_Audit performed 2026-05-20 — cross-referencing the design document against the actual source code._

### Resolved in This Review

These items were inaccurate in the doc and have been corrected above:

1. **Missing module: `tool-executor.ts`** — The architecture diagram and Key Source Files table omitted [`tool-executor.ts`](extensions/shofer/src/services/assistant-agent/tool-executor.ts:1) (383 lines), a significant module imported by the manager. Added.
2. **Stale line counts** — The Key Source Files table had `manager.ts` ~820 (actual: 912), `llm-client.ts` ~210 (actual: 320), `ask_assistant_agent.ts` 51 (actual: 74), `AskAssistantAgentTool.ts` 102 (actual: 151), `AssistantAgentChatProvider.ts` 134 (actual: 467). All corrected.
3. **Outdated configuration model** — `AssistantAgentConfig` and settings schema described pre-refactor per-provider keys. Now documents the actual linked API Configuration profile model (`assistantAgentApiConfigId`).
4. **Section numbering gap** — Skipped §6 entirely. Renumbered.
5. **Wrong UI placement** — Described a VS Code status bar button; actual implementation uses a toolbar badge + popover in the chat-input toolbar. Corrected.
6. **Stale Integration Points rows** — Removed phantom `registerStatusBar.ts` reference; marked `system.ts` as deferred.
7. **Overstated deferred items** — `ShoferProvider.ts` and `webviewMessageHandler.ts` were listed as deferred but are fully implemented. Removed.
8. **`CONVERSATION_STORE_VERSION` → 2** — Persisted format version is `z.literal(2)`, not `1`. Fixed.
9. **Constants count 11 → 13** — Missing `DEFAULT_ASSISTANT_SOFT_TIMEOUT_SEC` and `DEFAULT_ASSISTANT_SOFT_RESULT_LENGTH`. Fixed.
10. **Files Created 13 → 14** — Missing `tool-executor.ts`. Fixed.

### Resolved in This Review (cont'd)

11. **`file-watcher.ts` now consults `.shofer/shoferignore`** — ✅ Resolved (2026-05-24). The file watcher accepts an optional `ShoferIgnoreController` and calls `validateAccess(filePath)` in `_shouldSkip()`. Files matching `.shofer/shoferignore` patterns are silently skipped.

12. **`directory-tree.ts` now consults `.shofer/shoferignore`** — ✅ Resolved (2026-05-24). The directory tree generator accepts an optional `ShoferIgnoreController` and calls `validateAccess(relPath)` for each entry in `_scanDirectory()`. Ignored paths are excluded from the tree.

Additional fix: **`notifyFileModified()` now filters through `.shofer/shoferignore`** — The `AssistantAgentManager.notifyFileModified()` method previously only filtered `.shofer/` prefix paths. Now it also calls `validateAccess()` on the `ShoferIgnoreController`, preventing stale-file notifications for `.shofer/shoferignore`-ignored files.

### Open Issues (Not Yet Addressed in Source)

13. **No test coverage for `tool-executor.ts`, `directory-tree.ts`, `file-watcher.ts`, `llm-client.ts`** — Tests exist only for `ConversationStore`, `QuestionQueue`, and `ContextWindow`. The other modules are untested.

14. **Agent loop max tool-call iteration cap** — ✅ Verified present. `AssistantAgentManager.MAX_AGENT_ITERATIONS = 25` (manager.ts) is enforced at the top of the agent loop; on hitting the cap the loop breaks with a "could not finish within N tool iterations" answer rather than looping unbounded.

15. **`AssistantAgentChatProvider` test coverage** — The 467-line webview panel manager has no spec file.
