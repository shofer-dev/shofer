# Skills — Giving Shofer Reusable Expertise

Skills are reusable instruction packs that teach Shofer how to handle specific
tasks — searching a particular website, following a multi-step workflow, or
applying domain-specific rules. When you install or create a skill, Shofer
automatically detects it and uses it whenever the task matches.

---

## What Are Skills?

A skill is a folder containing a `SKILL.md` file with YAML frontmatter (name,
description, optional mode restrictions) followed by markdown instructions.
Shofer discovers skills from your filesystem, includes their descriptions in
the system prompt, and loads the full instructions on-demand when the model
decides the skill applies.

**Key properties:**

- **Lazy-loaded** — only the name and description appear in the system prompt.
  The full instructions are loaded only when the model invokes `skills`.
- **Mode-aware** — a skill can be restricted to specific modes (Code, Architect,
  etc.) or be available in all modes.
- **Loaded once per task** — Shofer remembers which skills are already loaded
  and won't reload them. All loaded skills are cleared automatically when the
  conversation context is condensed.
- **Overridable** — project-level skills override global skills with the same
  name. Mode-specific skills override generic ones.

---

## Where Skills Live

Shofer discovers skills from these directories (in priority order — later
directories override earlier):

| Directory                   | Scope   | Priority |
| --------------------------- | ------- | -------- |
| `~/.agents/skills/`         | Global  | Lowest   |
| `{project}/.agents/skills/` | Project |          |
| `~/.shofer/skills/`         | Global  |          |
| `{project}/.shofer/skills/` | Project | Highest  |

Plus mode-specific subdirectories: `skills-code/`, `skills-architect/`, etc.

---

## Creating a Skill

### Step 1: Create the directory

Create a folder named after your skill inside `.shofer/skills/` (project-level)
or `~/.shofer/skills/` (global).

The folder name must be **1–64 characters, lowercase letters, digits, and
hyphens only** (e.g., `my-skill`, `eauction-search`).

```
.shofer/skills/
└── my-skill/
    └── SKILL.md
```

XXX: Screenshot showing the .shofer/skills/ directory in the VS Code file
explorer with a skill subdirectory expanded to show the SKILL.md file inside.

### Step 2: Write the SKILL.md file

Create a `SKILL.md` file with YAML frontmatter followed by your instructions:

```markdown
---
name: my-skill
description: Brief description of when to use this skill (1-1024 characters)
modeSlugs:
    - code
    - architect
---

# My Skill

Full instructions that Shofer will follow when this skill is loaded...
```

| Frontmatter Field | Required | Description                                                             |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `name`            | ✅       | Must match the directory name                                           |
| `description`     | ✅       | 1–1024 characters describing when to use this skill                     |
| `modeSlugs`       | ❌       | List of mode slugs; leave empty or omit to make it available everywhere |

XXX: Screenshot showing a SKILL.md file open in the editor with the YAML
frontmatter section visually distinguished from the markdown body below.

### Step 3: Reload

Shofer watches for changes automatically. The skill appears in the Skills
popover within seconds. You can also click the ↻ (Refresh) button in the
popover to force a re-scan.

---

## Using Skills in Practice

### The Skills Button (🎓)

The 🎓 button in the chat input bar opens a popover showing all available
skills:

- **✓ LOADED** — skills already loaded in the current task (green checkmark).
- **Available** — skills grouped by mode restriction, sorted alphabetically.

XXX: Screenshot showing the SkillsButton popover open, with a loaded skill (green
checkmark) at top and available skills grouped by mode below, including the ↻
Refresh and ⚙ Settings buttons.

### How the Model Uses Skills

1. You send a message — Shofer evaluates all skill descriptions against your
   request.
2. If a skill matches, Shofer calls the `skills` tool to load its full
   instructions.
3. The skill instructions become part of the conversation, and Shofer follows
   them precisely.
4. Once loaded, a skill stays loaded for the rest of the task (or until
   context condensation clears it).

### Triggering a Skill Manually

There are two ways to manually load a skill:

- **Click the skill in the popover** — this inserts `"Use the <skill-name> skill"`
  into the chat input. Send the message, and Shofer loads the skill.
- **Type `/skill-name` in the chat** — Shofer recognizes slash-prefixed skill
  names and loads the skill before processing your message.

XXX: Screenshot showing a message typed in the chat input: "Use the
eauction-search skill to find properties in Athens" with the SkillsButton visible
in the input bar.

---

## Approving Skills

When Shofer loads a skill, you'll see an approval prompt in the chat showing
the skill name, description, and source (project or global). Click **Accept**
to allow the skill to load, or **Reject** to cancel.

If you have auto-approval enabled for the `skills` tool (it's in the
always-available tools list), this prompt is skipped and skills load silently.

XXX: Screenshot showing the skill approval chat row — with skill name,
description, source badge (project/global), and Accept/Reject buttons.

---

## Managing Skills

### Creating a Skill from Settings

Open Settings → Skills to create, rename, or delete skills through the UI.
The settings panel lets you:

- Set the skill name, description, and mode restrictions.
- Choose between creating a project-level or global skill.
- Open the created `SKILL.md` file for editing.

### Deleting or Moving a Skill

From the Skills popover or the Settings panel, you can delete a skill or move
it between modes. Deleting removes the skill directory and its `SKILL.md` file.
Moving a skill updates the `modeSlugs` in the frontmatter.

---

## Skill Override Rules

When Shofer discovers multiple skills with the same name:

1. **Project beats global** — if both `.shofer/skills/my-skill/` and
   `~/.shofer/skills/my-skill/` exist, the project version wins.
2. **Mode-specific beats generic** — `skills-code/my-skill/` overrides
   `skills/my-skill/` for the Code mode.
3. **First discovered wins** — if two skills have the same priority and
   specificity, the first one found during scanning wins.

---

## Quick Reference

| Task                                 | How                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------- |
| See available skills                 | Click the 🎓 button in the chat input bar                                   |
| Create a skill                       | Create a folder + `SKILL.md` in `.shofer/skills/`, or use Settings → Skills |
| Restrict a skill to a mode           | Add `modeSlugs: [code, architect]` to the frontmatter                       |
| Manually load a skill                | Click the skill in the popover, or type `/skill-name` in the chat           |
| Refresh the skill list               | Click ↻ in the Skills popover                                               |
| Delete a skill                       | Settings → Skills, or delete the folder manually                            |
| Override a global skill in a project | Create a skill with the same name in the project's `.shofer/skills/`        |
| Share a skill                        | Copy the skill folder to another machine's `.shofer/skills/` directory      |
