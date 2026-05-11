# RooCode Skills System

## Overview

RooCode implements a **lazy-loading skill system** where only skill metadata (name, description, location) is included in the system prompt. Full skill instructions are loaded on-demand when the model invokes the `skill` tool.

## Skill Discovery

### Directory Locations (Priority Order)

Skills are discovered from multiple locations. Later directories override earlier ones for skills with the same name:

1. `~/.agents/skills/` - Global shared agent skills (lowest priority)
2. `{project}/.agents/skills/` - Project-level shared agent skills
3. `~/.roo/skills/` - Global Roo-specific skills
4. `{project}/.roo/skills/` - Project-level Roo-specific skills (highest priority)

Plus mode-specific variants in each location: `skills-{mode}/` (e.g., `skills-code/`, `skills-architect/`)

### SKILL.md Format

Each skill lives in a subdirectory with a `SKILL.md` file:

```
.roo/skills/
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

- `name` (required): Must match directory name, 1-64 chars, lowercase alphanumeric with hyphens
- `description` (required): When to use this skill, 1-1024 chars
- `modeSlugs` (optional): Array of mode slugs; empty/missing = available in all modes

### Discovery Process

Implemented in `src/services/skills/SkillsManager.ts`:

1. `discoverSkills()` scans all skill directories
2. `scanSkillsDirectory()` iterates subdirectories (supports symlinks)
3. `loadSkillMetadata()` parses `SKILL.md` frontmatter with `gray-matter`
4. Validates name matches directory, description length, name format
5. File watchers auto-refresh on `SKILL.md` changes

## System Prompt Inclusion

### What's Included by Default

Only metadata is included in the system prompt (`src/core/prompts/sections/skills.ts`):

```xml
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extracts text &amp; tables from PDFs</description>
    <location>/home/user/.roo/skills/pdf-processing/SKILL.md</location>
  </skill>
</available_skills>
```

### Mandatory Skill Check Instructions

The system prompt includes ~50 lines of instructions telling the model to:

1. **Evaluate** every request against skill descriptions
2. **If a skill matches**: Use the `skill` tool to load it, then follow instructions
3. **If no skill matches**: Proceed normally
4. **Constraints**: Don't load every skill up front; don't reload already-loaded skills

## On-Demand Skill Loading

### Via `skill` Tool

The model invokes the native `skill` tool (`src/core/prompts/tools/native-tools/skill.ts`):

```json
{
	"skill": "my-skill",
	"args": "optional context"
}
```

### Via Slash Command

Users can reference skills via `/skill-name` in messages. This triggers immediate loading.

### Via Skills Button (🎓)

The Skills button in the chat input bar (next to the ⚡ Commands button) opens a popover listing all available skills:

- **Loaded skills** are shown first with a green ✓ checkmark
- **Available (not loaded) skills** are shown below, grouped by mode restriction, sorted alphabetically
- Clicking a skill appends `"Use the <skill-name> skill"` to the chat input
- The button auto-refreshes via `requestSkills` IPC on each open

### Loaded Skill Tracking

Each task maintains a `loadedSkills` map (skill name → SKILL.md path) on the `Task` class:

- **On load**: When [`skill_load`](extensions/Roo-Code/src/core/tools/SkillLoadTool.ts:82) succeeds, the skill is recorded.
- **Reload is a no-op**: Calling `skill_load` for an already-loaded skill returns `"Skill 'X' is already loaded (no-op)."` without re-reading the file.
- **Cleared on condense**: All loaded skills are cleared when context summarization/truncation occurs (three code paths: [`condenseContext()`](extensions/Roo-Code/src/core/task/Task.ts:2036), [`handleContextWindowExceededError()`](extensions/Roo-Code/src/core/task/Task.ts:4638), and the [`manageContext`](extensions/Roo-Code/src/core/task/Task.ts:4876) pass in `attemptApiRequest()`).

### Loaded Content Format

`getSkillContent()` returns (`src/services/skills/skillInvocation.ts`):

```
Skill: my-skill
Description: Brief description
Provided arguments: optional context
Source: project

--- Skill Instructions ---

[Full markdown body from SKILL.md]
```

## Override Resolution

When multiple skills have the same name:

1. **Source priority**: project > global
2. **Within same source**: mode-specific > generic
3. **Same source + specificity**: first discovered wins

## Key Files

- `src/services/skills/SkillsManager.ts` - Discovery, caching, file watching
- `src/services/skills/skillInvocation.ts` - Content loading and formatting
- `src/shared/skills.ts` - Type definitions (`SkillMetadata`, `SkillContent`)
- `src/core/prompts/sections/skills.ts` - System prompt generation
- `src/core/prompts/tools/native-tools/skill.ts` - Tool definition
- `src/core/mentions/index.ts` - Slash command handling
