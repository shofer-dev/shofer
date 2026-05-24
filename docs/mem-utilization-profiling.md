# Extension-Host Memory Utilisation & Profiling

This document explains why the Shofer extension host occasionally OOMs the
underlying Node/V8 process, where the transient memory bloat most plausibly
originates, what design changes would address each suspect, and how to
profile the running extension host to confirm or refute each hypothesis.

It is a debugging playbook, not a refactor proposal. It does not change any
code; it lists the changes that would. Pick from the menu based on what the
profiling data points at — do not implement everything upfront.

---

## Table of Contents

1. [Symptom & Diagnosis](#1-symptom--diagnosis)
2. [Why It's `large_object` Space](#2-why-its-large_object-space)
3. [Plausible Culprits](#3-plausible-culprits)
4. [Design Changes by Culprit](#4-design-changes-by-culprit)
5. [Profiling Toolbox](#5-profiling-toolbox)
6. [Recommended Investigation Sequence](#6-recommended-investigation-sequence)
7. [Known Constraints](#7-known-constraints)
8. [Related Files](#8-related-files)

---

## 1. Symptom & Diagnosis

Observed in the Grafana memory dashboard (Node.js extension host):

- Steady-state heap: ~256 MiB.
- Recurring **spikes** to 1–2 GiB that recover to baseline within seconds.
- On the failing occasion, a spike climbed to ~2.5 GiB, V8 logged
  `last resort … GC in old space requested`, then:
    ```
    OOM error in V8: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
    log.ts:117  INFO Extension host (LocalProcess pid: 477566) is unresponsive.
    ```
- Heap-space breakdown at the time of the snapshot showed `large_object`
  dominating the spike component (~273 MiB at sample time, much higher at
  peaks), while `old` and `new` spaces stayed flat.

**Conclusion:** this is not a leak. It is one-or-few very large transient
allocations whose lifetime briefly overlaps and pushes V8 past its limit. The
fact that recovery happens between spikes proves the retainers are released
under normal circumstances.

---

## 2. Why It's `large_object` Space

V8 allocates objects larger than a page (~512 KiB on 64-bit, configurable per
build) directly into the `large_object` space. Anything in this space
implies a single contiguous allocation of at least half a megabyte. The
realistic shapes that land there in a Node.js extension host:

- Large `String` (concatenation result, `JSON.stringify` output, large
  template literal, base64 of a binary file).
- Large `Buffer` / `Uint8Array` / `ArrayBuffer` (file reads, fetched response
  bodies, image data, embeddings as `Float32Array`).
- Large pre-sized `Array` (rare in user code; common in serialisation
  libraries).
- WASM heap copies (tree-sitter, encryption libs, native deps).

We are therefore looking for code paths that produce a **single very big
object** and then drop it. Many small allocations cannot produce this
signature regardless of count.

A worst-case interaction pattern multiplies the peak: if a single piece of
data (e.g. a long conversation history) is **simultaneously**
(a) serialised to disk, (b) sent to the LLM provider as a request body, and
(c) posted to the webview as part of state, the same logical bytes can exist
3–4× in `large_object` for the few hundred milliseconds the operations
overlap. That alone can take a healthy ~600 MiB working set into OOM
territory.

---

## 3. Plausible Culprits

Ranked by typical peak size in a Shofer extension host. The ranking should be
treated as a starting search order, not a verdict — profiling is what
identifies the actual culprit.

### 3.1 Conversation history serialisation

`Task.saveApiConversationHistory()` and `Task.saveShoferMessages()` in
[`src/core/task/Task.ts`](../src/core/task/Task.ts) call `JSON.stringify` on
the whole array of messages before writing to disk. For a long task with
many tool outputs (full file contents, browser-tool HTML dumps, MCP
responses), the array can serialise to 50–500 MiB. During `JSON.stringify`
V8 holds the input graph plus the output string simultaneously, so the
on-heap peak is at least 2× the on-disk size.

Co-located writers via [`src/utils/safeWriteJson.ts`](../src/utils/safeWriteJson.ts)
inherit the same peak.

### 3.2 `postStateToWebview`

[`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)
`postStateToWebview()` and its `*WithoutTaskHistory` /
`*WithoutShoferMessages` variants (see the corresponding metrics in
[`src/metrics/registry.ts`](../src/metrics/registry.ts)) ship a state object
containing the same conversation arrays. VS Code structured-clones the
payload across the IPC boundary, so for a few ms the host holds the source
object plus the serialised clone. A debounced burst of these (e.g. during
streaming) compounds with §3.1 because both touch the same data.

### 3.3 LLM request-body assembly

The Anthropic / OpenAI / Gemini SDKs serialise the entire `messages` array
on every `chat.completions.create()` / `messages.create()` call — there is
no streaming-in counterpart. For a 200K-token context with inline tool
results, a single send is commonly 20–80 MiB. The SDK keeps the raw bytes
on the heap until the request resolves.

If any provider implementation under [`src/api/providers/`](../src/api/providers/)
does its own `JSON.stringify(messages)` before handing to the SDK, the peak
doubles.

### 3.4 LLM streaming-response accumulation

If anywhere we build the full response text via `accumulated += chunk` (or
equivalent), that is an O(n²) string grower: each `+=` allocates a new
backing buffer of the new total length and copies, so the moment-of-peak is
twice the final size. Grep targets: `accumulated`, `+=`, `concat`, anywhere
inside provider streaming loops.

### 3.5 `read_file` and `@file` mention expansion

A single `read_file` of a multi-MB file (`package-lock.json`, generated
code, log dump, PDF text, image-as-base64) materialises the full string in
one allocation. Base64 inflates 4/3; a 20 MiB image becomes a ~27 MiB
string. Several stacked reads in one tool turn compound.

### 3.6 Code-index / RAG batch processing

Workers under [`src/services/code-index/processors/`](../src/services/code-index/processors/)
read and embed files in batches. If a batch holds the full file contents
_and_ their Float32 embedding vectors at once, this can be hundreds of MiB
on a large repository. The retainer here is the batch container array, not
any individual file.

### 3.7 Tree-sitter parsing

The source string itself, plus internal WASM heap allocations for the AST.
Each top-level parse of a very large file briefly pins the source string in
`large_object`.

### 3.8 Helper-agent context window assembly

[`src/services/helper-agent/context-window.ts`](../src/services/helper-agent/context-window.ts)
concatenates many message bodies into a single prompt string before the
helper LLM call. Same shape as §3.1, but bounded by the helper model
context window.

### 3.9 Terminal output buffering

Long-running command output (`npm install`, `cargo build`, `pytest -v`)
flooding stdout into an in-memory buffer.

### 3.10 Misbehaving MCP tool responses

An MCP server returning a huge payload (e.g. a tool that dumps an entire
webpage) — Shofer has no application-level cap on incoming MCP-tool
results.

---

## 4. Design Changes by Culprit

Apply **only** the entries whose culprit profiling has confirmed. Each item
is an independent change with a self-contained mitigation.

### 4.1 Streaming JSON write for conversation snapshots

Replace `JSON.stringify(messages)` + `fs.writeFile` with an
**append-only / streaming** persistence layer:

- Persist as JSONL (one message per line). New messages append; full
  rewrites only on rare compactions (e.g. truncation, mode change). This
  caps the serialisation peak at "one message" rather than "whole history".
- Where a single-file format is required, use a streaming serialiser
  (`stream-json` or a hand-rolled writer that emits `[`, each element with
  a trailing comma, `]`) so the host never materialises the whole string.

Knock-on: load-path becomes a line-by-line reader; existing snapshot
schemas/migrations need an adapter — but per the **No Backward Compatibility
Unless Asked** rule in the repo conventions, the migration can be one-shot
on first load.

### 4.2 Webview state diffs instead of full snapshots

`postStateToWebview` already has skinnier variants
(`postStateToWebviewWithoutTaskHistory`,
`postStateToWebviewWithoutShoferMessages`). The next step is to ship
**incremental updates** for the large arrays (`apiConversationHistory`,
`shoferMessages`, `taskHistory`) instead of the full array on every change.

A minimal incremental protocol:

- `messageAppended { taskId, message }`
- `messageUpdated { taskId, index, patch }`
- `messageReplaced { taskId, index, message }`
- `fullSync { taskId, messages }` — only on initial load or after a webview
  reload.

The webview already retains state across host pushes, so applying patches
is a small `useReducer` reducer per array.

This eliminates the §3.2 peak entirely except on full-sync, and on full-sync
collapses into §4.1's append-only file read.

### 4.3 Inline-content caps and externalisation

Inside tool results that get embedded in the conversation history, cap the
inline portion and externalise the rest:

- **Per-tool-result cap** (e.g. 64 KiB) on the inline text persisted in
  `shoferMessages` / `apiConversationHistory`. Beyond the cap, write the
  full content to `.shofer/blobs/<sha256>.txt` and embed a reference token
  `<shofer-blob sha256="…" bytes="…"/>`.
- The UI resolves blob refs on demand; the LLM call expands them only when
  the message is part of the outgoing context window, and even then the
  truncation policy in [`src/core/sliding-window/`](../src/core/sliding-window/)
  may already drop them.

This addresses §3.1, §3.3, §3.5, §3.7, and §3.10 in one stroke because they
all become a constant-size reference plus a content-addressable file.

### 4.4 LLM request-body streaming where supported

For providers whose SDK supports it, hand the request body in as an
`AsyncIterable<Uint8Array>` rather than a fully-materialised JSON. Where the
SDK only accepts a JS object, do the serialisation lazily via a wrapping
`Readable` and let undici stream it out. This addresses §3.3.

### 4.5 Eliminate `+=` accumulation in streaming providers

Audit every provider in [`src/api/providers/`](../src/api/providers/) for
`accumulated += chunk` and equivalent patterns; replace with `chunks.push`
and a single `chunks.join("")` at the end (one allocation, no quadratic
growth). Even better, yield each chunk to the consumer instead of
re-emitting the full text, and have the consumer maintain its own
incremental buffer. Addresses §3.4.

### 4.6 Bounded batches in the code indexer

Cap the in-flight bytes (not just file count) in the batch loop under
[`src/services/code-index/processors/`](../src/services/code-index/processors/).
A simple `currentBatchBytes += fileSize; if (currentBatchBytes > LIMIT)
flushBatch()` keeps the peak deterministic regardless of repository shape.
Addresses §3.6.

### 4.7 Cap MCP tool response sizes

In the MCP client adapter, truncate responses larger than a configured
threshold (default e.g. 1 MiB) and surface a warning to the agent. Addresses
§3.10 and protects against a single malicious/buggy MCP server.

### 4.8 Cap terminal output retained in memory

In the terminal capture layer, switch the in-memory ring buffer to a fixed
byte cap with overflow spilled to a temp file that the LLM can be pointed
at via a tool. Addresses §3.9.

### 4.9 Defer `JSON.stringify`-style cost in logs

Any `outputChannel.appendLine(JSON.stringify(largeObject))` in hot paths is
itself a `large_object` allocation. Audit logger call sites for accidental
full-stringify of conversation/state objects; replace with size summaries
(`messages.length`, `Buffer.byteLength(JSON.stringify(x))` only when above
a threshold).

---

## 5. Profiling Toolbox

The order here is the order of bang-for-buck. The first three usually
suffice.

### 5.1 `--heapsnapshot-near-heap-limit=N` (most surgical)

V8 dumps a `.heapsnapshot` automatically the last `N` times it is about to
OOM. Set `N=3` to catch the last three near-misses including the fatal one.

VS Code intentionally strips `NODE_OPTIONS` from the extension-host process
(see [§7](#7-known-constraints)), so this flag cannot be passed via env.
It must be:

- passed to the workbench/extension-host launcher (code-server-side patch),
  **or**
- threaded through whatever launches the host in our packaging
  ([`build-code-server.sh`](../../../build-code-server.sh)).

Once enabled, snapshots land in the extension-host process's cwd. Open in
Chrome DevTools → **Memory** → **Load** → switch to "Statistics" view to
confirm `large_object` is the dominant space, then "Containment" view to
find the dominator object that retained the memory. The dominator is the
culprit's root.

### 5.2 On-demand `shofer.heapSnapshot` command (already implemented)

The repo already registers `shofer.heapSnapshot` in
[`src/activate/registerCommands.ts`](../src/activate/registerCommands.ts);
it calls `v8.writeHeapSnapshot()` and writes to
`.shofer/heap-snapshots/heap-<timestamp>.heapsnapshot`. Use this to capture
a baseline at task start and a peak snapshot mid-task, then diff in
DevTools (`Comparison` view) to find what was newly retained.

### 5.3 Automatic snapshot on watermark

Add a small singleton that polls `process.memoryUsage().heapUsed` every 5 s
and, when it crosses a threshold (e.g. 1.5 GiB), calls `v8.writeHeapSnapshot`
**once per host session** (rate-limit; snapshots themselves cost ~100 MiB to
produce and we don't want a feedback loop). Log the path to the output
channel so the user can attach it to a bug report.

This is the cheapest way to capture the bad spike in the field, where
reproducing it under a debugger is impractical.

### 5.4 Per-suspect size logs

Five surgical instrumentation points covering the §3 suspects:

| Where                                                           | What to log                                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Just before each LLM send                                       | `messages.length` and serialised byte size (only when above 1 MiB to avoid the O(n) cost in steady state) |
| Inside `Task.saveApiConversationHistory` / `saveShoferMessages` | Serialised byte length being written                                                                      |
| Inside `read_file` / `@file` mention expansion                  | Bytes read per call                                                                                       |
| Inside the code-index batch loop                                | Pending-bytes total at flush time                                                                         |
| Inside `postStateToWebview*`                                    | Serialised state byte size (only above a threshold)                                                       |

These correlate spikes from the Grafana board with concrete code paths
without needing a debugger attach.

### 5.5 `--inspect-extensions=9229` + DevTools Allocation Sampling

For transient spikes that resist reproduction:

1. Launch the extension host with `--inspect-extensions=9229`.
2. In Chrome, open `chrome://inspect`, attach to the host.
3. **Memory** tab → "Allocation sampling" → Start.
4. Reproduce the workload (long task, large file read, big repo index).
5. Stop. The aggregated view shows allocations grouped by source location,
   weighted by retained bytes.

Requires the extension-host bundle to ship **source maps**; the production
minified bundle otherwise shows `t.e.r()` symbols and the report is
unreadable. Ensure the build under [`src/dist/`](../src/dist/) includes
sourcemaps when profiling.

### 5.6 `v8.getHeapSpaceStatistics()` in the metrics exporter

The Grafana board already breaks down by space, so this is presumably
wired. If not, add a periodic poll in the metrics layer and emit one
gauge per space (`new`, `old`, `large_object`, `code`, `map`, …). The
breakdown is what reveals "single big allocations" (large_object spike)
vs. "lots of medium allocations" (old space spike) and changes the search
radically.

### 5.7 Allocation profiling via V8 Inspector

`require("v8").inspector` and the V8 Inspector protocol's
`HeapProfiler.startSampling` give the same data as §5.5 without needing a
GUI; the result is a JSON profile loadable into DevTools. Useful for
long-running headless capture (CI, long sessions).

---

## 6. Recommended Investigation Sequence

1. **Land §5.3 (watermark auto-snapshot).** ~30 lines. Captures the next
   crash without needing the user to do anything.
2. **Confirm via §5.6 that `large_object` is the dominant space at the
   spike.** If it is not, the analysis in §2 changes — old-space dominance
   would point at a genuine leak instead.
3. **Open the captured snapshot.** Identify the dominator object and the
   retainer path.
4. **Map the retainer path to one of §3's culprits** (usually obvious from
   the class/string names).
5. **Apply the matching §4 design change** — only the one, not all of them.
   Each one of §4.1, §4.2, §4.3 is a substantial design change in its own
   right; do not do them speculatively.
6. **Re-measure** with the same auto-snapshot infrastructure. The spike's
   peak should drop visibly in the Grafana board.

---

## 7. Known Constraints

- **VS Code strips `NODE_OPTIONS` from the extension host.** This is visible
  in [`code-server/lib/vscode/src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts`](../../../code-server/lib/vscode/src/vs/platform/agentHost/electron-main/electronAgentHostStarter.ts)
  and in the related Copilot-agent file. The workspace's
  `NODE_OPTIONS="--max-old-space-size=16384"` in
  [`build-code-server.sh`](../../../build-code-server.sh) therefore does **not**
  reach the extension host, which runs at V8's default
  (~1.5–2 GiB) — exactly the ceiling we are hitting. Raising the limit (or
  enabling `--heapsnapshot-near-heap-limit`) requires a patch to the
  code-server launcher path, not an env-var change.

- **Raising the heap limit is treatment, not cure.** It postpones OOM but
  does not address the underlying transient-bloat pattern. Useful as a
  safety net while §4 changes land, not as a permanent fix.

- **Source maps for the production extension-host bundle.** The current
  build is minified; any heap snapshot or allocation sample taken against a
  production install will be partially unreadable. Profiling work should be
  done against a build that ships sourcemaps, or with source maps available
  alongside via a separate `.map` upload.

- **Snapshots are expensive.** A `v8.writeHeapSnapshot()` call on a 2 GiB
  heap takes seconds and stalls the event loop. Watermark-triggered
  snapshots must be rate-limited (once per session) and ideally are
  off-by-default in production behind a `shofer.diagnostics.autoHeapDump`
  setting.

---

## 8. Related Files

| File                                                                                            | Role                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`src/core/task/Task.ts`](../src/core/task/Task.ts)                                             | `saveApiConversationHistory`, `saveShoferMessages` — the §3.1 culprits |
| [`src/utils/safeWriteJson.ts`](../src/utils/safeWriteJson.ts)                                   | Shared JSON write path used by the persistence layer                   |
| [`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                   | `postStateToWebview` and skinnier variants — the §3.2 culprit          |
| [`src/api/providers/`](../src/api/providers/)                                                   | LLM provider implementations — §3.3, §3.4                              |
| [`src/services/code-index/processors/`](../src/services/code-index/processors/)                 | Batch readers / embedders — §3.6                                       |
| [`src/services/helper-agent/context-window.ts`](../src/services/helper-agent/context-window.ts) | Helper-agent prompt assembly — §3.8                                    |
| [`src/activate/registerCommands.ts`](../src/activate/registerCommands.ts)                       | `shofer.heapSnapshot` command (§5.2)                                   |
| [`src/metrics/registry.ts`](../src/metrics/registry.ts)                                         | Histograms for `saveShoferMessages` and `postStateToWebview*`          |
| [`build-code-server.sh`](../../../build-code-server.sh)                                         | Where the (currently-stripped) `NODE_OPTIONS` is set — see §7          |
