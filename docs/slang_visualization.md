# Slang Visualization Design

Reference for the `.slang` file visualization system in Shofer. Covers the current architecture, the rendering pipeline, and known gaps with planned improvements.

> **Related documents**
>
> - [`slang_specs.md`](slang_specs.md) — the Slang language specification
> - [`workflow_design.md`](workflow_design.md) — Workflow abstraction and Slang → Shofer mapping

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Component Diagram](#component-diagram)
3. [Rendering Pipeline](#rendering-pipeline)
4. [Three View Modes](#three-view-modes)
5. [Data-Flow Diagram](#data-flow-diagram)
6. [CSS Theming](#css-theming)
7. [Key Files](#key-files)
8. [Current Capabilities](#current-capabilities)
9. [Gaps & Planned Improvements](#gaps--planned-improvements)

---

## Architecture Overview

The visualization system renders `.slang` files as interactive diagrams inside a **VS Code custom editor**. When a `.slang` file is opened (double-click in Explorer, click in tab), VS Code delegates to a [`CustomTextEditorProvider`](https://code.visualstudio.com/api/extension-guides/custom-editors) registered in `package.json`.

The editor generates an HTML page with inline SVG and CSS — there is **no webview-ui build step**, no React. Graph layout is delegated to **dagre** (v0.8.5, ~280KB) loaded as an external script via webview URI. The render engine script ([`slang-render.js`](../src/core/webview/slang-render.js)) is **also** loaded as an external `<script src="…">` (same webview-URI pattern as dagre); only the initial JSON payload is inlined into a `<script nonce="…">` block. Everything runs in a sandboxed webview with a Content Security Policy (CSP) nonce.

On the **initial** open, the full HTML shell is built once. On **subsequent document edits** the provider does **not** rebuild the HTML — it `postMessage`s a new `{ type: "render", … }` payload to the live webview, and the in-page listener patches the SVG in place, preserving the user's active view, zoom, and drag positions. A full HTML rebuild only happens when the edited file has parse errors (the error page differs). Document-change handling is debounced (`RENDER_DEBOUNCE_MS = 250`) to coalesce keystroke bursts.

A single provider exists (an earlier side-panel provider for `.dtvis` files was removed):

| Provider              | File                                                                   | Role                                                   | Status     |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ | ---------- |
| `SlangEditorProvider` | [`SlangEditorProvider.ts`](../src/core/webview/SlangEditorProvider.ts) | Custom editor for `.slang` files (opens as editor tab) | ✅ Primary |

## Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  VS Code Extension Host                                       │
│                                                               │
│  extension.ts                                                 │
│  ├── SlangEditorProvider.register()                           │
│  │   └── resolveCustomTextEditor(document, webviewPanel)      │
│  │       ├── parseSlang(source) → AST                         │
│  │       ├── validateSlangAST(ast) → diagnostics              │
│  │       ├── buildCsp + makeNonce + generate HTML              │
│  │       └── webviewPanel.webview.html = inlineHtml           │
│  │                                                             │
│  │   onDidChangeTextDocument (debounced 250ms)                 │
│  │     → postMessage(payload)  [full rebuild only on errors]   │
│  │                                                             │

│                                                               │
│  esbuild.mjs: copyPaths hook copies slang-render.{js,css}     │
│  from src/core/webview/ and dagre.min.js from                 │
│  node_modules/dagre/dist/ → dist/ at build time.              │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Webview (sandboxed, CSP-nonce)                               │
│                                                               │
│  HTML payload: { type: "render", fileName, flow, diags }      │
│                                                               │
│  slang-render.css (457 lines)  ─  VSCode CSS variables        │
│  slang-render.js (1735 lines, dagre-backed) ─  Three view compilers      │
│                                                               │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────────────────┐ │
│  │  Topology   │ │  Sequence   │ │  Agent Logic Flow        │ │
│  │  Network    │ │  Timeline   │ │  (Swimlanes)             │ │
│  │  (default)  │ │             │ │                          │ │
│  └─────────────┘ └─────────────┘ └──────────────────────────┘ │
│                                                               │
│  ── Diagnostics panel (parse/validation errors) ──            │
└──────────────────────────────────────────────────────────────┘
```

## Rendering Pipeline

1. **Parse** — `parseSlang(source)` from [`slang-parser.ts`](../src/core/workflow/slang-parser.ts) converts `.slang` text to AST
2. **Validate** — `validateSlangAST(ast)` from [`slang-resolver.ts`](../src/core/workflow/slang-resolver.ts) produces static analysis warnings
3. **Strip spans** — `stripSpans(flow)` removes AST source-span metadata before serialization
4. **Serialize** — AST is JSON-stringified with `<`, `>`, `&` escaped as `\u003c`, `\u003e`, `\u0026`
5. **Embed** — CSS is inlined into a `<style>` block; dagre and `slang-render.js` are referenced as external `<script src="…">` (webview URIs); only the JSON payload is inlined into a `<script nonce="...">` block
6. **Render** — `safeRender(__payload)` calls `handleRender(payload)` which dispatches to the appropriate view compiler. On later edits, the provider `postMessage`s the new payload; a `window.addEventListener("message", …)` listener in `slang-render.js` re-invokes `safeRender(msg)`, preserving `_currentView`/zoom/drag

## Three View Modes

The user switches between views via tab buttons rendered by the JS. The active view is tracked in `_currentView` (a module-level variable). It persists across **in-webview tab switches** and across **document-change re-renders** — a well-formed edit arrives as a `postMessage` payload that patches the live SVG, so the script is never reloaded and `_currentView` (plus zoom/pan and drag positions) survives. The only event that resets `_currentView` to `"topology"` is a full HTML rebuild, which now happens only on the initial open or when the edited file has parse errors.

### 1. Topology Network

The **default view** — a directed graph showing agent relationships and data routing.

| Feature           | Implementation                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| **Nodes**         | Agent cards (name + mode badge + role) rendered as SVG `<g>` groups                                     |
| **Edges**         | `stake → @Recipient` as orange arrows, `await ← @Source` as purple arrows, `peer` as dashed cyan arrows |
| **Layout**        | dagre layered layout (LR rankdir) from sources (agents with no incoming edges)                          |
| **Drag**          | `mousedown`/`mousemove`/`mouseup` handlers on `.node-group` elements                                    |
| **Edge updates**  | `updateConnectedEdges()` redispatches `edgePathData()` with current `_layout` coordinates               |
| **Edge labels**   | Text at bezier midpoints with background rects, repositioned during drag                                |
| **Arrow markers** | SVG `<marker>` defs (`ah-stake`, `ah-await`, `ah-peer`) with distinct colors                            |
| **Multi-edges**   | Parallel edges between same agent pair get vertical offset                                              |
| **Back-edges**    | Reversed or same-layer edges arc above nodes instead of through them                                    |
| **Peer edges**    | Dashed cyan arrows sourced from `agent.meta.peers` — represents `send_message_to_task` grants           |
| **Merge**         | Multiple edges with identical `(from, to, kind)` are merged into one labeled edge                       |

### 2. Sequence Timeline

A vertical timeline showing message-passing chronology across agent lifelines.

| Feature         | Implementation                                                                                |
| --------------- | --------------------------------------------------------------------------------------------- |
| **Lifelines**   | One vertical dashed line per agent + `@Human` column                                          |
| **Events**      | Horizontal arrows: `stake` (orange) and `await` (purple) between lifelines                    |
| **Escalate**    | Special edge from agent to `@Human` with `escalate (reason)` label                            |
| **Loop depth**  | `extractTimeline` caps recursion to depth 1 into `WhenBlock`/`RepeatBlock` to avoid explosion |
| **Empty state** | "No active message transmissions" placeholder text                                            |

### 3. Agent Logic Flow (Swimlanes)

Per-agent flowchart showing internal control structure.

| Feature           | Implementation                                                                 |
| ----------------- | ------------------------------------------------------------------------------ |
| **Lanes**         | One column per agent with a vertical spine line                                |
| **Operations**    | `STAKE`, `AWAIT`, `LET`, `SET`, `ESCALATE`, `COMMIT` as colored rects          |
| **Diamonds**      | `WHEN: <cond>` and `REPEAT UNTIL: <cond>` as SVG polygons                      |
| **OTHERWISE**     | Gray diamond + indented body for else branch                                   |
| **Recursion**     | `renderOp()` → `renderOpList()` descends into `WhenBlock`/`RepeatBlock` bodies |
| **Depth opacity** | Nested operations get `opacity="0.7"` for visual hierarchy                     |
| **Lane sizing**   | `countOps()` recursively counts operations for height estimation               |

## Data-Flow Diagram

```
.slang file (on disk)
    │
    ▼
TextDocument.getText()
    │
    ▼
parseSlang(source) ────────────── slang-lexer.ts
    │                              slang-parser-upstream.ts (vendored @riktar/slang)
    ▼                              slang-ast.ts (type definitions)
  AST (Program)
    │
    ├──► stripSpans(flow) ── deletes the `span` key from every node
    │                        (which transitively drops its nested start/end)
    │
    ├──► validateSlangAST(ast) ── warnings: missing converge, deadlocks, orphan agents
    │
    ▼
  Payload = { type: "render", fileName, flow, diags }
    │
    ▼
  JSON.stringify → \u003c/\u003e/\u0026 escaping
    │
    ▼
  HTML shell (CSP nonce, inline CSS + payload;
  dagre + slang-render.js as external <script src>)
    │
    ├─ initial open / parse error → webviewPanel.webview.html = html
    │
    └─ subsequent edit (debounced 250 ms) → webviewPanel.webview.postMessage(payload)
                                            → window "message" listener
    │
    ▼
  safeRender(payload)
    │
    ├── _currentView === "topology"  → compileTopologySVG()
    ├── _currentView === "sequence"  → compileSequenceSVG()
    └── _currentView === "swimlane"  → compileSwimlaneSVG()
```

## CSS Theming

The visualization adapts to VS Code themes via CSS variables.

| Variable          | VS Code Mapping                  | Usage                                         |
| ----------------- | -------------------------------- | --------------------------------------------- |
| `--z-flow`        | `vscode-charts-blue`             | Flow header border, escalate edges            |
| `--z-agent`       | `vscode-charts-green`            | Agent node strokes, commit blocks             |
| `--z-stake`       | `vscode-charts-orange`           | Stake edges, stake blocks                     |
| `--z-await`       | `vscode-charts-purple`           | Await edges, await blocks                     |
| `--z-peer`        | `vscode-charts-cyan`             | Peer (direct-message) edges                   |
| `--z-meta`        | `vscode-descriptionForeground`   | Role text, param descriptions, let/set blocks |
| `--z-bg`          | `vscode-editor-background`       | Page and SVG background                       |
| `--z-fg`          | `vscode-foreground`              | Primary text                                  |
| `--z-card-bg`     | `vscode-editorWidget-background` | Node fill, flow header bg                     |
| `--z-card-border` | `vscode-widget-border`           | Graph container, node stroke on hover         |

## Key Files

### Core Engine — Parser + Editor Provider

| File                                                                        | Purpose                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`SlangEditorProvider.ts`](../src/core/webview/SlangEditorProvider.ts)      | `CustomTextEditorProvider` — parses `.slang`, generates HTML, watches for changes |
| [`slang-ast.ts`](../src/core/workflow/slang-ast.ts)                         | AST type definitions (`FlowDecl`, `AgentDecl`, `StakeOp`, `AwaitOp`, etc.)        |
| [`slang-parser.ts`](../src/core/workflow/slang-parser.ts)                   | Public API — `parseSlang()`, `validateSlangAST()`                                 |
| [`slang-parser-upstream.ts`](../src/core/workflow/slang-parser-upstream.ts) | Vendored parser from `@riktar/slang` (MIT)                                        |
| [`slang-lexer.ts`](../src/core/workflow/slang-lexer.ts)                     | Lexer (vendored)                                                                  |
| [`slang-resolver.ts`](../src/core/workflow/slang-resolver.ts)               | Static analysis — dependency graph, deadlock detection, warnings                  |

### Webview Render Engine

| File                                                       | Purpose                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`slang-render.js`](../src/core/webview/slang-render.js)   | Browser-side script (1735 lines) — three view compilers, drag handlers, `postMessage` live-refresh listener, CSP-safe event wiring |
| [`slang-render.css`](../src/core/webview/slang-render.css) | Stylesheet (457 lines) — tabs, nodes, edges, lifelines, swimlanes, diamonds                                                        |

### Extension Host Integration

| File                                                                    | Purpose                                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`extension.ts`](../src/extension.ts)                                   | `SlangEditorProvider.register(context)` at activation                               |
| [`package.json`](../src/package.json)                                   | `contributes.customEditors` — `shofer.slangEditor` matching `*.slang`               |
| [`esbuild.mjs`](../src/esbuild.mjs)                                     | `copyPaths` hook — `slang-render.{js,css}` + `dagre.min.js` → `dist/` during build  |
| [`__tests__/dist_assets.spec.ts`](../src/__tests__/dist_assets.spec.ts) | Asserts `slang-render.{js,css}` **and `dagre.min.js`** exist in `dist/` after build |

## Current Capabilities

- ✅ Three-view tabbed renderer (Topology, Sequence, Swimlane)
- ✅ Custom editor opens `.slang` files as editor tabs (not side panels)
- ✅ Live refresh on document change (edit `.slang` → visualization updates), debounced 250 ms and delivered via `postMessage` so the active view, zoom, and drag positions are preserved across edits
- ✅ Parse error display with line-level diagnostics
- ✅ Static analysis warnings (missing converge, orphan agents, unknown targets)
- ✅ Drag-and-drop node repositioning in topology view
- ✅ Declared `peers:` extracted as dashed cyan peer edges in topology view
- ✅ Edge labels, multi-edge offset, back-edge arcs
- ✅ Flow metadata display (title, description, icon, param descriptions)
- ✅ Recursive swimlane rendering into `WhenBlock`/`RepeatBlock` bodies
- ✅ CSP-safe event handling (`data-view` attributes + JS listeners, no inline `onclick`)
- ✅ VSCode theme-aware CSS variables
- ✅ Sequence timeline depth cap to prevent explosion from nested loops
- ✅ Zoom & pan controls (`+`/`−`/fit buttons, mousewheel zoom, drag-pan)
- ✅ Fit-to-view button (resets viewBox to initial SVG dimensions)
- ✅ Edge hover highlights (connected nodes stay bright, others dim to 25%)
- ✅ Sequence activation boxes on lifelines (faint highlight at each event Y)
- ✅ Agent role overflow tooltip (SVG `<title>` shows full untruncated role)
- ✅ CSP debugging (`console.log` warning on render start to surface blocked handlers)
- ✅ Rich markdown descriptions (`renderMarkdown()`: inline code, bold, italic, links)
- ✅ Param description tooltips (styled `.param-tooltip` bubble on hover)

## Gaps & Planned Improvements

### Rendering

| Gap                                  | Description                                                                                   | Priority |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | -------- |
| **Sequence concurrency**             | Parallel stake dispatches are indistinguishable from sequential ones                          | Low      |
| **Swimlane nesting depth indicator** | Deeply nested operations have the same fixed `opacity="0.7"` — could use a gradient or indent | Low      |

### Fixed

| Fix                                   | Description                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Duplicate stake/await in sequence** | Matched stake→@T + await←@S pairs (and escalate→@Human + await←@Human) are now merged into one timeline event per message. |

### Infrastructure

| Gap                                   | Description                                                                                                                                                                                                                                              | Priority |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **SlangEditorProvider.ts not in git** | `git` refuses to track the file (exists on disk, `git add -f` silent no-op). Suspect submodule or `.gitignore` issue at the repo boundary.                                                                                                               | High     |
| **No unit tests for render JS**       | The `slang-render.js` script has no automated tests. A jsdom-based test suite covering the three compilers would catch regressions.                                                                                                                      | Medium   |
| **Build copies stale dist/**          | `esbuild.mjs` copies files at `onEnd`, but the `src/dist/` directory can get out of sync with `src/core/webview/` during development if `./deploy.sh dev build shofer` is not run after every edit. A file-watcher mode for `slang-render.*` would help. | Medium   |

### Flow Metadata

| Gap               | Description                                                                                                          | Priority |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | -------- |
| **Icon registry** | `iconToEmoji()` is a hardcoded map. A user-extensible registry (e.g. custom icon keys → SVG) would be more flexible. | Low      |

---

## Review Findings (2026-06-11)

Findings from a review of this document against the live source
([`SlangEditorProvider.ts`](../src/core/webview/SlangEditorProvider.ts),
[`slang-render.js`](../src/core/webview/slang-render.js)). Doc-only factual
errors that were unambiguous have already been corrected inline above; this
section records the remaining code/design issues plus the rationale for the
inline fixes.

### Code / Design Issues — All Resolved (2026-06-11)

All five issues from the original review have been fixed in
[`SlangEditorProvider.ts`](../src/core/webview/SlangEditorProvider.ts) and
[`slang-render.js`](../src/core/webview/slang-render.js). Recorded here for
provenance.

| #   | Severity | Status      | Issue & resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | ✅ Resolved | **Live refresh destroyed all webview interaction state.** Every `onDidChangeTextDocument` reassigned `webviewPanel.webview.html`, rebuilding the DOM and resetting view/zoom/pan/drag on every keystroke. **Fixed:** the HTML shell is built once in [`resolveCustomTextEditor`](../src/core/webview/SlangEditorProvider.ts:50); subsequent edits `postMessage` a `{ type: "render", … }` payload ([`_handleDocumentChange`](../src/core/webview/SlangEditorProvider.ts:116)) and a `window.addEventListener("message", …)` listener in `slang-render.js` patches the SVG in place. A full rebuild now happens only on parse errors. `_currentView`/zoom/drag are preserved. |
| 2   | Medium   | ✅ Resolved | **No debounce on re-render.** **Fixed:** `onDidChangeTextDocument` now debounces at `RENDER_DEBOUNCE_MS = 250` via `setTimeout`/`clearTimeout` ([`SlangEditorProvider.ts:94`](../src/core/webview/SlangEditorProvider.ts:94)); the timer is cleared on `onDidDispose`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | Low      | ✅ Resolved | **CSP nonce used `Math.random()`.** **Fixed:** [`makeNonce()`](../src/core/webview/SlangEditorProvider.ts:251) now uses `crypto.randomBytes(16).toString("base64")`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Low      | ✅ Resolved | **Dead `.dtvis` reference** in the header comment. **Fixed:** the header comment ([`SlangEditorProvider.ts:1`](../src/core/webview/SlangEditorProvider.ts:1)) no longer mentions the removed side-panel provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | Low      | ✅ Resolved | **Render script inlined by string concatenation.** **Fixed:** `slang-render.js` is loaded via `<script src="…webview-uri…">` ([`_buildHtml`](../src/core/webview/SlangEditorProvider.ts:213)); the `fs.readFileSync` of the JS and the `RENDER_SCRIPT` constant are gone, and the CSP `script-src` now allows both the dagre and render-script URIs ([`buildCsp`](../src/core/webview/SlangEditorProvider.ts:255)).                                                                                                                                                                                                                                                          |

> **Verification (reported by the implementer, 2026-06-11):** TypeScript compiles
> with no new errors in the changed files; [`dist_assets.spec.ts`](../src/__tests__/dist_assets.spec.ts)
> (40 tests) passes, confirming `slang-render.js`, `slang-render.css`, and
> `dagre.min.js` resolve from `dist/`. Note the **"No unit tests for render JS"**
> gap in the Infrastructure table above still stands — `dist_assets.spec.ts` only
> asserts the assets are copied, not that the compilers render correctly.

### Doc Inaccuracies Corrected Inline

| Location                   | Was                                                                 | Now                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Related-documents links    | `todos/slang_specs.md`, `todos/workflow_design.md` (no such subdir) | `slang_specs.md`, `workflow_design.md` (both are siblings in `docs/`)                                                                                                          |
| Architecture / "providers" | "Two providers exist" but the table listed one                      | A single provider exists; the second (`.dtvis`) was removed                                                                                                                    |
| Line counts                | `slang-render.js` "1299"/"1533"; `slang-render.css` "352"           | `slang-render.js` is **1735** lines; `slang-render.css` is **457** lines                                                                                                       |
| esbuild / dist test        | only `slang-render.{js,css}` mentioned                              | also copies/asserts **`dagre.min.js`** (`node_modules/dagre/dist/dagre.min.js`)                                                                                                |
| `stripSpans` description   | "removes `{ span, start, end }`"                                    | deletes only the `span` key (which nests `start`/`end`); there are no sibling `start`/`end` keys                                                                               |
| `_currentView` persistence | "survives re-renders within the same webview session"               | now accurate: survives both in-webview tab switches **and** document-change re-renders, because edits arrive via `postMessage` rather than an HTML rebuild (issue #1 resolved) |

> **Note on the rendering pipeline:** validation warnings are computed only when
> there are **zero** parse errors (`result.errors.length > 0 ? [] : validateSlangAST(...)`
> in `_render`). When a file has any parse error, the static-analysis warnings are
> suppressed and only the parse errors are shown. This is reasonable but worth
> stating in the [Rendering Pipeline](#rendering-pipeline) section.
