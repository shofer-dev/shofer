# RAG Indexer — Worker Thread Isolation

> Design document for moving the in-process code indexer off the main Node.js event loop.

## Problem

The RAG indexer (`extensions/shofer/src/services/code-index/`) runs entirely in the VS Code extension host's Node.js process. During active indexing it competes with the agent task loop for:

| Resource              | Impact                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CPU**               | Tree-sitter parsing + SHA-256 hashing are CPU-bound, blocking the event loop                                                                                            |
| **libuv thread pool** | File I/O (stat, readFile, fsync) share the pool with Shofer's persistence writes. `PARSING_CONCURRENCY=10` concurrent parses can saturate the default pool of 4 threads |
| **Memory**            | WASM-based tree-sitter parsers are memory-heavy; 10 concurrent parse operations can push VS Code's memory usage significantly                                           |
| **Structured clone**  | IPC to webview during heavy scanning competes with agent state pushes                                                                                                   |

This manifests as UI hitches, increased latency, and in extreme cases VS Code crashes (WASM OOM, unhandled promise rejections in retry loops).

## Goal

Run the full indexing pipeline (scanner + parser + embedder + Qdrant upsert + file watcher) in a **dedicated `worker_threads` Worker**, with the worker process launched at a **lower `nice` value**, inside the existing VS Code extension host process — no separate OS-level process, no infrastructure dependency.

## Constraints

1. **Same functionality** — search behavior, cache behavior, incremental indexing must be identical
2. **No architecture split** — the `rag-indexer` Go microservice is out of scope; this is Node.js-only
3. **Nice level** — worker launched via `child_process.spawn` with `nice` prefix OR via `worker_threads` with a separate `Worker` that voluntarily yields CPU via `process.cpuUsage()` checks
4. **Cooperative cancellation** — must honor the existing `AbortSignal` propagation per the Cooperative Cancellation Rule
5. **Backpressure** — the existing `MAX_PENDING_BATCHES=20` backpressure limit must remain effective across the thread boundary

## Design

### Overview

```
┌─────────────────────────────────────────────────────────────┐
│              Extension Host (main thread)                     │
│                                                             │
│  CodeIndexManager                                           │
│    ├── CodeIndexServiceFactory                              │
│    │   └── createServices() ──► WorkerProcessBridge         │
│    │                               │                        │
│    │                               ├── DirectoryScanner     │
│    │                               ├── CodeParser          │
│    │                               ├── FileWatcher         │
│    │                               └── Embedder + Qdrant    │
│    │                                                          │
│    └── CodeIndexSearchService ◄── IPC ── Worker thread      │
│                                                             │
│  Agent Task Loop (unaffected — no CPU/IO contention)        │
└─────────────────────────────────────────────────────────────┘
                           │
                    worker_threads
                           │
┌─────────────────────────────────────────────────────────────┐
│              Indexer Worker (separate thread)               │
│  nice -n 10 (or reniced Worker process)                      │
│                                                             │
│  CodeIndexWorkerEntrypoint                                   │
│    ├── MessagePort-based IPC to main thread                 │
│    ├── DirectoryScanner (same class, imported)             │
│    ├── CodeParser (tree-sitter, same)                        │
│    ├── FileWatcher (same, via parent context)              │
│    ├── Embedder (HTTP calls, same)                          │
│    └── Qdrant client (same)                                 │
└─────────────────────────────────────────────────────────────┘
```

### Key Files to Create/Modify

| File                                         | Change                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/code-index/worker-entry.ts`    | **New** — `Worker` entry point; imports all indexer modules and runs the message-port loop                                                                      |
| `src/services/code-index/worker-bridge.ts`   | **New** — `CodeIndexWorkerBridge` class; owns the `Worker`, proxies all service calls across `postMessage`/`on('message')`                                      |
| `src/services/code-index/manager.ts`         | Replace `createServices()` with `createWorkerBridge()`; `searchIndex()` calls bridge                                                                            |
| `src/services/code-index/service-factory.ts` | Split: embedder/Qdrant/scanner/file-watcher creation moves to worker; factory becomes a thin factory of message-port proxies                                    |
| `src/services/code-index/orchestrator.ts`    | Lives in the worker; main thread only receives state update events                                                                                              |
| `src/extension.ts`                           | Spawn worker via `child_process.spawn('nice', ['-n', '10', 'node', workerScript], {...})` or launch via `new Worker(workerScript, { execArgv: ['--nice=10'] })` |

### IPC Contract

Define a strict request/response protocol over `MessagePort`:

```typescript
type WorkerRequest =
	| { type: "search"; query: string; directoryPrefix?: string; maxResults?: number }
	| { type: "startIndexing" }
	| { type: "stopIndexing" }
	| { type: "clearIndexData" }
	| { type: "fileChanged"; paths: string[] }
	| { type: "dispose" }

type WorkerResponse =
	| { type: "searchResult"; results: VectorStoreSearchResult[] }
	| { type: "stateUpdate"; state: IndexingState; message: string }
	| { type: "progressUpdate"; scanned: number; embedded: number; upserted: number; currentFile?: string }
	| { type: "error"; error: string }
```

### Nice Level Approaches

**Option A — `child_process.spawn` with `nice`:**

```typescript
// In extension.ts or manager.ts
import { spawn } from "child_process"
import path from "path"

const workerScript = path.join(__dirname, "services/code-index/worker-entry.js")
const child = spawn("nice", ["-n", "10", process.execPath, workerScript], {
	stdio: ["ignore", "pipe", "pipe", "ipc"],
	env: { ...process.env, SHOFER_WORKER: "1" },
})
```

**Pros**: True OS-level nice, guaranteed lower CPU scheduling priority from the start.
**Cons**: Separate Node.js process, higher memory overhead than `worker_threads`.

**Option B — `worker_threads` Worker with voluntary yield:**

```typescript
// Worker entry uses process.cpuUsage() to voluntarily yield
// Start the Worker with a custom execArgv flag
const worker = new Worker(workerScript, {
	execArgv: ["--require", "nice-wrapper.js"],
	workerData: { nice: 10 },
})
```

**Pros**: Lower overhead than child process; shares memory pages via copy-on-write.
**Cons**: `nice` inside a Worker thread affects the whole process, not just this thread.

**Option C — `worker_threads` Worker + `os_priority` native addon (reject if unavailable):**

A NAPI addon that calls `setpriority(PRIO_PROCESS, 0, niceValue)` on the Worker thread only. Avoids process-level nice.

**Recommendation**: Option A (`child_process.spawn` with `nice`) for v1 — simplest to implement, most reliable nice behavior, easiest to debug. Switch to Option B/B+C in a follow-up if memory overhead proves significant.

### Search Service Stays in Main Thread

`CodeIndexSearchService.searchIndex()` embeds the query and searches Qdrant. Embedder HTTP calls and Qdrant gRPC are network I/O, not CPU-bound parsing — these stay in the main thread to avoid the structured-clone overhead of returning large result arrays from the worker. Only the **indexing pipeline** (scan → parse → embed → upsert) moves to the worker.

### Error Recovery

The worker is owned by `CodeIndexManager`. On worker exit/crash:

1. `manager.ts` detects via `'exit'` event on the child process
2. Transitions state to `Error`
3. `recoverFromError()` is called (already existing)
4. Worker is respawned, `_recreateServices()` called
5. Incremental scan picks up from cache (same as today's error recovery)

### Metrics to Add

Per the Output Channel Logging Rule, add gated perf logging:

- Worker spawn time
- IPC round-trip latency per call (search, fileChanged)
- CPU time used by worker vs main thread (via `process.cpuUsage()`)
- libuv thread pool queue depth during worker-heavy I/O

## Implementation Order

1. **Worker entry + bridge skeleton** — `worker-entry.ts` + `worker-bridge.ts` with a single hardcoded "pong" response to verify IPC works
2. **Move `DirectoryScanner` to worker** — test that scan results come back correctly
3. **Move embedder + Qdrant calls to worker** — verify batch embedding + upsert in worker
4. **Move file watcher to worker** — `FileWatcher` initialized in worker; `onBatchProgressUpdate` events routed back via MessagePort
5. **Nice level** — add `child_process.spawn` with `nice -n 10`
6. **Error recovery + respawn** — test crash/respawn cycle
7. **Metrics** — CPU usage, IPC latency instrumentation

## What NOT to Move to the Worker

| Component                    | Reason                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `CodeIndexManager` singleton | VS Code extension context ownership; event emitters must be in main thread                      |
| `CodeIndexSearchService`     | Network I/O (embedder + Qdrant queries); stays in main thread to avoid structuredClone overhead |
| `CacheManager`               | Reads/writes VS Code globalStorage — must be in main thread                                     |
| `CodeIndexStateManager`      | `vscode.EventEmitter` — must be in main thread                                                  |
| `CodeIndexConfigManager`     | Reads `ContextProxy` + `SecretStorage` — main thread                                            |

## Risk Assessment

| Risk                                                       | Likelihood | Mitigation                                                                                                       |
| ---------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Worker crash takes down extension host                     | Low        | Monitor child `'exit'`; respawn + recoverFromError                                                               |
| `structuredClone` overhead for large result arrays         | Medium     | Keep search in main thread; only move indexing pipeline                                                          |
| WASM parsers not thread-safe                               | Low        | Tree-sitter web-tree-sitter is thread-safe when each thread has its own parser instance                          |
| `child_process.spawn` not available in VS Code environment | Low        | VS Code ships Node.js; spawn is universally available                                                            |
| File watcher needs VS Code context                         | Medium     | File watcher initialized with `context` from main thread; file system events are process-level, not thread-level |
