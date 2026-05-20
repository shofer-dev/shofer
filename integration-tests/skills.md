# Skills System — Integration Test Scenarios

Tests for the skills discovery, loading, tracking, and UI subsystems.

## Prerequisites

- Shofer extension running with at least one API profile configured.
- A workspace with `.shofer/skills/` directory containing at least two valid
  skill definitions.
- (Optional) Global skills directory `~/.shofer/skills/` with one skill for
  override testing.

---

## Scenario 1: Skills are discovered and appear in the popover

**Goal:** Verify that valid `SKILL.md` files are discovered and listed in the
SkillsButton popover.

1. Create `.shofer/skills/test-skill/SKILL.md` with valid frontmatter.
2. Click the 🎓 SkillsButton in the chat input bar.
3. Confirm `test-skill` appears under "Available" with its description.
4. Confirm the ↻ Refresh button works — add a new skill, click ↻, and it
   appears.

**Expected:** All valid skills are listed, grouped by mode restriction, sorted
alphabetically within each group.

---

## Scenario 2: Invalid skills are silently skipped

**Goal:** Verify that skills with invalid frontmatter are not shown (and don't
crash discovery).

1. Create `SKILL.md` with a name not matching the directory name.
2. Refresh the skills list.
3. Confirm the invalid skill does NOT appear.
4. Create `SKILL.md` with description > 1024 characters.
5. Refresh.
6. Confirm the skill does NOT appear.
7. Create `SKILL.md` with a name containing uppercase letters or underscores.
8. Refresh.
9. Confirm the skill does NOT appear.

**Expected:** Only valid skills appear; invalid ones are silently skipped with
no error in the UI.

---

## Scenario 3: Loading a skill via the skills tool

**Goal:** Verify the full load-and-approve flow.

1. Start a new task in Code mode.
2. Send a message that triggers the skill (e.g., "Use the test-skill skill").
3. Confirm the model calls the `skills` tool.
4. Confirm the approval prompt appears in chat with the skill name, description,
   source badge, and Accept/Reject buttons.
5. Click **Accept**.
6. Confirm the skill instructions appear in the chat output.
7. Confirm the skill appears under "✓ LOADED" in the SkillsButton popover.

**Expected:** Skill loads after approval, instructions are visible, and the
skill is tracked as loaded in the popover.

---

## Scenario 4: Reloading an already-loaded skill is a no-op

**Goal:** Verify that loading the same skill twice produces a no-op result
without re-requesting approval.

1. After loading `test-skill` (from Scenario 3), send another message asking
   to load the same skill.
2. Confirm the `skills` tool returns `"Skill 'test-skill' is already loaded (no-op)."`
3. Confirm no second approval prompt appears.

**Expected:** Already-loaded skills return no-op and don't re-prompt.

---

## Scenario 5: Skills are cleared on context condensation

**Goal:** Verify that loaded skills are cleared when the context is condensed.

1. Load a skill (from Scenario 3).
2. Confirm it appears under "✓ LOADED" in the popover.
3. Trigger context condensation (send many messages, or use `/condense_context`
   if available).
4. Confirm the skill no longer appears under "✓ LOADED" — it moves back to
   "Available".

**Expected:** All loaded skills clear on condensation, and the popover reflects
the change.

---

## Scenario 6: Mode-specific skills are only available in their declared mode

**Goal:** Verify that skills with `modeSlugs` are filtered correctly.

1. Create a skill with `modeSlugs: [code]` in its frontmatter.
2. Start a task in **Code** mode — confirm the skill appears in the popover.
3. Start a task in **Ask** mode — confirm the skill does NOT appear.
4. Create a skill with no `modeSlugs` (or empty array).
5. Confirm it appears in both Code and Ask modes.

**Expected:** Mode-restricted skills only appear in their declared modes;
unrestricted skills appear everywhere.

---

## Scenario 7: Skill override — project beats global

**Goal:** Verify that project-level skills override global skills with the
same name.

1. Ensure `~/.shofer/skills/override-test/SKILL.md` exists with description
   "Global version".
2. Create `{project}/.shofer/skills/override-test/SKILL.md` with description
   "Project version".
3. Open the SkillsButton popover.
4. Confirm the description shown is "Project version".
5. Delete the project-level skill.
6. Refresh — confirm the description changes back to "Global version".

**Expected:** Project-level skills override global skills; removing the project
skill falls back to the global one.

---

## Scenario 8: Skill loading via slash command (/skill-name)

**Goal:** Verify the mention-loading path triggered by typing `/skill-name`
in the chat input.

1. Type `/test-skill` followed by a message in the chat input.
2. Send the message.
3. Confirm the skill appears under "✓ LOADED" in the popover — without the
   model explicitly calling the `skills` tool.

**Expected:** Slash-prefixed skill names are parsed by `processUserContentMentions`
and loaded before the task loop starts.

---

## Scenario 9: SkillsButton popover reflects real-time loaded state

**Goal:** Verify that switching tasks shows the correct loaded skills for each
task.

1. Task A: Load `skill-a`.
2. Task B (new task): Load `skill-b`.
3. Switch back to Task A — confirm only `skill-a` is loaded.
4. Switch to Task B — confirm only `skill-b` is loaded.

**Expected:** Each task maintains independent loaded skills state, and the
popover reflects the current task's state.

---

## Scenario 10: Creating and deleting skills via Settings

**Goal:** Verify the lifecycle management flow through the Settings UI.

1. Open Settings → Skills.
2. Create a new project-level skill named `created-skill` with description
   "Created via settings".
3. Confirm the skill appears in the popover and a `SKILL.md` file is created.
4. Delete the skill via Settings.
5. Confirm the skill directory is removed and the skill no longer appears.

**Expected:** Create and delete operations work end-to-end, with filesystem
changes reflected immediately in the UI.

---

## Scenario 11: Symlinked skill directories are followed

**Goal:** Verify that symlinks in the skills directory are traversed.

1. Create a skill outside `.shofer/skills/` (e.g., `/tmp/linked-skill/`).
2. Create a symlink from `.shofer/skills/linked-skill` → `/tmp/linked-skill/`.
3. Refresh the skills list.
4. Confirm `linked-skill` appears in the popover.

**Expected:** Symlinked skill directories are discovered and treated like
regular directories.

---

## Scenario 12: Auto-approval skips the approval prompt

**Goal:** Verify that when auto-approval is enabled, skills load without
user interaction.

1. Enable auto-approval for the `skills` tool in Settings.
2. Send a message that triggers loading a skill.
3. Confirm the skill loads immediately — no approval prompt appears.
4. Confirm the skill instructions appear in the chat output.

**Expected:** With auto-approval enabled, the approval prompt is bypassed.
