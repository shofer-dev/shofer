# Shofer Skills System

## Overview

Shofer implements a **lazy-loading skill system** — only skill metadata (name, description, location) is included in the system prompt. Full skill instructions are loaded on-demand when the model invokes `skills`. Each `Task` tracks which skills have been loaded in a `loadedSkills` Map, preventing redundant loads and auto-clearing on context summarization.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐     ┌──────────────┐
│ SkillsManager│────▶│ System Prompt    │────▶│ Model evaluates │────▶│ skills   │
│ .discover()  │     │ <available_skills>│     │ skill check     │     │ native tool  │
└──────────────┘     └──────────────────┘     └─────────────────┘     └──────┬───────┘
                                                                             │
                                                                     ┌───────▼───────┐
                                                                     │ Task.          │
                                                                     │ loadedSkills   │
                                                                     │ Map<name,path> │
                                                                     └───────────────┘
```

## Skill Discovery

### Directory Locations (Priority Order)

Skills are discovered from multiple locations. Later directories override earlier ones for skills with the same name:

1. `~/.agents/skills/` — Global shared agent skills (lowest priority)
2. `{project}/.agents/skills/` — Project-level shared agent skills
3. `~/.shofer/skills/` — Global Shofer-specific skills
4. `{project}/.shofer/skills/` — Project-level Shofer-specific skills (highest priority)

Plus mode-specific variants in each location: `skills-{mode}/` (e.g., `skills-code/`, `skills-architect/`)

### SKILL.md Format

Each skill lives in a subdirectory with a `SKILL.md` file:

```
.shofer/skills/
└── my-skill/
    └── SKILL.md
```

**SKILL.md structure:**

```markdown
---
name: my-skill
description: Brief description of when to use this skill (1-1024 chars)
modeSlugs:
    - code
    - architect
---

# My Skill

Full instructions loaded on-demand...
```

**Frontmatter fields:**

| Field         | Required | Description                                                                |
| ------------- | -------- | -------------------------------------------------------------------------- |
| `name`        | ✅       | Must match directory name, 1-64 chars, lowercase alphanumeric with hyphens |
| `description` | ✅       | When to use this skill, 1-1024 chars                                       |
| `modeSlugs`   | ❌       | Array of mode slugs; empty/missing = available in all modes                |

### Discovery Process

Implemented in [`SkillsManager.ts`](src/services/skills/SkillsManager.ts):

1. `discoverSkills()` scans all skill directories
2. `scanSkillsDirectory()` iterates subdirectories (supports symlinks)
3. `loadSkillMetadata()` parses `SKILL.md` frontmatter with `gray-matter`
4. Validates name matches directory, description length, name format
5. File watchers auto-refresh on `SKILL.md` changes

## System Prompt Inclusion

### What's Included by Default

Only metadata is included in the system prompt ([`skills.ts`](src/core/prompts/sections/skills.ts)):

```xml
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extracts text & tables from PDFs</description>
    <location>/home/user/.shofer/skills/pdf-processing/SKILL.md</location>
  </skill>
</available_skills>
```

### Mandatory Skill Check Instructions

The system prompt includes instructions telling the model to:

1. **Evaluate** every request against skill descriptions
2. **If a skill matches**: Use `skills` to load it, then follow instructions
3. **If no skill matches**: Proceed normally
4. **Constraints**: Don't load every skill up front; don't reload already-loaded skills

## Native Tools

The `skills` native tool loads skill instructions into context:

| Tool                                                      | Purpose                                       |
| --------------------------------------------------------- | --------------------------------------------- |
| [`skills`](src/core/prompts/tools/native-tools/skills.ts) | Load a skill's full instructions into context |

### `skills`

```json
{
	"skill": "my-skill",
	"args": "optional context"
}
```

**Handler** ([`SkillsTool.ts`](src/core/tools/SkillsTool.ts)):

1. Validates `skill` parameter
2. Checks `task.loadedSkills` — if already loaded, returns `"Skill 'X' is already loaded (no-op)."`
3. Resolves skill content via [`resolveSkillContentForMode()`](src/services/skills/skillInvocation.ts)
4. Asks for user approval
5. Records `task.loadedSkills.set(skillName, skillContent.path)`
6. Returns formatted instructions:

```
Skill: my-skill
Description: Brief description
Provided arguments: optional context
Source: project

--- Skill Instructions ---

[Full markdown body from SKILL.md]
```

## Loaded Skill Tracking

Each `Task` maintains a [`loadedSkills: Map<string, string>`](src/core/task/Task.ts:549) — skill name → absolute SKILL.md path.

### Lifecycle

| Event                 | Behavior                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Skill loaded**      | `SkillsTool.execute()` records `loadedSkills.set(name, path)`                             |
| **Reload attempted**  | Returns no-op message — no file re-read, no approval prompt                               |
| **Context condensed** | `loadedSkills.clear()` called in all three condense paths                                 |
| **UI refresh (↻)**    | `handleRequestSkills()` calls `discoverSkills()` + returns `loadedSkills` in IPC response |

### Condense clearing locations

All three code paths clear `loadedSkills`:

```typescript
// 1. User-triggered condense via /condense_context
//    Task.ts → condenseContext() line 2076

// 2. Forced truncation after context window error
//    Task.ts → handleContextWindowExceededError() line 4889

// 3. Auto-condense via manageContext in attemptApiRequest()
//    Task.ts → line 4952
```

## UI Integration

### Skills Button (🎓)

The [`SkillsButton`](webview-ui/src/components/chat/SkillsButton.tsx) in the chat input bar opens a popover:

```
┌──────────────────────────────────────┐
│ 🎓 Skills                 [↻] [⚙]  │
│                                      │
│ ✓ LOADED                            │
│ ✓ eauction-search                    │
│   Search for properties on...        │
│                                      │
│ 🌐 ALL MODES                         │
│ 📁 property-finder-search             │
│   Search for properties on...        │
└──────────────────────────────────────┘
```

- **Loaded skills** at top with green ✓ — filtered from `loadedSkills` state
- **Available skills** below — grouped by mode, sorted alphabetically
- **↻ Refresh** — re-reads `.shofer/skills` directories via `requestSkills` IPC
- **⚙ Settings** — navigates to Settings → Skills
- **Click** — inserts `"Use the <skill-name> skill"` into chat input
- Skills inserted via `/skill-name` in messages also trigger loading

### Extension State Flow

```
Extension                                Webview
─────────                                ───────
SkillsManager.discoverSkills()
    │
    ▼
handleRequestSkills()
    │
    ├── skills: SkillMetadata[]
    ├── loadedSkills: Record<string,string>  ──▶  ExtensionStateContext
    │                                              │
    │                                     ┌────────▼──────────┐
    │                                     │ skills[]           │
    │                                     │ loadedSkills{}     │
    │                                     └───────────────────┘
    │                                              │
    │                                     ┌────────▼──────────┐
    │                                     │ SkillsButton       │
    │                                     │ - loaded list      │
    │                                     │ - grouped unloaded │
    │                                     └───────────────────┘
```

## Override Resolution

When multiple skills have the same name:

1. **Source priority**: project > global
2. **Within same source**: mode-specific > generic
3. **Same source + specificity**: first discovered wins

## Key Files

| File                                                                            | Purpose                                            |
| ------------------------------------------------------------------------------- | -------------------------------------------------- |
| [`Task.ts`](src/core/task/Task.ts:549)                                          | `loadedSkills` Map, condense clearing              |
| [`SkillsTool.ts`](src/core/tools/SkillsTool.ts)                                 | Handler: no-op check, tracking, approval           |
| [`SkillsManager.ts`](src/services/skills/SkillsManager.ts)                      | Discovery, caching, file watching                  |
| [`skillInvocation.ts`](src/services/skills/skillInvocation.ts)                  | Content loading, result formatting                 |
| [`skills.ts`](src/shared/skills.ts)                                             | Type definitions (`SkillMetadata`, `SkillContent`) |
| [`skills.ts` (prompt)](src/core/prompts/sections/skills.ts)                     | System prompt section generation                   |
| [`skills.ts`](src/core/prompts/tools/native-tools/skills.ts)                    | Native tool schema                                 |
| [`skillsMessageHandler.ts`](src/core/webview/skillsMessageHandler.ts)           | IPC handlers (requestSkills, create, delete, move) |
| [`SkillsButton.tsx`](webview-ui/src/components/chat/SkillsButton.tsx)           | Popover UI with loaded/unloaded split + refresh    |
| [`ExtensionStateContext.tsx`](webview-ui/src/context/ExtensionStateContext.tsx) | `loadedSkills` state management                    |
