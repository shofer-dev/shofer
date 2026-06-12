# Built-in Workflows

This document describes the Source-of-Truth (SoT) chain for the two built-in
workflows in the Shofer VS Code extension: **Debug** and **Implement a Feature**.
It covers where each workflow is defined in `.slang` source, how they are
discovered alongside user and project workflows, and how they are launched.

> **Content note:** This document describes the _infrastructure_ — file
> locations, discovery, validation, and launch. The actual workflow
> specifications (phases, agents, parameters, budgets) live in the `.slang`
> files themselves. For the `WorkflowTask` executor architecture, mode mapping,
> UI integration, public API, and persistence, see
> [`workflow_design.md`](workflow_design.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Primary Definition: `.slang` Files](#2-primary-definition-slang-files)
3. [Workflow Discovery: `discoverWorkflows()`](#3-workflow-discovery-discoverworkflows)
4. [Workflow Launch: `createWorkflow` IPC Handler](#4-workflow-launch-createworkflow-ipc-handler)
5. [File Index](#5-file-index)

---

## 1. Overview

The SoT chain for built-in workflows is a linear pipeline from `.slang` source
files through discovery, validation, and task creation:

```
.slang files  (src/media/workflows/*.slang   ← built-in, lowest priority)
              (~/.shofer/workflows/*.slang   ← global, medium priority)
              (.shofer/workflows/*.slang     ← project, highest priority)
    │
    └── discoverWorkflows(workspacePath)
        │  (src/core/workflow/WorkflowTask.ts:1340)
        │
        ├── loadFromDir(builtinDir)   → built-in workflows
        ├── loadFromDir(globalDir)    → global user workflows
        └── loadFromDir(projectDir)   → project workflows
            │
            ▼
        Map<string, string>  (flow name → slang source)
            │
            ├── "listWorkflows" IPC   → parsed metadata → LauncherView cards
            │
            └── "createWorkflow" IPC  → createWorkflowTask() → WorkflowTask
```

Workflows are **orthogonal to modes**. The Workflow Task has no mode — its
mode string is the flow name (e.g. `"debug"`). Modes apply to the **agent
Tasks** that the Workflow spawns, giving them their system prompt, API
configuration, model, and tool access. See [`workflow_design.md`](workflow_design.md)
for the full executor architecture and mode mapping.

---

## 2. Primary Definition: `.slang` Files

The two built-in workflows, with their machine names (`flow` name) and
human-readable metadata declared in the `.slang` source:

| #   | Flow Name           | Title               | Description                                                                                                                                                         | Icon     | Source                                                                                          |
| --- | ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 1   | `debug`             | Collaborative Debug | Two developers independently triage, converge on root cause through peer review, get user sign-off, then one fixes and the other reviews.                           | `bug`    | [`src/media/workflows/debug.slang`](../src/media/workflows/debug.slang)                         |
| 2   | `implement-feature` | Implement a Feature | Multi-agent feature implementation pipeline. Architect orchestrates exploration, design approval, implementation, and review with Developer + Reviewer specialists. | `wrench` | [`src/media/workflows/implement-feature.slang`](../src/media/workflows/implement-feature.slang) |

### 2.1 File Locations & Override Precedence

| Priority    | Directory                                         | Scope                   |
| ----------- | ------------------------------------------------- | ----------------------- |
| 1 (lowest)  | [`src/media/workflows/`](../src/media/workflows/) | Built-in (shipped)      |
| 2           | `~/.shofer/workflows/`                            | Global (per-user)       |
| 3 (highest) | `.shofer/workflows/`                              | Project (per-workspace) |

Higher-priority directories **override** lower-priority ones by name — if a
project has `.shofer/workflows/debug.slang`, it completely replaces the built-in
`debug` workflow. There is no partial merging of agent declarations or
parameters.

### 2.2 Workflow Structure

Each `.slang` file contains exactly one `flow` declaration with optional
`title`, `description`, and `icon` meta fields, plus one or more `agent` blocks.
The `flow` name serves as the machine identifier; `title` provides the
human-readable label shown in the UI. The AST types are defined in
[`slang-ast.ts`](../src/core/workflow/slang-ast.ts) — `FlowDecl` carries
`name`, `params`, `title`, `description`, `icon`, and `body`; each `AgentDecl`
carries `meta` (with `role`, `model`, `tools`, `retry`, `peers`) and
`operations`.

For the full language specification, see [`slang_specs.md`](slang_specs.md).

---

## 3. Workflow Discovery: `discoverWorkflows()`

**File:** [`src/core/workflow/WorkflowTask.ts`](../src/core/workflow/WorkflowTask.ts:1340-1367)

The single entry point for workflow discovery. Returns a `Map<string, string>`
of flow name → `.slang` source content. Priority order (lowest to highest):

1. **Built-in** — `dist/media/workflows/` (shipped with the extension, loaded from `__dirname/../../media/workflows`)
2. **Global** — `~/.shofer/workflows/` (per-user)
3. **Project** — `.shofer/workflows/` (per-workspace, highest priority)

Each directory is loaded by the private helper [`loadFromDir()`](../src/core/workflow/WorkflowTask.ts:1354), which reads
all `.slang` files and inserts them into the map keyed by filename minus the
`.slang` extension. Later layers overwrite earlier ones on name collision.

**Barrel export:** [`src/core/workflow/index.ts`](../src/core/workflow/index.ts:44)

### 3.1 Validation

**File:** [`src/core/workflow/validate-slang.ts`](../src/core/workflow/validate-slang.ts:39)

`validateSlangProgram(source)` parses a `.slang` source string and runs static
analysis (`validateSlangAST`). Returns a `SlangValidationResult` with:

| Field              | Type       | Description                                     |
| ------------------ | ---------- | ----------------------------------------------- |
| `valid`            | `boolean`  | `true` when there are no errors                 |
| `errors`           | `string[]` | Parse-level errors (syntax, lexer)              |
| `structuralErrors` | `string[]` | Structural errors (unknown agent refs, etc.)    |
| `warnings`         | `string[]` | Analysis warnings (missing converge, deadlocks) |

This is called by the Slang editor provider and the `listWorkflows` handler
to surface diagnostics before execution.

---

## 4. Workflow Launch: `createWorkflow` IPC Handler

**File:** [`src/core/webview/webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts:4254-4277, 4279-4319)

Two IPC message types govern the workflow lifecycle:

### 4.1 `listWorkflows`

The webview requests the list of discovered workflows. The handler:

1. Calls `discoverWorkflows(provider.cwd)` to get all `.slang` sources.
2. Parses each source with `parseSlang()` and reads `ast.flows[0]` to extract the
   full launcher metadata: `name` (machine id), `title` (falls back to `name`),
   `description`, `icon`, `agents` (the `AgentDecl` names in the flow body), and
   `params` (each `{ name, type, description }`). Unparseable `.slang` files fall
   back to `{ name, title: name, description: "", icon: undefined, agents: [], params: [] }`.
3. Posts a `workflowsList` message with that `{ name, title, description, icon, agents, params }[]`
   array — this is what populates the LauncherView cards (title, description, icon,
   agent list), not just `{ name, params }`.

### 4.2 `createWorkflow`

The user picks a workflow card → the handler:

1. Re-discovers workflows to get the latest `.slang` source.
2. Creates a [`WorkflowTask`](../src/core/workflow/WorkflowTask.ts) via
   [`createWorkflowTask()`](../src/core/workflow/WorkflowTask.ts:1249).
3. Pops the current task to the background (parallel execution) without
   aborting it.
4. Pushes the `WorkflowTask` onto the stack and starts it.
5. Posts `chatButtonClicked` + `focusInput` to navigate the webview.

---

## 5. File Index

| File                                                                                                            | Role                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`src/media/workflows/debug.slang`](../src/media/workflows/debug.slang)                                         | Built-in Debug workflow `.slang` source                                                                               |
| [`src/media/workflows/implement-feature.slang`](../src/media/workflows/implement-feature.slang)                 | Built-in Implement a Feature workflow `.slang` source                                                                 |
| [`src/core/workflow/WorkflowTask.ts`](../src/core/workflow/WorkflowTask.ts)                                     | `WorkflowTask` class, `slangLoop()`, `discoverWorkflows()`, `createWorkflowTask()`, `createWorkflowTaskFromHistory()` |
| [`src/core/workflow/index.ts`](../src/core/workflow/index.ts)                                                   | Barrel export for the workflow module                                                                                 |
| [`src/core/workflow/slang-ast.ts`](../src/core/workflow/slang-ast.ts)                                           | AST type definitions (`FlowDecl`, `AgentDecl`, `AgentMeta`, `Operation`, etc.)                                        |
| [`src/core/workflow/slang-parser.ts`](../src/core/workflow/slang-parser.ts)                                     | Public API — `parseSlang()`, `validateSlangAST()`                                                                     |
| [`src/core/workflow/slang-parser-upstream.ts`](../src/core/workflow/slang-parser-upstream.ts)                   | Vendored parser from `@riktar/slang` (MIT)                                                                            |
| [`src/core/workflow/slang-lexer.ts`](../src/core/workflow/slang-lexer.ts)                                       | Lexer (vendored)                                                                                                      |
| [`src/core/workflow/slang-resolver.ts`](../src/core/workflow/slang-resolver.ts)                                 | Dependency graph, deadlock detection, static analysis warnings                                                        |
| [`src/core/workflow/slang-types.ts`](../src/core/workflow/slang-types.ts)                                       | Runtime state types (`FlowState`, `AgentState`, `MailboxEntry`) + serialization                                       |
| [`src/core/workflow/validate-slang.ts`](../src/core/workflow/validate-slang.ts)                                 | `validateSlangProgram()` — parse + validate in one call                                                               |
| [`src/core/workflow/wait-for-task-helper.ts`](../src/core/workflow/wait-for-task-helper.ts)                     | Shared event-driven wait helper (used by both `WaitForTaskTool` and `WorkflowTask.waitForStakes`)                     |
| [`src/core/webview/webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts)                     | `listWorkflows` and `createWorkflow` IPC handlers                                                                     |
| [`src/core/webview/ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts)                                   | `createTask()` — spawns agent Tasks with `initialMode`; `_restoreWorkflowTask()`                                      |
| [`src/core/webview/SlangEditorProvider.ts`](../src/core/webview/SlangEditorProvider.ts)                         | Custom editor for `.slang` files (opens as editor tab)                                                                |
| [`src/extension/api.ts`](../src/extension/api.ts)                                                               | Public API — `ShoferAPI.discoverWorkflows()`, `ShoferAPI.createWorkflow()`                                            |
| [`src/activate/registerCommands.ts`](../src/activate/registerCommands.ts)                                       | `+` button → QuickPick (New Task / New Workflow)                                                                      |
| [`packages/types/src/history.ts`](../packages/types/src/history.ts)                                             | `HistoryItem` extensions: `isWorkflow`, `slangSource`, `flowState`                                                    |
| [`webview-ui/src/components/launcher/LauncherView.tsx`](../webview-ui/src/components/launcher/LauncherView.tsx) | Workflow launcher UI — lists discovered `.slang` workflows as launchable cards                                        |
| [`webview-ui/src/components/chat/WorkflowView.tsx`](../webview-ui/src/components/chat/WorkflowView.tsx)         | Dedicated workflow chat surface — mirrors ChatView for WorkflowTasks                                                  |
| [`webview-ui/src/components/chat/TaskSelector.tsx`](../webview-ui/src/components/chat/TaskSelector.tsx)         | Workflow-aware task tree (codicon-organization icon, "Workflow: name" titles)                                         |
| [`webview-ui/src/components/chat/ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)                 | Defers to WorkflowView when `currentTaskItem.isWorkflow`                                                              |
| [`docs/workflow_design.md`](workflow_design.md)                                                                 | Workflow abstraction design — architecture, Slang→Shofer mapping, executor design                                     |
| [`docs/slang_specs.md`](slang_specs.md)                                                                         | Slang language reference — grammar, operations, semantics, pitfalls                                                   |
| [`docs/built-in-modes.md`](built-in-modes.md)                                                                   | Built-in modes SoT — how agent Tasks get their system prompt, tools, and API configuration                            |
