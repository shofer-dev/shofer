# Commands & Skills Quick-Access Buttons

## Status: Implemented (3.66.13)

Components:
[`CommandsButton.tsx`](webview-ui/src/components/chat/CommandsButton.tsx),
[`SkillsButton.tsx`](webview-ui/src/components/chat/SkillsButton.tsx)

Backend:
[`Task.ts:449`](src/core/task/Task.ts:449) — loadedSkills tracking,
[`SkillsTool.ts`](src/core/tools/SkillsTool.ts) — reload no-op,
[`skillsMessageHandler.ts`](src/core/webview/skillsMessageHandler.ts) — IPC

Tests:
[`CommandsButton.spec.tsx`](webview-ui/src/components/chat/__tests__/CommandsButton.spec.tsx),
[`SkillsButton.spec.tsx`](webview-ui/src/components/chat/__tests__/SkillsButton.spec.tsx),
[`skillsTool.spec.ts`](src/core/tools/__tests__/skillsTool.spec.ts),
[`skillsMessageHandler.spec.ts`](src/core/webview/__tests__/skillsMessageHandler.spec.ts)

i18n: [`quickAccess.json`](webview-ui/src/i18n/locales/en/quickAccess.json)
Docs: [`skills.md`](skills.md), [`native_tools.md`](native_tools.md)

## Problem

Currently, the only way to discover and invoke slash commands and skills is:

1. **Type `/` in the chat input** — activates the slash-command-aware autocomplete (ContextMenu)
2. **Navigate to Settings → Slash Commands / Skills** — view the full list but can't invoke from there

Neither approach provides a quick, discoverable way to browse available commands and skills and insert them into the chat input for execution.

## Solution

Two compact chip buttons in the chat input bar, placed after WorktreeStatusIndicator:

```
┌──────────────────────────────────────────────────────────────────┐
│ [Mode ▼] [API Config ▼] [Auto ▼] [🌿 worktree ▼] [⚡ ▼] [🎓 ▼]     │
│                                                                  │
│ Type your message...                              [Send]         │
└──────────────────────────────────────────────────────────────────┘
```

- **⚡ Commands button** — lists all available slash commands
- **🎓 Skills button** — lists all available skills

## User Flow

1. User clicks the **⚡ Commands** button
2. Popover appears with header "Slash Commands" + gear icon (→ Settings), grouped by source:
    ```
    ┌──────────────────────────────────┐
    │ ⚡ Slash Commands          ⚙     │
    │                                  │
    │ 📁 PROJECT COMMANDS              │
    │ /commit     Commit in separate…  │
    │ /merge-work.. Merge a worktree…  │
    │ /logs       Annotate recent…     │
    │                                  │
    │ 🌐 GLOBAL COMMANDS               │
    │ /init       Initialize a new…    │
    └──────────────────────────────────┘
    ```
3. User clicks a command (e.g., `/commit`)
4. The slash command is **appended** to the chat text area via `insertTextIntoTextarea`
5. The popover closes
6. User reviews the command and clicks **Send** to execute
7. The command is **not** auto-executed — user always confirms

Same flow for the **🎓 Skills** button.

## Design Details

### Commands Button

| Property         | Value                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Component        | [`CommandsButton.tsx`](extensions/shofer/webview-ui/src/components/chat/CommandsButton.tsx)                      |
| Icon             | `Zap` (Lucide) + `ChevronDown` (Lucide)                                                                          |
| Tooltip          | "Slash Commands — click to browse and insert"                                                                    |
| Hidden when      | No commands available (`commands.length === 0`)                                                                  |
| Popover header   | "Slash Commands" + gear settings button (navigates to Settings → Slash Commands)                                 |
| Popover width    | `min-w-56 max-w-72`                                                                                              |
| Grouping         | By source: Project (`FolderGit2`), Global (`Globe`), Built-in (`Wrench`)                                         |
| Each item shows  | Command name as `/name` in monospace, description (truncated), open-file button (on hover, if `filePath` exists) |
| Click behavior   | Appends `/command-name ` (or `/command-name <argumentHint>` if present) via `insertTextIntoTextarea`             |
| Open-file button | `ExternalLink` icon on hover, sends `{ type: "openFile", text: filePath }`                                       |
| Max height       | 400px with scroll                                                                                                |

**Command data** (from [`Command`](extensions/shofer/packages/types/src/vscode-extension-host.ts:440)):

```typescript
interface Command {
	name: string // e.g., "commit"
	source: "global" | "project" | "built-in"
	filePath?: string
	description?: string // e.g., "commit in separate commits"
	argumentHint?: string // e.g., "<phone>"
}
```

### Skills Button

| Property         | Value                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component        | [`SkillsButton.tsx`](webview-ui/src/components/chat/SkillsButton.tsx)                                                                                     |
| Icon             | `GraduationCap` (Lucide) + `ChevronDown` (Lucide)                                                                                                         |
| Tooltip          | "Skills — click to browse and insert"                                                                                                                     |
| Hidden when      | No skills available (`skills.length === 0`)                                                                                                               |
| Popover header   | "Skills" + gear settings button (navigates to Settings → Skills)                                                                                          |
| Popover width    | `min-w-72 max-w-96` (wider than Commands to accommodate description)                                                                                      |
| Grouping         | **Loaded skills** (✓ checkmark, green), then unloaded by mode: "All Modes" (`Globe` icon), per-mode groups (`FolderGit2` icon), all sorted alphabetically |
| Each item shows  | Source badge (or ✓ for loaded), skill name on first line, description (truncated) on second line, open-file button on hover                               |
| Click behavior   | Inserts `Use the <skill-name> skill` via `insertTextIntoTextarea`                                                                                         |
| Open-file button | `ExternalLink` icon on hover, sends `{ type: "openFile", text: skill.path }`                                                                              |
| Max height       | 400px with scroll                                                                                                                                         |
| Loaded tracking  | `loadedSkills: Record<string,string>` from `useExtensionState()`, updated via `skills` IPC message                                                        |

### Loaded Skills Tracking

Each `Task` maintains a `loadedSkills: Map<string,string>` (skill name → SKILL.md path):

- **On load**: `SkillsTool` records the skill after successful `skills` invocation
- **Reload is a no-op**: Returns `"Skill 'X' is already loaded (no-op)."` — no file re-read
- **Cleared on condense**: All 3 context-condensation paths clear `loadedSkills`
- **IPC**: `handleRequestSkills` includes `loadedSkills` in the skills message
- **UI**: `SkillsButton` shows loaded skills first with a green ✓ checkmark

### `/loaded` and `/search` Slash Commands

Two new built-in slash commands:

| Command              | Description                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/loaded`            | Lists currently loaded skills for the task (name + description)                                                               |
| `/search <keywords>` | Searches SKILL.md files — RAG semantic search via `rag_search` scoped to `.shofer/skills`, falling back to `grep_search` grep |

**Skill data** (from [`SkillMetadata`](extensions/shofer/packages/types/src/skills.ts:5)):

```typescript
interface SkillMetadata {
	name: string // e.g., "eauction-search"
	description: string // e.g., "Search for properties on eauction.gr"
	path: string // Absolute path to SKILL.md
	source: "global" | "project"
	mode?: string // @deprecated — use modeSlugs
	modeSlugs?: string[] // Mode slugs where available (empty = all modes)
}
```

### How Skills Are Inserted

When a skill is clicked, the text `Use the <skill-name> skill` is appended to the chat input. This natural-language instruction prompts the model to invoke the `skills` tool to load the skill into context.

No `use_skill` slash command is used — skills are invoked by the model's tool-calling mechanism.

### Settings Navigation

Both popovers include a gear icon (⚙) button in the header that navigates to the relevant Settings section:

- Commands → `Settings → Slash Commands` tab
- Skills → `Settings → Skills` tab

### Interaction with Existing ContextMenu

The commands/skills buttons do **not** replace the existing ContextMenu (slash-autocomplete when typing `/` in chat). They are complementary:

| Feature         | Entry                | When                            |
| --------------- | -------------------- | ------------------------------- |
| ContextMenu     | Type `/` in chat     | Discovery while typing          |
| Commands button | Click ⚡ in bar      | Browsing all available commands |
| Skills button   | Click 🎓 in bar      | Browsing all available skills   |
| Settings        | Gear icon in popover | Managing/create/delete          |

### Button Behavior

- **No active task**: Always visible (if commands/skills exist)
- **Active task running**: Always visible — buttons are always enabled regardless of task state
- **Empty state**: Hidden (`return null`) when no commands/skills exist

### Technical Implementation

#### Components

1. **`CommandsButton.tsx`** — chip button + inline popover (no shared list component)
2. **`SkillsButton.tsx`** — chip button + inline popover (no shared list component)
3. No `SearchableItemList.tsx` shared component — search/filtering not yet implemented

#### Data Flow

```
Extension ──▶ Webview
  state.commands:   Command[]      (via ExtensionStateContext)
  state.skills:     SkillMetadata[] (via ExtensionStateContext)
  state.customModes: ModeConfig[]   (via ExtensionStateContext, for mode name lookup)
```

Both components call `vscode.postMessage({ type: "requestCommands" })` / `vscode.postMessage({ type: "requestSkills" })` on mount to ensure data freshness.

#### Layout Integration

In [`ChatTextArea.tsx`](extensions/shofer/webview-ui/src/components/chat/ChatTextArea.tsx:1341-1342):

```tsx
<div className="flex items-center gap-2">
    <ModeSelector ... />
    <ApiConfigSelector ... />
    <AutoApproveDropdown ... />
    <WorktreeStatusIndicator />
    <CommandsButton />
    <SkillsButton />
</div>
```

#### Appending to Chat Input

```typescript
// Commands: inserts slash command with optional argumentHint
const text = command.argumentHint ? `/${command.name} ${command.argumentHint}` : `/${command.name} `
vscode.postMessage({ type: "insertTextIntoTextarea", text })

// Skills: inserts natural-language instruction
const text = `Use the ${skill.name} skill`
vscode.postMessage({ type: "insertTextIntoTextarea", text })
```

### Handling the `argumentHint`

When a command has an `argumentHint` field (e.g., `<phone>`):

- The hint placeholder is appended after the command name: `/name <argumentHint>`
- The user can then select and replace the placeholder before sending

### i18n

Keys in [`quickAccess.json`](extensions/shofer/webview-ui/src/i18n/locales/en/quickAccess.json):

| Key                                    | Value                                         |
| -------------------------------------- | --------------------------------------------- |
| `quickAccess:commands.tooltip`         | "Slash Commands — click to browse and insert" |
| `quickAccess:commands.title`           | "Slash Commands"                              |
| `quickAccess:commands.projectCommands` | "Project Commands"                            |
| `quickAccess:commands.globalCommands`  | "Global Commands"                             |
| `quickAccess:commands.builtInCommands` | "Built-in Commands"                           |
| `quickAccess:commands.noCommands`      | "No commands available"                       |
| `quickAccess:commands.settings`        | "Manage commands in Settings"                 |
| `quickAccess:skills.tooltip`           | "Skills — click to browse and insert"         |
| `quickAccess:skills.title`             | "Skills"                                      |
| `quickAccess:skills.allModes`          | "All Modes"                                   |
| `quickAccess:skills.loaded`            | "Loaded"                                      |
| `quickAccess:skills.noSkills`          | "No skills available"                         |
| `quickAccess:skills.settings`          | "Manage skills in Settings"                   |

## Resolved Questions

1. **Buttons when task is active**: Always visible and enabled — no disabled/reduced-opacity state for active tasks.

2. **How skills are invoked**: Skills insert a natural-language instruction (`Use the <skill-name> skill`). The model then uses its `skills` tool-calling mechanism. No `use_skill` slash command was added.

3. **Popover search**: Not yet implemented — left as a future enhancement.

4. **Keyboard shortcuts**: Not implemented — future enhancement.

5. **Auto-close popover**: Yes — popover closes after inserting command/skill into chat input.

6. **Grouping by mode for skills**: Implemented — "All Modes" group for unrestricted skills (Globe icon), then per-mode groups sorted alphabetically using mode name from `customModes` lookup (FolderGit2 icon).

## Implementation Checklist

### Frontend (Webview)

- [x] Create `CommandsButton.tsx` component

    - [x] Load commands from `useExtensionState().commands`
    - [x] Group by source (project, global, built-in) with Lucide icons
    - [x] Render popover with header (title + gear icon) and grouped list
    - [x] Handle click → `insertTextIntoTextarea` with `/command-name ` or `/command-name <argumentHint>`
    - [x] Handle argumentHint placeholder insertion
    - [x] Handle empty state (hidden when no commands)
    - [x] Settings navigation via gear icon

- [x] Create `SkillsButton.tsx` component

    - [x] Load skills from `useExtensionState().skills`
    - [x] Load customModes for mode name lookup
    - [x] Group by mode restriction (all modes, per-mode sorted alphabetically)
    - [x] Render popover with header (title + gear icon) and grouped list
    - [x] Handle click → `insertTextIntoTextarea` with `Use the <skill-name> skill`
    - [x] Handle empty state (hidden when no skills)
    - [x] Settings navigation via gear icon

- [x] Add buttons to `ChatTextArea.tsx`

    - [x] Import new components
    - [x] Place after `WorktreeStatusIndicator`
    - [~] Pass `disabled` prop based on task state — not implemented; buttons always enabled

- [x] Add i18n keys
    - [x] Create `quickAccess.json` locale file (en)
    - [x] Add keys for tooltips, titles, group labels, empty states, settings

### Backend (Extension)

- [~] (Not needed) Add `use_skill` built-in slash command — not implemented; skills use natural-language fallback
- [x] Verify `commands` and `skills` are always up-to-date in extension state
    - [x] `requestCommands` called on CommandsButton mount
    - [x] `requestSkills` called on SkillsButton mount

### Tests

- [x] `CommandsButton.spec.tsx` — render, grouping, click insertion, empty state
- [x] `SkillsButton.spec.tsx` — render, grouping by mode, click insertion, empty state
- [~] `ChatTextArea.spec.tsx` — verify new buttons rendered in correct position

### Implemented in 3.66.13

- [x] **Loaded skills tracking**: `loadedSkills` Map on Task, reload no-op, auto-clear on condense
- [x] **Loaded/Unloaded split in SkillsButton**: Loaded skills shown first with ✓, unloaded sorted alphabetically
- [x] **`loadedSkills` in IPC**: Included in skills message response from `handleRequestSkills`

### Future Enhancements

- [ ] Search/filter within popover lists (fuzzy matching)
- [ ] Keyboard shortcuts for quick access
- [ ] Task-state-aware button behavior (disable/hide during active tasks if desired)
- [ ] `use_skill` built-in slash command for explicit skill invocation
