# Shofer v3 Architecture

> **Status:** active. This is the canonical description of Shofer's v3 architecture
> — the host-agnostic agent core and the front-end boundary around it. It replaces
> the earlier evolution roadmap. Progress against the initiatives below is tracked
> in [`../todos/v3_architecture_progress.md`](../todos/v3_architecture_progress.md).

## What this document is

Shofer's v3 architecture separates a **portable agent core** (the "brain" — task
loop, tools, prompts, model dispatch, context management) from the **front-end**
that hosts it (today the VS Code extension; tomorrow a CLI, a headless server, or an
editor-agnostic agent backend). The core is written against narrow, host-agnostic
interfaces and never imports any front-end SDK. Each front-end provides concrete
implementations of those interfaces.

Two governing principles:

1. **Strangler migration, not parallel rewrite.** Every change lands behind an
   interface/adapter and keeps Shofer shippable at each step. We lock a contract,
   migrate call sites onto it, then delete the old path. There is never a second,
   half-finished copy of a subsystem.
2. **The core is host-agnostic.** The core depends only on **Category I** host
   interfaces (below). Anything platform-specific — VS Code, a terminal UI, a diff
   viewer, an IDE's language server — lives in **Category II** front-end adapters
   behind those interfaces.

---

## The host boundary: Category I vs Category II

This is the central seam of the architecture.

### Category I — Host APIs (host-agnostic contracts)

Category I is the small set of capabilities the portable core needs from _whatever_
is hosting it, expressed as plain TypeScript interfaces with no platform types in
their signatures. They live in the **`@shofer/types`** package (vscode-free) and are
aggregated into one `HostBridge` object:

| Capability        | Interface                | What the core uses it for                                      |
| ----------------- | ------------------------ | -------------------------------------------------------------- |
| Notifications     | `Notifier`               | info/warn/error messages + choice dialogs (`showChoice`)       |
| Filesystem        | `HostFileSystem`         | read/write/exists/mkdir/delete + `findFiles` (glob)            |
| Configuration     | `HostConfig`             | `get<T>(section, key, default)` settings reads                 |
| Environment       | `HostEnv`                | UI `language`, app `appRoot` (to locate bundled binaries)      |
| Language services | `HostLsp`                | diagnostics, references, workspace symbols, rename (DTO-based) |
| Workspace actions | `HostWorkspace`          | open a folder, execute a (provider-contributed) command        |
| File watching     | `HostWatcher`            | watch a glob; create/change/delete callbacks                   |
| Message storage   | `MessagePersistencePort` | durable api/UI message persistence (SQLite-backed)             |

Category I interfaces are **DTO-based**: they pass plain data (paths as strings,
positions as `{line, column}` numbers, edits as `{startLine, …, newText}`), never
platform objects. That is what makes them implementable by any front-end and what
keeps the core's type graph free of platform SDKs.

The core reaches Category I through a single registry, also in `@shofer/types`:

```ts
import { getHost } from "@shofer/types"
getHost().notifier.warn("…")
getHost().lsp.getDiagnostics()
```

`getHost()` returns the active `HostBridge`. It defaults to an in-memory
implementation (so the core runs in tests and before a front-end is installed). A
front-end calls `setHost(myAdapter)` exactly once at startup.

### Category II — Front-end adapters (platform implementations)

Category II is the concrete implementation of Category I for a specific front-end,
**plus** the platform-only surface that has no portable equivalent (rich editor UI,
diff views, terminals, a platform's own language-model API). Category II is the
_only_ place a platform SDK is imported.

**Category II is reimplementable per front-end.** The same core runs unchanged on
any of:

- **VS Code extension** (the current front-end) — `src/host/host-bridge.ts`
  implements every Category I interface against the `vscode` API, and `integrations/*`
  provides the rich UI (decorations, diff view, terminal, theme). Installed via
  `setHost(createVsCodeHost())` at activation.
- **CLI** — a terminal front-end would implement `Notifier` as stdout prompts,
  `HostFileSystem.findFiles` via a node glob, `HostLsp` as no-ops or a standalone
  language server, `HostWatcher` via `chokidar`, and apply edits directly to disk
  instead of through a diff viewer. It installs its own adapter with `setHost(...)`.
- **Headless server / agent backend** — implements the subset it needs and no-ops
  the rest (e.g. dialogs auto-resolve, watchers are inert). This is what lets Shofer
  act as an editor-agnostic agent backend (see _HTTP API/SDK_ and _ACP_ below).

The in-memory reference implementation (`createInMemoryHost`, in `@shofer/types`)
documents the minimum a Category II adapter must provide and backs tests.

### The picture

```
        ┌──────────────────────────────────────────────┐
        │              Portable agent core              │
        │  Task loop · tools · prompts · model dispatch │
        │  context mgmt · ignore rules · assistant-msg  │
        │            (zero platform imports)            │
        └───────────────────────┬──────────────────────┘
                                │ depends only on
                                ▼
        ┌──────────────────────────────────────────────┐
        │   Category I — Host APIs  (@shofer/types)     │
        │  Notifier · HostFileSystem · HostConfig ·     │
        │  HostEnv · HostLsp · HostWorkspace ·          │
        │  HostWatcher · MessagePersistencePort         │
        │      getHost() / setHost() registry           │
        └───────────────────────▲──────────────────────┘
                                │ implemented by (one per front-end)
        ┌───────────────────────┴──────────────────────┐
        │      Category II — Front-end adapters         │
        │  VS Code (host-bridge.ts + integrations/* +   │
        │  vscode-lm provider)  ·  CLI  ·  headless /   │
        │  ACP server                                   │
        └──────────────────────────────────────────────┘
```

The core points _down_ at Category I; front-ends point _up_, implementing it. The
core never references Category II.

### Where the line is drawn

A file belongs in the portable core only if it can be written with zero platform
imports. Three kinds of code legitimately stay in Category II and are **not**
abstracted away (doing so would just recreate the platform API as an interface):

1. **Front-end UI** — editor decorations, the diff view, terminals, dialogs, theme
   (`integrations/*`). This is the adapter's job by definition.
2. **Platform-bound configuration** — objects handed a platform context
   (e.g. a `vscode.ExtensionContext`) are inherently front-end-scoped.
3. **A platform's own model API** — e.g. the VS Code Language Model provider is the
   VS Code LM API; it is one _provider_ among many, available only on that front-end.

---

## The portable core today

The following run with no runtime platform import, reaching the host only through
Category I:

- **`Task`** — the agent task loop (the core's heart).
- **All tool implementations** — file ops, search (`find_files`, `grep`,
  `rag_search`, `lsp_search`), language-service tools (`get_errors`,
  `list_code_usages`, `rename_symbol`), `read_project_structure`, `generate_image`,
  `execute_command`, `attempt_completion`, `new_task`, `create_new_workspace`, … .
- **Prompts** — system prompt assembly, mode sections.
- **Assistant-message dispatch** (`presentAssistantMessage`) and the native
  tool-call parser.
- **Context tracking**, the **ignore controller**, and the model-dispatch core.

Persistence (Category I `MessagePersistencePort`) is SQLite-backed via Node's
built-in `node:sqlite` — no flat files, no native dependency.

---

## Architectural initiatives (status)

The v3 architecture is delivered as a set of initiatives. Current status:

| #   | Initiative                                                                                     | Status                                        |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Strangler discipline + maturity hygiene                                                        | ✅ governing practice                         |
| 2   | Schema-as-contract for tools (one Zod schema → OpenAI def + arg type, golden-snapshot guarded) | ✅ all tools migrated                         |
| 3   | One permission engine (tool access / categories / per-model prefs / auto-approval unified)     | ✅                                            |
| 4   | Durable, incremental persistence (SQLite, retire flat files)                                   | ✅                                            |
| 5   | Structured cancellation (process-tree teardown, partial-message reconciliation)                | ✅                                            |
| 6   | Data-driven model/provider catalog (one place to add a model)                                  | ✅                                            |
| 7   | Standards-based observability (OpenTelemetry) + honest cost/limits; no bespoke metrics server  | ✅                                            |
| 8   | **Host-agnostic core (Category I/II split)** — this document                                   | ✅ substantially; package carve-out remaining |
| 9   | Typed plugin API (hooks: tools, prompt transform, events)                                      | ✅ foundation wired                           |
| 10  | HTTP API + SDK + headless parity                                                               | 🚧 foundation (server + agent adapter)        |
| 11  | Editor-agnostic agent protocol (ACP) backend                                                   | 🚧 protocol mapping                           |

(Initiative numbers here are local to this document.)

---

## Remaining work

### Carve out the `@shofer/core` package

The host registry now lives in `@shofer/types`, so the core's `getHost()` no longer
pulls in any Category II adapter. The next structural step is to physically extract
the portable core into a `@shofer/core` package, drawing the module boundary so that:

- `@shofer/core` depends on `@shofer/types` (Category I) and standard Node APIs only.
- Category II (`src/host/host-bridge.ts`, `integrations/*`, the VS Code LM provider,
  platform-context config managers) stays in the extension package and installs
  itself via `setHost`.

This package boundary is what lets initiatives 10 (HTTP API/SDK) and 11 (ACP) run the
core headless — a non-VS-Code front-end simply links `@shofer/core` and supplies its
own Category II adapter.

### Front-end adapters beyond VS Code

A **CLI** front-end is the first target: it links the core, implements the Category I
interfaces for a terminal (glob-based `findFiles`, `chokidar` watching, stdout
notifications, direct-to-disk edits, no-op or standalone language services), and
gets the full agent loop without any VS Code dependency.

---

## What we deliberately keep (Shofer strengths)

The v3 split preserves the things that make Shofer strong and that a generic
agent-backend design tends to lose:

- **Rich, typed tool catalog** with golden-snapshot contracts.
- **Spend caps and honest cost/limit accounting** driven by the model catalog.
- **Per-model tool customization** and a unified permission engine.
- **First-class editor integration** (the Category II VS Code adapter) — abstracting
  the core does not flatten the IDE experience; it just makes the IDE one front-end
  among several.
