# Slang Visualization Design

Reference for the `.slang` file visualization system in Shofer. Covers the current architecture, the rendering pipeline, and known gaps with planned improvements.

> **Related documents**
>
> - [`slang_specs.md`](todos/slang_specs.md) — the Slang language specification
> - [`workflow_design.md`](todos/workflow_design.md) — Workflow abstraction and Slang → Shofer mapping

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

The editor generates a self-contained HTML page with inline SVG, CSS, and JavaScript — there is **no webview-ui build step**, no React, and no npm dependency for the render engine. Everything runs in a sandboxed webview with a Content Security Policy (CSP) nonce.

Two providers exist:

| Provider                  | File                                                                                 | Role                                                   | Status                                            |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------- |
| `SlangEditorProvider`     | [`SlangEditorProvider.ts`](../src/core/webview/SlangEditorProvider.ts)               | Custom editor for `.slang` files (opens as editor tab) | ✅ Primary                                        |
| `SlangVisualizationPanel` | [`SlangVisualizationProvider.ts`](../src/core/webview/SlangVisualizationProvider.ts) | Side-panel webview (legacy)                            | ⚠️ Retained for `slangVisualization.show` command |

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
│  │   File watcher: onDidChangeTextDocument → re-render         │
│  │                                                             │
│  └── SlangVisualizationPanel (legacy command)                  │
│                                                               │
│  esbuild.mjs: copyPaths hook ensures slang-render.{js,css}    │
│  are copied from src/core/webview/ → dist/ at build time.      │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Webview (sandboxed, CSP-nonce)                               │
│                                                               │
│  HTML payload: { type: "render", fileName, flow, diags }      │
│                                                               │
│  slang-render.css (352 lines)  ─  VSCode CSS variables        │
│  slang-render.js (1299 lines) ─  Three view compilers         │
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
5. **Embed** — The payload, CSS, and render script are inlined into a `<script nonce="...">` block
6. **Render** — `safeRender(__payload)` calls `render(payload)` which dispatches to the appropriate view compiler

## Three View Modes

The user switches between views via tab buttons rendered by the JS. The active view is tracked in `_currentView` (module-level variable, survives re-renders within the same webview session).

### 1. Topology Network

The **default view** — a directed graph showing agent relationships and data routing.

| Feature           | Implementation                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------- |
| **Nodes**         | Agent cards (name + mode badge + role) rendered as SVG `<g>` groups                       |
| **Edges**         | `stake → @Recipient` as orange arrows, `await ← @Source` as purple arrows                 |
| **Layout**        | BFS-based topological layering from sources (agents with no incoming edges)               |
| **Drag**          | `mousedown`/`mousemove`/`mouseup` handlers on `.node-group` elements                      |
| **Edge updates**  | `updateConnectedEdges()` redispatches `edgePathData()` with current `_layout` coordinates |
| **Edge labels**   | Text at bezier midpoints with background rects, repositioned during drag                  |
| **Arrow markers** | SVG `<marker>` defs (`ah-stake`, `ah-await`) with distinct colors                         |
| **Multi-edges**   | Parallel edges between same agent pair get vertical offset                                |
| **Back-edges**    | Reversed or same-layer edges arc above nodes instead of through them                      |
| **Merge**         | Multiple edges with identical `(from, to, kind)` are merged into one labeled edge         |

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
    ├──► stripSpans(flow) ── removes { span, start, end } from all nodes
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
  HTML template (CSP nonce, inline CSS + JS)
    │
    ▼
  webviewPanel.webview.html = html
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
| `--z-meta`        | `vscode-descriptionForeground`   | Role text, param descriptions, let/set blocks |
| `--z-bg`          | `vscode-editor-background`       | Page and SVG background                       |
| `--z-fg`          | `vscode-foreground`              | Primary text                                  |
| `--z-card-bg`     | `vscode-editorWidget-background` | Node fill, flow header bg                     |
| `--z-card-border` | `vscode-widget-border`           | Graph container, node stroke on hover         |

## Key Files

### Core Engine — Parser + Editor Provider

| File                                                                                 | Purpose                                                                           |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [`SlangEditorProvider.ts`](../src/core/webview/SlangEditorProvider.ts)               | `CustomTextEditorProvider` — parses `.slang`, generates HTML, watches for changes |
| [`SlangVisualizationProvider.ts`](../src/core/webview/SlangVisualizationProvider.ts) | Legacy side-panel provider (`slangVisualization.show` command)                    |
| [`slang-ast.ts`](../src/core/workflow/slang-ast.ts)                                  | AST type definitions (`FlowDecl`, `AgentDecl`, `StakeOp`, `AwaitOp`, etc.)        |
| [`slang-parser.ts`](../src/core/workflow/slang-parser.ts)                            | Public API — `parseSlang()`, `validateSlangAST()`                                 |
| [`slang-parser-upstream.ts`](../src/core/workflow/slang-parser-upstream.ts)          | Vendored parser from `@riktar/slang` (MIT)                                        |
| [`slang-lexer.ts`](../src/core/workflow/slang-lexer.ts)                              | Lexer (vendored)                                                                  |
| [`slang-resolver.ts`](../src/core/workflow/slang-resolver.ts)                        | Static analysis — dependency graph, deadlock detection, warnings                  |

### Webview Render Engine

| File                                                       | Purpose                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`slang-render.js`](../src/core/webview/slang-render.js)   | Browser-side script (1299 lines) — three view compilers, drag handlers, CSP-safe event wiring |
| [`slang-render.css`](../src/core/webview/slang-render.css) | Stylesheet (352 lines) — tabs, nodes, edges, lifelines, swimlanes, diamonds                   |

### Extension Host Integration

| File                                                                    | Purpose                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`extension.ts`](../src/extension.ts)                                   | `SlangEditorProvider.register(context)` at activation                 |
| [`package.json`](../src/package.json)                                   | `contributes.customEditors` — `shofer.slangEditor` matching `*.slang` |
| [`esbuild.mjs`](../src/esbuild.mjs)                                     | `copyPaths` hook — `slang-render.{js,css}` → `dist/` during build     |
| [`__tests__/dist_assets.spec.ts`](../src/__tests__/dist_assets.spec.ts) | Asserts `slang-render.{js,css}` exist in `dist/` after build          |

## Current Capabilities

- ✅ Three-view tabbed renderer (Topology, Sequence, Swimlane)
- ✅ Custom editor opens `.slang` files as editor tabs (not side panels)
- ✅ Live refresh on document change (edit `.slang` → visualization updates)
- ✅ Parse error display with line-level diagnostics
- ✅ Static analysis warnings (missing converge, orphan agents, unknown targets)
- ✅ Drag-and-drop node repositioning in topology view
- ✅ Edge labels, multi-edge offset, back-edge arcs
- ✅ Flow metadata display (title, description, icon, param descriptions)
- ✅ Recursive swimlane rendering into `WhenBlock`/`RepeatBlock` bodies
- ✅ CSP-safe event handling (`data-view` attributes + JS listeners, no inline `onclick`)
- ✅ VSCode theme-aware CSS variables
- ✅ Sequence timeline depth cap to prevent explosion from nested loops

## Gaps & Planned Improvements

### Rendering

| Gap                                  | Description                                                                                   | Priority |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | -------- |
| **Zoom & pan**                       | Large flows (5+ agents with nested loops) overflow the SVG viewport with no zoom/pan controls | Medium   |
| **Fit-to-view**                      | No "fit all" or "zoom to selection" button                                                    | Low      |
| **Edge hover highlights**            | Hovering over an edge could highlight connected nodes and dim others                          | Low      |
| **Sequence lifecycle states**        | Lifelines don't show activation blocks (running vs blocked vs idle) — all are static lines    | Low      |
| **Sequence concurrency**             | Parallel stake dispatches are indistinguishable from sequential ones                          | Low      |
| **Swimlane nesting depth indicator** | Deeply nested operations have the same fixed `opacity="0.7"` — could use a gradient or indent | Low      |
| **Agent role overflow**              | Role text is truncated to 2 lines max without tooltip                                         | Low      |

### Infrastructure

| Gap                                              | Description                                                                                                                                                                                                                                              | Priority |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **SlangEditorProvider.ts not in source control** | `git` refuses to track the file (exists on disk, `git add -f` silent no-op). Suspect submodule or `.gitignore` issue at the repo boundary.                                                                                                               | High     |
| **Dual provider maintenance**                    | `SlangVisualizationProvider` duplicates the HTML generation logic from `SlangEditorProvider`. Should be consolidated into a shared helper.                                                                                                               | Medium   |
| **No unit tests for render JS**                  | The `slang-render.js` 1299-line browser script has no automated tests. A jsdom-based test suite covering the three compilers would catch regressions.                                                                                                    | Medium   |
| **Build copies stale dist/**                     | `esbuild.mjs` copies files at `onEnd`, but the `src/dist/` directory can get out of sync with `src/core/webview/` during development if `./deploy.sh dev build shofer` is not run after every edit. A file-watcher mode for `slang-render.*` would help. | Medium   |
| **CSP debugging**                                | CSP violations are silent in the webview (no console errors). A CSP report-uri or dev-mode warning when inline event handlers are detected would catch them.                                                                                             | Low      |

### Flow Metadata

| Gap                            | Description                                                                                                          | Priority |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------- |
| **Icon registry**              | `iconToEmoji()` is a hardcoded map. A user-extensible registry (e.g. custom icon keys → SVG) would be more flexible. | Low      |
| **Rich description rendering** | `description` is rendered as plain text with `\n` → `<br>`. Markdown (bold, inline code, links) is not supported.    | Low      |
| **Param description tooltips** | Param descriptions are shown as `title` attributes on `<code>` elements — no hover styling or expandable detail.     | Low      |
