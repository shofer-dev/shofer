# AGENTS.md — rules for `webview-ui`

Rules specific to the React webview bundle (ChatView, SettingsView, task-state
rendering). The repo-root [`AGENTS.md`](../AGENTS.md) applies in full — in
particular the rules that _span_ the webview↔host bridge (Webview Message
Routing, Exhaustive Switch, Shared Module Isolation, i18n) stay there. The
sibling `CLAUDE.md` is a symlink to this file.

## SettingsView

- Settings View Pattern: When working on `SettingsView`, inputs must bind to the local `cachedState`, NOT the live `useExtensionState()`. The `cachedState` acts as a buffer for user edits, isolating them from the `ContextProxy` source-of-truth until the user explicitly clicks "Save". Wiring inputs directly to the live state causes race conditions. See [`docs/settings_overlay.md`](../docs/settings_overlay.md) for the full settings storage and merge architecture.

    - **Everything modifiable in Settings (and its panels) MUST be save-gated.** A control's `onChange`/`onValueChange`/`onClick` must NOT `vscode.postMessage(...)` to apply a setting value immediately — that bypasses Save (the change persists without Save and the Save button never lights up). Instead **stage** the change and let `handleSubmit` (the Save button) persist it:
        - For fields in `cachedState`: call `setCachedStateField(key, value)` (it flips change-detection automatically) and ensure the field is included in `handleSubmit`'s `updateSettings` payload.
        - For settings that don't live in `cachedState` (e.g. the default API config → `pendingDefaultConfigName`; per-mode text/tool-groups/API-config → `ModesView`'s `modeOverrides`/`pendingModeGroups`/`pendingModeApiConfig`; code-index secrets; MCP per-tool enablement; plugin enable/AI-consent → `PluginsSettings`' pending maps; node-pool policy/enable → `ShoferWorkersSettings`' pending buffers): stage into a dedicated pending buffer, fire an `onDirty`/`setChangeDetected(true)` callback so Save enables, and apply the change from `handleSubmit` (directly, or via an imperative `commit*()` handle the parent calls on Save — and a matching `discard*()` on Discard). Never apply on change.
        - **Profile activation/selection is NOT exempt.** Making a profile the default is save-gated through `pendingDefaultConfigName` → `setDefaultApiConfiguration` on Save; the edit-dropdown's `loadApiConfigurationForEdit` is allowed on-change only because it is a pure load (nothing persists or activates host-side). Do not add any Settings control that posts `loadApiConfiguration`/`loadApiConfigurationById` (immediate activation) on change.
            - **Default profile vs. current profile — a deliberate, load-bearing distinction (do not "unify" it).** There are THREE separate concepts, and conflating them is a recurring misread:
                1. **Default profile** — a **name-only** global setting (Settings → Providers), persisted. It is the fallback for a **new Task** whose Mode does not link a provider. Changing it must NOT touch any live `apiConfiguration` (hence `setDefaultApiConfiguration` is name-only, above).
                2. **Current profile** — the **per-Task**, **in-memory** active config (the per-task provider dropdown; per-task overrides ride on `CreateTaskInput.apiConfiguration`). Resolved at task start as **Mode → API-config link, else the default profile**, and changeable per-task.
                3. **Mode → API Configuration link** (Settings → Modes → API Configuration, `modeApiConfigs`) — a per-mode provider assignment, persisted.
                   So `ContextProxy`'s live `apiConfiguration` (the _current_ profile) legitimately differs from the blob's default-profile name — that divergence is **by design, not a bug to reconcile.** Persisted profile data (all profiles' settings + secrets, the default name, mode links) is the blob/`settings.json`; the _current_ selection is in memory. Do NOT make the default dropdown an activation to "fix" the divergence.
        - Settings must not change chat state either: the Modes tab's mode dropdown selects which mode is being _edited_ (local `visualMode` only) and MUST NOT post a `"mode"` message — switching the active mode is the chat mode-selector's job. The converse also holds: `visualMode` tracks the active mode only until the user picks an edit target (`editTargetPinned`), after which an active-mode change from chat or `switch_mode` must not move them off the form they are editing.
        - Exempt (not setting-values): action buttons (import/export/reset, test/refresh, open links); _structural_ list management with its own explicit affordance — create/delete/rename of API-config profiles, custom modes, remote nodes, skills, slash commands (delete additionally confirms via dialog; pin lives in the chat UI, not Settings); and inherently-immediate VS Code settings (`updateVSCodeSetting`). When in doubt, save-gate it.

## ChatView

- Webview Send-Path Rule: [`ChatView.handleSendMessage`](src/components/chat/ChatView.tsx) MUST NOT post a bare `askResponse: "messageResponse"` without a confirmed pending ask (`shoferAskRef.current` set). When the user types in an ongoing task with no ask awaiting, route through `queueMessage` so the next `Task.ask()` drains it. The host-side `prependMessage` fallback in `handleWebviewAskResponse` is a defensive backstop, not a contract. See [`docs/message_queue.md`](../docs/message_queue.md).

- ChatView Draft-Snapshot Audit Rule: When modifying `ChatView`'s input state (`inputValue`, `selectedImages`, `droppedContextFiles`) or their refs (`inputValueRef`), or `handleChatReset` / the task-id `useEffect`, re-audit the per-Task draft snapshot/restore flow. Invariant: on a task switch, the outgoing task's input is snapshotted into `taskDraftsRef` BEFORE the incoming task's draft is restored. Clearing `inputValue` before the `useEffect` fires, or mutating `taskDraftsRef` so the `useEffect` snapshots stale state, breaks this. See [`docs/message_queue.md`](../docs/message_queue.md) §"Per-Task input drafts".

## Task-state rendering

- Single UI Source-of-Truth Rule: UI components must resolve task state via the fixed fallback chain `runtime?.state ?? item.taskState ?? IDLE_TASK_STATE`. The runtime overlay (live `ManagedTask`) always wins; persisted state is only a fallback when no live instance exists. Use `resolveStateVisual` in [`TaskSelector.tsx`](src/components/chat/TaskSelector.tsx) for any state-dependent rendering — never branch on lifecycle/rating directly in component code.

- Uniform Rendering Rule: Visual indicators for state-like enums must go through a single mechanism (all task-state icons render via `<span class="codicon …">` with the `LIFECYCLE_VISUAL` + `RATING_VISUAL` overlay tables). Do not add per-value `<svg>` special cases. New variants go in the lookup tables, not branched at the call site.

## Component primitives

- Radix `asChild` Trigger Rule: A Radix trigger primitive (`PopoverTrigger`, `DialogTrigger`, `TooltipTrigger`, `DropdownMenuTrigger`) with `asChild` MUST have as its **immediate** child the interactive element owning the ref + DOM handlers (typically `<Button>`), NOT a wrapper like `StandardTooltip` that doesn't forward refs. Working pattern: `<StandardTooltip><PopoverTrigger asChild><Button …/></PopoverTrigger></StandardTooltip>` (see [`IndexingStatusBadge.tsx`](../plugins/rag-indexing/ui/status.tsx)). The inverted layout silently breaks click-to-open because Radix clones the wrapper, not the button. A popover wrapper component MUST NOT bake `PopoverTrigger asChild` around `{children}` internally — leave trigger placement to the caller (cf. [`CodeIndexPopover`](../plugins/rag-indexing/ui/settings.tsx)).
