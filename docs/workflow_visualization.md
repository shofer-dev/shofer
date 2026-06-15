# Slang Visualization Design

Reference for the `.slang` file visualization system in Shofer. Covers the architecture, dual rendering paths (standalone editor + WorkflowView iframe), three view modes, runtime-aware diagram overlays, and mailbox history persistence.

> **Related documents**
>
> - [`slang_specs.md`](slang_specs.md) — the Slang language specification
> - [`workflow_design.md`](workflow_design.md) — Workflow abstraction and Slang → Shofer mapping
> - [`terminology.md`](terminology.md) — canonical names for UI components

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Dual Rendering Paths](#dual-rendering-paths)
3. [Three View Modes](#three-view-modes)
4. [Runtime-Aware Rendering](#runtime-aware-rendering)
5. [Mailbox History & Persistence](#mailbox-history--persistence)
6. [WorkflowView Embedding](#workflowview-embedding)
7. [CSS Theming](#css-theming)
8. [Key Files](#key-files)
9. [Current Capabilities](#current-capabilities)
10. [Gaps & Planned Improvements](#gaps--planned-improvements)

---

## Architecture Overview

The visualization system serves two distinct surfaces:

1. **Standalone `.slang` editor** — A VS Code custom editor tab. When a `.slang` file is opened (Explorer double-click), VS Code delegates to [`SlangEditorProvider`](../src/core/webview/SlangEditorProvider.ts), a [`CustomTextEditorProvider`](https://code.visualstudio.com/api/extension-guides/custom-editors). This renders the **full** visualization: flow header metadata (title, description, params, converge/budgets), the internal tab bar, graph hints, runtime banner (when a workflow is executing), and the diagram SVG.

2. **WorkflowView iframe** — An `<iframe srcdoc>` embedded inside the [`WorkflowView`](../webview-ui/src/components/chat/WorkflowView.tsx) React chat UI. The flow header metadata is rendered **natively in TaskHeader** via [`WorkflowVizMeta`](../packages/types/src/vscode-extension-host.ts), the tab bar lives in the React tree, and the iframe is **diagram-only** (SVG + zoom controls).

The render engine is the same [`slang-render.js`](../src/core/webview/slang-render.js) script in both cases. A `context` field in the payload distinguishes the two paths.

Graph layout is delegated to **dagre** (v0.8.5). In the standalone editor, dagre and `slang-render.js` are loaded as external `<script src="…">` (webview URIs). In the WorkflowView iframe, all three assets (dagre, `slang-render.js`, `slang-render.css`) are **inlined** into the srcdoc HTML — the parent webview's CSP (`default-src 'none'`, `strict-dynamic`) is inherited by the srcdoc iframe and would block external loads. Each `<script>` carries a `{{CSP_NONCE}}` placeholder that [`SlangViz`](../webview-ui/src/components/chat/SlangViz.tsx) stamps with the live webview nonce before assigning `srcdoc`.

On the **initial** open (standalone editor), the full HTML shell is built once. On **subsequent document edits** the provider `postMessage`s a `{ type: "render", … }` payload; the listener patches the SVG in place, preserving view/zoom/drag. A full HTML rebuild only happens on parse errors.

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  VS Code Extension Host                                              │
│                                                                      │
│  SlangEditorProvider (standalone .slang editor)                      │
│  ├── parseSlang → validate → buildCsp → generate HTML                │
│  └── onDidChangeTextDocument → postMessage(payload)                  │
│                                                                      │
│  WorkflowTask (WorkflowView embedding)                               │
│  ├── buildWorkflowVizMeta(slangSource) → WorkflowVizMeta             │
│  ├── buildWorkflowVizHtml(source, flowState, runState) → srcdoc HTML │
│  └── notifySlangEditor()                                            │
│      ├── workflowVizMeta      → postConfigUpdate (once)              │
│      ├── workflowVizHtml       → postConfigUpdate (once)             │
│      └── workflowVizRunState   → postConfigUpdate (per round/step)   │
└──────────────────────────────────────────────────────────────────────┘
                        │                          │
                        ▼                          ▼
┌───────────────────────────────┐  ┌──────────────────────────────────┐
│  Standalone .slang Editor     │  │  WorkflowView (React chat UI)     │
│  (custom editor tab)          │  │                                   │
│                               │  │  ┌─ TaskHeader ─────────────────┐ │
│  Payload: { type:"render",    │  │  │  workflowVizMeta rendered     │ │
│    flow, diags }              │  │  │  natively (icon, title,       │ │
│  (no context → full render)   │  │  │  description, params,         │ │
│                               │  │  │  converge, budgets)           │ │
│  ┌───────────────────────────┐│  │  └──────────────────────────────┘ │
│  │ flow-header               ││  │                                   │
│  │ .view-selector-tabs       ││  │  ┌─ React tab bar ──────────────┐ │
│  │ graph-hint                ││  │  │  Events|Tree|Topo|Seq|State  │ │
│  │ runtime-banner            ││  │  │  → postMessage(switchView)   │ │
│  │ .zoom-controls            ││  │  └──────────────────────────────┘ │
│  │ <svg> diagram             ││  │                                   │
│  └───────────────────────────┘│  │  ┌─ SlangViz <iframe srcdoc> ───┐ │
│                               │  │  │  Payload: { type:"render",    │ │
│                               │  │  │    context:"workflowView",     │ │
│                               │  │  │    flow, diags, runState }     │ │
│                               │  │  │  SVG + zoom controls only     │ │
│                               │  │  │  Theme CSS injected from      │ │
│                               │  │  │  parent document               │ │
│                               │  │  └───────────────────────────────┘ │
└───────────────────────────────┘  └──────────────────────────────────┘
```

---

## Dual Rendering Paths

`handleRender()` in [`slang-render.js`](../src/core/webview/slang-render.js) uses `payload.context === "workflowView"` to switch between two modes:

| Mode             | Trigger                      | Header               | Tab bar                                            | Runtime banner     | Graph hints        |
| ---------------- | ---------------------------- | -------------------- | -------------------------------------------------- | ------------------ | ------------------ |
| **Standalone**   | `context` absent             | Rendered in iframe   | Rendered in iframe (JS-wired `.tab-btn` listeners) | Rendered in iframe | Rendered in iframe |
| **WorkflowView** | `context === "workflowView"` | Native in TaskHeader | Native in React (postMessage `switchView`)         | —                  | —                  |

### View Switching

- **Standalone editor**: Tab buttons are `.tab-btn[data-view]` elements wired by JS event listeners. Clicking invokes `switchView(viewName)` → `_currentView = viewName` → `safeRender(null)`.
- **WorkflowView**: The React tab bar in [`WorkflowView.tsx`](../webview-ui/src/components/chat/WorkflowView.tsx) manages `workflowTab` state. Its tabs are **`[ Events ] [ Tree ] [ Topology ] [ Sequence ] [ State ]`** — the message feed is labelled "Events" (not "Chat"), "Swimlane" is labelled "State", and a "Tree" tab embeds the task-hierarchy [`TaskTreeView`](../webview-ui/src/components/chat/TaskTreeView.tsx) rooted at the workflow task (see [`task_visualization.md`](task_visualization.md)). The three slang views (Topology/Sequence/State) drive the iframe: on tab change, [`SlangViz`](../webview-ui/src/components/chat/SlangViz.tsx) sends `postMessage({type:"switchView", view})` (the `view` key is still `swimlane` for the "State" tab); the render engine's `"message"` listener sets `_currentView` and re-renders — **no srcdoc rebuild**, preserving zoom and pan state. The Events/Tree tabs render natively in React, not the iframe.

### Theme Inheritance (iframe only)

The srcdoc iframe is an isolated document — `--vscode-*` CSS custom properties from the parent webview do **not** cascade into it. [`SlangViz.tsx`](../webview-ui/src/components/chat/SlangViz.tsx) solves this via `getThemeStyleBlock()`: reads 16 VSCode theme variable values from the parent's `getComputedStyle()` and injects them as a second `<style>:root { … }</style>` block before assigning `srcdoc`.

### CSP Nonce Injection (iframe only)

Each `<script>` tag in the srcdoc HTML carries a `{{CSP_NONCE}}` placeholder. `SlangViz` replaces these with `window.__shofer_csp_nonce__` (exposed by [`ShoferProvider`](../src/core/webview/ShoferProvider.ts)) before assigning `srcdoc`, satisfying the inherited `script-src … 'nonce-XXX'` policy.

---

## Three View Modes

The user switches between views via tab buttons. The active view is tracked in `_currentView` (module-level variable). It persists across in-webview tab switches and across document-change re-renders (edits arrive via `postMessage`, not HTML rebuilds).

### 1. Topology Network

The **default view** — a directed graph showing agent relationships and data routing.

> **Scope differs by surface.** In the **standalone `.slang` editor** the topology renders the _full_ static graph (every agent + every declared `stake`/`await`/`peer` edge) — the map of what the flow _could_ do. In the **WorkflowView** (`context: "workflowView"`) it renders only the **current round's participants**: agents that are `running` (with their outbound stake edges, from the live `sendingTo`) or `blocked` (with the await edges they're parked on, from `waitingFor`), plus the agents on the other end of those edges. Before the run starts (or once converged) nothing is active, so it shows a "Workflow not started" / "No agents active right now" placeholder rather than the whole plan. See [`currentRoundSubset()`](../src/core/webview/slang-render.js).

| Feature            | Implementation                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Nodes**          | Agent cards (name + mode badge + role) rendered as SVG `<g>` groups                                         |
| **Edges**          | `stake → @Recipient` as orange arrows, `await ← @Source` as purple arrows, `peer` as dashed cyan arrows     |
| **Layout**         | dagre layered layout (LR rankdir)                                                                           |
| **Drag**           | `mousedown`/`mousemove`/`mouseup` handlers on `.node-group` elements                                        |
| **Edge updates**   | `updateConnectedEdges()` redispatches `edgePathData()` with current `_layout` coordinates                   |
| **Edge labels**    | Text at bezier midpoints with background rects, repositioned during drag                                    |
| **Runtime badges** | Agent status + opIndex rendered as colored badges on nodes when `_runState` is available                    |
| **Runtime edges**  | Active edges (matched via `sendingTo`/`waitingFor`) get `.edge-runtime-active` class with pulsing animation |
| **Multi-edges**    | Parallel edges between same agent pair get vertical offset                                                  |
| **Peer edges**     | Dashed cyan arrows from `agent.meta.peers` — `send_message_to_task` grants                                  |

### 2. Sequence Timeline

A vertical timeline showing message-passing chronology across agent lifelines.

> **A real chronology only exists at runtime.** Execution order is decided by the round scheduler, `await` dependencies, conditionals (`if`/`when`), and loops (`repeat`) — it cannot be known from the source alone. So the Sequence view is a **WorkflowView-only** view: it builds from `mailboxHistory` in append (chronological) order, plus **pending sends** (agents whose `sendingTo` is set but whose result hasn't been routed yet) for the current round. Empty before the first message. The **standalone `.slang` editor has no Sequence tab** — its static structure is fully covered by Topology (who routes to whom) and Agent Logic Flow (per-agent control flow). An earlier static "Dependencies" partial-order view was removed as redundant with Topology.

| Feature           | Implementation                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lifelines**     | One vertical dashed line per agent + `@Human` column                                                                                              |
| **Runtime mode**  | When `_runState.mailboxHistory` is available, events are built from actual mailbox entries (sorted by timestamp) instead of static AST extraction |
| **Pending sends** | Agents with `sendingTo` set but no mailbox entry yet appear as dashed italic pending arrows                                                       |
| **Events**        | Horizontal arrows: `stake` (orange) and `await` (purple) between lifelines                                                                        |
| **Escalate**      | Special edge from agent to `@Human` with `escalate (reason)` label                                                                                |
| **Loop depth**    | `extractTimeline` caps recursion to depth 1 into `WhenBlock`/`RepeatBlock` to avoid explosion                                                     |
| **Empty state**   | "No active message transmissions" placeholder text                                                                                                |
| **Tooltips**      | `<title>` elements on each arrow showing tokens, cost, and duration from mailbox metadata                                                         |

### 3. Agent Logic Flow (Swimlanes)

Per-agent flowchart showing internal control structure.

| Feature               | Implementation                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lanes**             | One column per agent with a vertical spine line                                                                                                                                                                                 |
| **Operations**        | `STAKE`, `AWAIT`, `LET`, `SET`, `ESCALATE`, `COMMIT` as colored rects                                                                                                                                                           |
| **Diamonds**          | `WHEN: <cond>` and `REPEAT UNTIL: <cond>` as SVG polygons                                                                                                                                                                       |
| **OTHERWISE**         | Gray diamond + indented body for else branch                                                                                                                                                                                    |
| **Recursion**         | `renderOp()` → `renderOpList()` descends into `WhenBlock`/`RepeatBlock` bodies                                                                                                                                                  |
| **Depth opacity**     | Nested operations get `opacity="0.7"` for visual hierarchy                                                                                                                                                                      |
| **Runtime highlight** | The operation block matching the agent's `opIndex` is marked with a left-pointing ▶ arrow (`flow-exec-arrow`) in the lane gutter — far easier to spot than a fill tint. (Previously a `.flow-executing` colored-fill overlay.) |
| **Lane sizing**       | `countOps()` recursively counts operations for height estimation                                                                                                                                                                |

---

## Runtime-Aware Rendering

When a workflow is executing (or has completed), the `runState` field in the payload carries serialized `FlowState` data including each agent's `{ status, opIndex, sendingTo, waitingFor }` and the `mailboxHistory` array. All three views use this data:

### Topology

- **Current-round subset (WorkflowView)**: `compileTopologySVG()` renders only the agents/edges active this round (see [Three View Modes](#1-topology-network)); the standalone editor still renders the full static graph.
- **Node badges**: Each agent node shows `status (opIndex)` — e.g. "running (3)" — colored by status (green=running, purple=blocked, gray=committed, blue=idle, red=error).
- **Active edges**: `renderEdge()` checks whether the source agent's `sendingTo` list contains the target OR the target agent's `waitingFor` list contains the source. If so, the edge gets the `edge-runtime-active` CSS class which applies a pulsing `slang-edge-pulse` animation (stroke-width oscillates 3.2→5.5 over 1.5s). Both fields are comma-joined name lists (`splitRefs()`).

### Sequence

- **Mailbox-sourced timeline**: In the WorkflowView (or any run with history), `compileSequenceSVG()` builds events from `mailboxHistory` in append (chronological) order — the **real message-passing history** — and copies each entry's `tokensUsed`/`costUsd`/`durationMs` onto the event for arrow tooltips.
- **Pending sends**: Agents with `sendingTo` set whose result hasn't been routed yet get dashed pending arrows (`.sequence-pending`) for the current round.
- **No static plan**: the static AST extraction is **not** used — before the first message the view is empty, not a render of the whole plan. The standalone editor has no Sequence tab at all.

> **Runtime field population.** `waitingFor` is set by the interpreter ([`slang-interpreter.ts`](../src/core/workflow/slang-interpreter.ts)) when an agent blocks on an `await`; `sendingTo` is set by [`WorkflowTask.dispatchStakes()`](../src/core/workflow/WorkflowTask.ts) to the staking agent's recipient list and cleared once the result is routed (or the agent errors). Both are serialized on `AgentState` and drive the runtime edge/pending overlays above.

### Swimlane

- **OpIndex marker**: Each operation block in a lane is assigned a 1-based index via `_opCounter`. When an agent's `opIndex` matches a block's index, a left-pointing ▶ arrow (`flow-exec-arrow`, filled `var(--z-stake)`) is drawn in the gutter beside that block. The block is no longer tinted (`flow-executing` / `data-optype` are not applied).
- **Lane header badge**: Per-lane status badge (e.g. "running @5") shown in the top-right of each swimlane.

### CSS additions for runtime overlays

```css
/* Topology: active edge pulse animation */
.edge-group.edge-runtime-active .edge-path {
	animation: slang-edge-pulse 1.5s ease-in-out infinite;
}
@keyframes slang-edge-pulse {
	0%,
	100% {
		stroke-width: 3.2;
	}
	50% {
		stroke-width: 5.5;
	}
}

/* Swimlane: the executing op is flagged by a ▶ arrow drawn inline
   (fill="var(--z-stake)"), not a fill tint — no .flow-executing rule. */

/* Sequence: pending (undelivered) messages */
.sequence-group.sequence-pending .sequence-line {
	stroke-dasharray: 6 3;
	opacity: 0.55;
}
```

---

## Mailbox History & Persistence

### Data model

The `FlowState` type in [`slang-types.ts`](../src/core/workflow/slang-types.ts) has two mailbox fields:

| Field                            | Purpose                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `mailbox: MailboxEntry[]`        | Transient in-flight mailbox, cleared each round (consumed by `consumeMail`)                             |
| `mailboxHistory: MailboxEntry[]` | Accumulated history of all mailbox entries ever produced. Persisted across rounds and VS Code restarts. |

### Entry metadata

Each [`MailboxEntry`](../src/core/workflow/slang-types.ts) carries:

| Field        | Description                                |
| ------------ | ------------------------------------------ |
| `from`, `to` | Agent names                                |
| `value`      | The stake output value                     |
| `timestamp`  | Unix ms timestamp                          |
| `funcName`   | The stake function name                    |
| `tokensUsed` | Token count for the producing agent turn   |
| `costUsd`    | USD cost for the producing agent turn      |
| `durationMs` | Active wall-clock time of the agent turn   |
| `mode`       | Agent mode slug (e.g. "code", "architect") |

### Metadata enrichment

In [`collectStakeResults()`](../src/core/workflow/WorkflowTask.ts), after a child agent task completes its stake, the agent's `HistoryItem` is read for `tokensIn/Out`, `totalCost`, and `activeTimeMs`. After `routeOutput()` pushes entries into `mailboxHistory`, the new entries are stamped with these values plus the child task's mode from `TaskManager`.

### Persistence chain

1. **Serialize**: `getHistoryExtension()` → `serializeFlowState(this.flowState)` includes `mailboxHistory`.
2. **Write**: `persistCheckpoint()` → `provider.updateTaskHistory()` writes into VS Code `globalState` (SQLite-backed).
3. **Restore**: `createWorkflowTaskFromHistory()` → `deserializeFlowState(historyItem.flowState)` restores `mailboxHistory`.
4. **Backward compat**: `deserializeFlowState` uses `|| []` fallback — old checkpoints without the field restore with an empty history.

`persistCheckpoint()` is called at every round boundary, after every escalation, on budget exceed, on abort, and on completion — so the history is always up-to-date and durable across restarts.

---

## WorkflowView Embedding

### Flow metadata in TaskHeader

[`buildWorkflowVizMeta(slangSource)`](../src/core/workflow/WorkflowTask.ts) extracts flow metadata from the parsed AST into a typed [`WorkflowVizMeta`](../packages/types/src/vscode-extension-host.ts) object:

```
WorkflowVizMeta {
    icon?: string           // e.g. "rocket", mapped to lucide Rocket icon
    displayTitle: string    // flow.title || flow.name
    flowName?: string       // present when title ≠ name
    description?: string    // markdown description
    params?: Array<{ name, type, description }>
    convergeCondition?: string
    budgets?: Array<{ kind, value }>
    agentCount: number
}
```

This is pushed once via `postConfigUpdate("workflowVizMeta", …)` and rendered natively in [`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx) (expanded state):

- 🚀 Rocket icon + display title
- `flow "name"` in monospace
- Description (whitespace-pre-wrap)
- Params as `<code>` tags
- 🎯 Converge when + 💰 budget items

### Diagram-only iframe

[`buildWorkflowVizHtml()`](../src/core/workflow/WorkflowTask.ts) builds the srcdoc HTML with `context: "workflowView"` in the payload. The iframe contains only:

- The diagram SVG
- Zoom controls (+, −, fit buttons)
- Diagnostics panel

View switches from the React tab bar and runtime state updates arrive via `postMessage`.

### postMessage protocol (iframe)

| Message                              | Direction       | Purpose                                 |
| ------------------------------------ | --------------- | --------------------------------------- |
| `{ type: "runtimeState", runState }` | Parent → iframe | Per-round/step agent state for overlays |
| `{ type: "switchView", view }`       | Parent → iframe | Tab change from React tab bar           |
| `{ type: "render", … }`              | Parent → iframe | Initial HTML load (once)                |

---

## CSS Theming

The visualization adapts to VS Code themes via CSS variables. In the standalone editor, these resolve naturally from the webview's inherited stylesheet. In the WorkflowView iframe, theme variables are injected by `getThemeStyleBlock()`.

| Variable          | VS Code Mapping                  | Usage                                         |
| ----------------- | -------------------------------- | --------------------------------------------- |
| `--z-flow`        | `vscode-charts-blue`             | Flow header border, converge edges            |
| `--z-agent`       | `vscode-charts-green`            | Agent node strokes, commit blocks             |
| `--z-stake`       | `vscode-charts-orange`           | Stake edges, stake blocks                     |
| `--z-await`       | `vscode-charts-purple`           | Await edges, await blocks                     |
| `--z-peer`        | `vscode-charts-cyan`             | Peer (direct-message) edges                   |
| `--z-meta`        | `vscode-descriptionForeground`   | Role text, param descriptions, let/set blocks |
| `--z-bg`          | `vscode-editor-background`       | Page and SVG background                       |
| `--z-fg`          | `vscode-foreground`              | Primary text                                  |
| `--z-card-bg`     | `vscode-editorWidget-background` | Node fill, flow header bg                     |
| `--z-card-border` | `vscode-widget-border`           | Graph container, node stroke on hover         |

---

## Key Files

### Core Engine — Parser + Editor Provider

| File                                                                   | Purpose                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`SlangEditorProvider.ts`](../src/core/webview/SlangEditorProvider.ts) | `CustomTextEditorProvider` — parses `.slang`, generates HTML, watches for changes |
| [`slang-ast.ts`](../src/core/workflow/slang-ast.ts)                    | AST type definitions (`FlowDecl`, `AgentDecl`, `StakeOp`, `AwaitOp`, etc.)        |
| [`slang-parser.ts`](../src/core/workflow/slang-parser.ts)              | Public API — `parseSlang()`, `validateSlangAST()`                                 |
| [`slang-resolver.ts`](../src/core/workflow/slang-resolver.ts)          | Static analysis — dependency graph, deadlock detection, warnings                  |
| [`slang-interpreter.ts`](../src/core/workflow/slang-interpreter.ts)    | Pure-function VM — `advanceAgent()`, `routeOutput()`, `consumeMail()`             |
| [`slang-types.ts`](../src/core/workflow/slang-types.ts)                | Runtime types — `FlowState`, `AgentState`, `MailboxEntry`, (de)serializers        |

### Webview Render Engine

| File                                                       | Purpose                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`slang-render.js`](../src/core/webview/slang-render.js)   | Browser-side script — three view compilers, drag handlers, `postMessage` listener, dual-mode `handleRender()`, runtime overlays |
| [`slang-render.css`](../src/core/webview/slang-render.css) | Stylesheet — tabs, nodes, edges, lifelines, swimlanes, diamonds, runtime animations                                             |

### WorkflowView Integration

| File                                                                         | Purpose                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`WorkflowTask.ts`](../src/core/workflow/WorkflowTask.ts)                    | `buildWorkflowVizMeta()`, `buildWorkflowVizHtml()`, `notifySlangEditor()`            |
| [`SlangViz.tsx`](../webview-ui/src/components/chat/SlangViz.tsx)             | React component — srcdoc iframe, CSP nonce stamping, theme injection, view switching |
| [`TaskHeader.tsx`](../webview-ui/src/components/chat/TaskHeader.tsx)         | Renders `WorkflowVizMeta` natively in expanded state                                 |
| [`WorkflowView.tsx`](../webview-ui/src/components/chat/WorkflowView.tsx)     | Tab bar, passes `workflowVizMeta`/`workflowVizRunState` to children                  |
| [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts) | `WorkflowVizMeta` interface, `ExtensionState` fields                                 |
| [`ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                 | Seeds `workflowVizMeta`/`workflowVizHtml`/`workflowVizRunState`, exposes CSP nonce   |

### Build & Test

| File                                                                    | Purpose                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`esbuild.mjs`](../src/esbuild.mjs)                                     | `copyPaths` hook — `slang-render.{js,css}` + `dagre.min.js` → `dist/` |
| [`__tests__/dist_assets.spec.ts`](../src/__tests__/dist_assets.spec.ts) | Asserts assets exist in `dist/` after build                           |

---

## Current Capabilities

- ✅ Three-view tabbed renderer (Topology, Sequence, Swimlane)
- ✅ Dual rendering paths: standalone `.slang` editor + WorkflowView iframe
- ✅ Flow metadata rendered natively in TaskHeader (WorkflowView) — no duplication with iframe header
- ✅ Custom editor opens `.slang` files as editor tabs (not side panels)
- ✅ Live refresh on document change (debounced 250ms, `postMessage` delivery)
- ✅ Parse error display with line-level diagnostics
- ✅ Static analysis warnings (missing converge, orphan agents, unknown targets)
- ✅ Drag-and-drop node repositioning in topology view
- ✅ Runtime-aware topology: agent status/opIndex badges, active edge pulsing via `sendingTo`/`waitingFor`
- ✅ Runtime-aware sequence: mailbox-history-sourced timeline with pending-send indicators
- ✅ Runtime-aware swimlane: ▶ arrow marker on the currently executing op (opIndex)
- ✅ Mailbox history persistence across VS Code restarts
- ✅ Sequence arrow tooltips showing tokens, cost, and duration
- ✅ Edge labels, multi-edge offset, back-edge arcs
- ✅ Declared `peers:` extracted as dashed cyan peer edges
- ✅ Recursive swimlane rendering into `WhenBlock`/`RepeatBlock` bodies
- ✅ CSP-safe event handling (`data-view` + JS listeners, no inline `onclick`)
- ✅ VSCode theme-aware CSS variables (injected into srcdoc for iframe)
- ✅ CSP nonce stamping for srcdoc scripts
- ✅ Zoom & pan controls (+, −, fit buttons, mousewheel zoom, drag-pan)
- ✅ Edge hover highlights (connected nodes bright, others dimmed)
- ✅ Sequence activation boxes on lifelines
- ✅ Agent role overflow tooltip (SVG `<title>`)
- ✅ Rich markdown descriptions

## Gaps & Planned Improvements

### Rendering

| Gap                                  | Description                                                                                   | Priority |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | -------- |
| **Sequence concurrency**             | Parallel stake dispatches are indistinguishable from sequential ones                          | Low      |
| **Swimlane nesting depth indicator** | Deeply nested operations have the same fixed `opacity="0.7"` — could use a gradient or indent | Low      |

### Infrastructure

| Gap                             | Description                                                                                                                           | Priority |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **No unit tests for render JS** | The `slang-render.js` script has no automated tests. A jsdom-based test suite covering the three compilers would catch regressions.   | Medium   |
| **Build copies stale dist/**    | `esbuild.mjs` copies files at `onEnd`, but the `src/dist/` directory can get out of sync with `src/core/webview/` during development. | Medium   |

### Flow Metadata

| Gap               | Description                                                                                                          | Priority |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | -------- |
| **Icon registry** | `iconToEmoji()` is a hardcoded map. A user-extensible registry (e.g. custom icon keys → SVG) would be more flexible. | Low      |

---

## Review Findings (2026-06-11)

Findings from a review of this document against the live source. Doc-only factual errors have been corrected inline above.

### Code / Design Issues — All Resolved

| #   | Severity | Status      | Issue & resolution                                                                                                                                                                                                                 |
| --- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | ✅ Resolved | **Live refresh destroyed all webview interaction state.** Every `onDidChangeTextDocument` reassigned `webviewPanel.webview.html`. Fixed: HTML built once; subsequent edits `postMessage` a payload; listener patches SVG in place. |
| 2   | Medium   | ✅ Resolved | **No debounce on re-render.** Fixed: `onDidChangeTextDocument` debounces at `RENDER_DEBOUNCE_MS = 250`.                                                                                                                            |
| 3   | Low      | ✅ Resolved | **CSP nonce used `Math.random()`.** Fixed: `makeNonce()` uses `crypto.randomBytes(16).toString("base64")`.                                                                                                                         |
| 4   | Low      | ✅ Resolved | **Dead `.dtvis` reference** in header comment. Fixed.                                                                                                                                                                              |
| 5   | Low      | ✅ Resolved | **Render script inlined by string concatenation.** Fixed: `slang-render.js` loaded via `<script src="…webview-uri…">`.                                                                                                             |

> **Verification (2026-06-11):** TypeScript compiles with no new errors; [`dist_assets.spec.ts`](../src/__tests__/dist_assets.spec.ts)
> (40 tests) passes. Note the **"No unit tests for render JS"** gap above still stands.

### Doc Inaccuracies Corrected Inline

| Location                   | Was                                                       | Now                                                                                               |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Related-documents links    | `todos/slang_specs.md`, `todos/workflow_design.md`        | `slang_specs.md`, `workflow_design.md` (siblings in `docs/`)                                      |
| Architecture / "providers" | "Two providers exist" but table listed one                | A single provider exists                                                                          |
| Line counts                | `slang-render.js` "1299"/"1533"; `slang-render.css` "352" | Line counts updated                                                                               |
| `_currentView` persistence | "survives re-renders within the same webview session"     | Now accurate: survives both tab switches AND document-change re-renders (edits via `postMessage`) |

### Launcher Metadata Parity

The workflow launcher ([`LauncherView.tsx`](../webview-ui/src/components/launcher/LauncherView.tsx)) renders the same rich metadata the Slang custom editor visualizes. The icon map in the webview mirrors the editor's `iconToEmoji()` map; both should be kept in sync.

---

## Session Changes (2026-06-12)

### WorkflowView decomposition

Decoupled the flow header metadata from the srcdoc iframe:

- [`WorkflowVizMeta`](../packages/types/src/vscode-extension-host.ts) interface carries flow metadata separate from diagram HTML.
- [`buildWorkflowVizMeta()`](../src/core/workflow/WorkflowTask.ts) extracts metadata from parsed AST.
- [`TaskHeader`](../webview-ui/src/components/chat/TaskHeader.tsx) renders metadata natively alongside token/cost/context info.
- Iframe is diagram-only; view switches use `postMessage("switchView")` instead of srcdoc rebuilds.
- Theme CSS variables injected from parent document into srcdoc.

### Dual-mode rendering

`handleRender()` now uses `payload.context === "workflowView"` to switch between full standalone rendering (`.slang` editor) and diagram-only rendering (WorkflowView iframe).

### Runtime-aware diagrams

- **Topology**: Active edges (matched via `sendingTo`/`waitingFor`) get pulsing animation.
- **Sequence**: Timeline built from `mailboxHistory` (runtime) with static AST fallback. Pending sends shown as dashed entries. Arrow tooltips show tokens/cost/duration.
- **Swimlane**: Operation block matching agent `opIndex` is marked with a ▶ arrow in the gutter (replacing the earlier `.flow-executing` colored-fill highlight).

### Mailbox history

- `FlowState.mailboxHistory: MailboxEntry[]` accumulates all mailbox entries across rounds.
- `MailboxEntry` enriched with `tokensUsed`, `costUsd`, `durationMs`, `mode` from child task results.
- Persisted via `serializeFlowState`/`deserializeFlowState` through `persistCheckpoint()`.
- Survives VS Code restarts; backward-compatible with old checkpoints.
