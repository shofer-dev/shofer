# Live Memory plugin — dogfood gap report

This plugin reimplements the **core** of Shofer's built-in Live Memory
(`packages/core/src/services/live-memory/*`, `src/services/live-memory/*`,
`AskLiveMemoryTool`, `getLiveMemorySection`) using **only** the public plugin
surface — `ctx.*`, lifecycle hooks, and declarative contributions. It reaches into
**no** `@shofer/core` internals. Its point is to stress the P1–P6 architecture against
a real first-party feature and report where the extension points were sufficient,
where fidelity had to be reduced, and where a genuine gap remains.

The built-in Live Memory is **untouched** — this plugin is built alongside it. For
testing, the built-in effectively stands in as the reference; the plugin is exercised
end-to-end by `packages/core/src/plugins/__tests__/live-memory-plugin.spec.ts`, which
loads it off disk through the real `PluginManager` + esbuild loader with the P6
capabilities wired.

## What the plugin is

| File               | Role                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `plugin.json`      | Manifest: grants `tools`, `systemPrompt`, `lifecycle`, `events`, `ai`, `filesystem:["."]`; `config.profileRef` + tuning. |
| `memory-store.ts`  | Per-workspace JSON memory over **`ctx.storage`** (P6.G2) — the `ConversationStore` analogue. |
| `memory-llm.ts`    | Q&A + summarize over **`ctx.ai.buildHandler`** (P6.G1) — the `LiveMemoryLlmClient` analogue. |
| `system-section.ts`| The live "LIVE MEMORY" prompt block — the `getLiveMemorySection` analogue.  |
| `main.ts`          | The `ShoferPlugin`: wires the tool, the prompt transform, the observers, the service. |

## Mapping: built-in behavior → plugin extension point

### Mapped cleanly (extension point was sufficient)

| Built-in behavior                                  | Plugin extension point                                   | Notes |
| -------------------------------------------------- | -------------------------------------------------------- | ----- |
| `ConversationStore` — workspace-scoped persistence | **`ctx.storage`** (`memory-<hash>.json`, traversal-blocked) | Survives restart; removed on uninstall. Verified by the "writes memory through ctx.storage" test. |
| `LiveMemoryLlmClient` — same `ApiHandler` as agent | **`ctx.ai.buildHandler(profileRef)`**                    | Plugin never sees keys; drains the stream exactly like the reference. |
| `AskLiveMemoryTool` (`ask_live_memory`)            | **`registerTools`** (`permissions.tools`)                | Tool closure captures `ctx.ai`/`ctx.storage` (execute only gets `CustomToolContext`). |
| `getLiveMemorySection` in the system prompt        | **`transformSystemPrompt`** (`permissions.systemPrompt`) | Reads the live store each build → real-time stats, like the built-in. |
| `FileContextTracker._notifyLiveMemory(path)` (Shofer's own edits) | **`lifecycle.afterToolCall`** (`permissions.lifecycle`) | **Strictly more signal** than the built-in — see below. |
| Task lifecycle awareness                           | **`lifecycle.beforeTaskStart` / `afterTaskComplete`** + **`onEvent`** | Task markers + prompt captured. |
| Background maintenance (periodic compaction)       | **`ctx.registerService`** (P6.G7)                        | Supervised interval that summarizes the log via `ctx.ai`. |
| Billed-AI consent gate                             | `permissions.ai` **+** the separate AI-consent (denying stub) | Verified by the "gates ctx.ai on consent" test. |
| Distributable                                      | Packs to **`.shofer-plugin`** (P8), round-trips + re-discovers | Verified by the pack test. |

**The file-edit observation signal — verified sufficient (in fact richer).** The
built-in couples into core: `FileContextTracker._notifyLiveMemory(filePath)` fires
only for `shofer_edited` files and passes only the path. The plugin replaces that with
`afterToolCall(toolName, args, result, ctx)`, which fires for **every** tool with the
tool name, its args (carrying the path), **and** the result string. So the plugin can
observe **both edits and reads**, classify them, and attach a result excerpt — a
superset of the built-in's coupling — **without any core change**. This is the key
validation: the hardcoded `_notifyLiveMemory` coupling is fully replaceable by a public
lifecycle hook.

### Reduced fidelity (works, but a thinner slice than the built-in)

1. **Q&A is single-turn summarize-over-memory, not a tool-using agent loop.** The
   built-in runs a full read-only agent loop (`tool-executor.ts`, `question-queue.ts`):
   the memory agent can itself `read_file`/`search_files` to pull fresh code into its
   context window mid-answer. The plugin answers from the **accumulated observation
   log** in one `ctx.ai` call. This is a deliberate scope reduction — the plugin proves
   the store + LLM + tool + prompt seams end-to-end; giving the memory LLM its own
   read-tools is additive and needs no new capability (it could `ctx.host.fs.readFile`
   under a broadened `permissions.filesystem`). Not a gap, a scope line.

2. **No token-budgeted context window / LRU eviction / cost ledger.** The built-in's
   `context-window.ts` + `pricing.ts` do KV-cache-preserving eviction and USD costing.
   The plugin keeps simple FIFO caps (`maxObservations`/`maxQuestions`) and reports raw
   token counts from the stream. All of this is implementable purely in plugin code —
   omitted for the demonstrable-slice, not blocked by any missing extension point.

3. **The prompt section can't distinguish "granted-not-consented" from "consented".**
   A plugin sees `ctx.ai` as *present* in both the denying-stub and the live case (it
   only differs when called). So `transformSystemPrompt` can't perfectly word the
   consent state without making a billed call. Minor; the tool still fails loudly and
   correctly when unconsented. A read-only `ctx.ai.isConsented`/`ctx.ai.status` flag
   would close this — a small **additive** future nicety, not required for function.

### Genuine gap (needs a capability the plugin surface does not expose)

**External-edit granularity — `ctx.host.watch` drops the changed path.** The built-in
file-watcher (`src/services/live-memory/file-watcher.ts`) knows *which* file changed
externally. The plugin surface's `ctx.host.watch(pattern, onChange: () => void)` fires
with **no argument**, so the plugin can only record a coarse "something changed under
`<glob>`" marker. This is **not** a plugin-API-only gap I should paper over: the path is
discarded one layer deeper, at the **core host seam** —
`HostFileWatcher.on{Create,Change,Delete}(handler: () => void)` in
`packages/types/src/host.ts` maps to `vscode.FileSystemWatcher`, whose events *do*
carry a `vscode.Uri`, but the seam throws it away. Threading the path to plugins
therefore requires a **core host-seam change** (`HostFileWatcher` callbacks →
`(path: string) => void`, its VS Code + in-memory adapters, its existing core callers,
then `PluginHost.watch`'s callback), not the "small additive plugin capability" the
brief scopes. I deliberately did **not** make that broader change; I recorded it here as
the one item for the owner / Phase 7:

> **Missing extension point (for Phase 7):** a path-carrying file-watch. Widen
> `HostFileWatcher` to deliver the changed path, then surface it on
> `PluginHost.watch(pattern, onChange: (path: string) => void)`. Until then,
> plugin-observed external edits are coarse-grained.

## New plugin-API capability added

**None.** Every signal the *core* slice needs was reachable through an existing
extension point — the primary validation result. The one real gap (external-edit path)
is a core host-seam change, not a plugin-API addition, and is left as an owner decision
so this dogfood stays strictly non-breaking (no `PluginEvent`/hook-field/`@shofer/types`
change was made).

## Deferred

- **UI (`sidebar-panel`).** Deferred. PLUGINS.md §6 notes third-party UI-bundle loading
  isn't wired yet (only first-party/co-bundled components mount). A memory-stats panel is
  a clean follow-up once that lands; the data it would render is already in `ctx.storage`.

## Owner decisions needed

1. **Path-carrying file-watch** (the genuine gap above) — worth it for Phase 7?
2. **`ctx.ai` consent introspection** (reduced-fidelity #3) — add a read-only
   consent/status flag so prompt copy can reflect it without a billed call?
3. Whether to grow this slice toward full parity (agent-loop Q&A, context-window/cost
   ledger) as the migration path to *replace* the built-in — all achievable in plugin
   code with **no** further host capability.
