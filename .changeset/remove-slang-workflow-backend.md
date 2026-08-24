---
"shofer": minor
"@shofer/types": minor
"@shofer/core": minor
---

Remove the in-editor Slang workflow backend.

Shofer no longer executes `.slang` flows. `WorkflowTask` and its slang loop, the bundled
TypeScript Slang engine (lexer, parser, resolver, interpreter, output contracts, tag
algebra), `.slang` discovery from `.shofer/workflows/` and `~/.shofer/workflows/`, the
`.slang` custom editor, the workflow launcher and the workflow visualization views are all
gone. Shofer runs tasks — one agent at a time, with the subtasks it spawns — and the task
tree, its diagrams, the Stats breakdown and the Logs stream are unchanged.

Removed public surface:

- `ShoferExtensionApi.createWorkflow()` and `.discoverWorkflows()`.
- The `workflows` plugin contribution kind (`contributes.workflows`,
  `permissions.workflows`). A plugin can no longer ship a flow; the bundled
  `builtin-config` plugin now contributes only the six default modes.
- The `HistoryItem` fields `isWorkflow`, `slangSource` and `flowState`, and the
  corresponding fields in the JSON task export.
- The `shofer.slangEditor` custom editor.

Per-task shaping options on `Task` — `completionSchema`, `agentRole`, `agentToolGroups`
and `agentContext` — are unaffected; `completionSchema` remains reachable from a plugin via
`ctx.agent.spawn({ completionSchema })`.
