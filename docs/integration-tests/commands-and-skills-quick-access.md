# Commands & Skills Quick-Access Buttons — Integration Test Scenarios

Tests for the CommandsButton, SkillsButton, and loaded-skills tracking
subsystems.

## Prerequisites

- Shofer extension running with at least one API profile configured.
- A workspace with:
    - `.shofer/commands/` containing at least two command files (project source).
    - `.shofer/skills/` containing at least two valid skill definitions.
- (Optional) Global commands (`~/.shofer/commands/`) and global skills
  (`~/.shofer/skills/`) for source-mixing tests.

---

## Scenario 1: Commands popover lists all available commands

**Goal:** Verify that slash commands from all sources appear in the Commands
popover, grouped correctly.

1. Ensure project commands exist in `.shofer/commands/`.
2. Click the ⚡ Commands button.
3. Confirm the popover header shows "⚡ Slash Commands", a ↻ refresh button,
   and a ⚙ gear button.
4. Confirm commands are grouped: "PROJECT COMMANDS" (📁 icon), "GLOBAL
   COMMANDS" (🌐 icon, if any), "BUILT-IN COMMANDS" (🔧 icon).
5. Confirm each command row shows `/command-name` in monospace and its
   description (truncated).
6. Confirm the file-open icon (ExternalLink) appears on hover for commands
   with a `filePath`.

**Expected:** All available commands are listed, grouped by source, with
correct icons and descriptions.

---

## Scenario 2: Clicking a command inserts it into the chat input

**Goal:** Verify that clicking a command appends the correct text to the chat
input and closes the popover.

1. Open the Commands popover.
2. Click a command without an `argumentHint` (e.g., `/init`).
3. Confirm the text `/init ` (with trailing space) is inserted into the chat
   text area.
4. Confirm the popover closes.
5. Open the popover again.
6. Click a command with an `argumentHint` (if available).
7. Confirm `/command-name <argumentHint>` is inserted.

**Expected:** Correct text inserted, popover closes, cursor positioned after
the inserted text.

---

## Scenario 3: Commands refresh button picks up new commands

**Goal:** Verify the ↻ refresh button re-reads command directories.

1. With the Commands popover open, note the current command list.
2. Add a new command file to `.shofer/commands/new-cmd.md`.
3. Click the ↻ refresh button.
4. Confirm `new-cmd` appears in the popover.
5. Delete the command file.
6. Click ↻ again.
7. Confirm `new-cmd` no longer appears.

**Expected:** Refresh discovers and removes commands in real time.

---

## Scenario 4: Skills popover shows loaded and available skills

**Goal:** Verify the Skills popover correctly splits skills into Loaded and
Available sections.

1. Click the 🎓 Skills button.
2. Confirm the popover header shows "🎓 Skills", a ↻ refresh button, and a ⚙
   gear button.
3. With no skills loaded yet, confirm no "Loaded" section is shown.
4. Confirm available skills are grouped: "ALL MODES" (🌐 icon) for unrestricted
   skills, then per-mode groups (📁 icon) sorted alphabetically.
5. Start a task and instruct the model to load a skill (e.g., "Use the
   eauction-search skill").
6. After the model loads the skill, re-open the Skills popover.
7. Confirm the loaded skill appears under "LOADED" with a green ✓ checkmark.
8. Confirm the loaded skill still appears clickable (re-inserts the
   instruction).

**Expected:** Correct loaded/available split, per-mode grouping, and ✓
indicator for loaded skills.

---

## Scenario 5: Clicking a skill inserts the natural-language instruction

**Goal:** Verify clicking a skill inserts `Use the <skill-name> skill` and
closes the popover.

1. Open the Skills popover.
2. Click an available skill.
3. Confirm `Use the <skill-name> skill` is inserted into the chat text area.
4. Confirm the popover closes.

**Expected:** Natural-language instruction inserted, popover closes.

---

## Scenario 6: Skills refresh button re-discovers skills

**Goal:** Verify the ↻ refresh button and auto-refresh-on-open behavior.

1. Open the Skills popover; note the current skill list.
2. Add a new `SKILL.md` to `.shofer/skills/new-skill/SKILL.md`.
3. Click ↻.
4. Confirm `new-skill` appears.
5. Close and re-open the popover — confirm auto-refresh picked up the skill.
6. Delete the skill directory.
7. Click ↻.
8. Confirm the skill no longer appears.

**Expected:** Both manual refresh and auto-refresh-on-open work correctly.

---

## Scenario 7: Settings gear navigates to correct section

**Goal:** Verify the ⚙ gear in each popover navigates to the correct Settings
tab.

1. Open the Commands popover.
2. Click ⚙.
3. Confirm the popover closes and the webview navigates to Settings → Slash
   Commands.
4. Open the Skills popover.
5. Click ⚙.
6. Confirm the popover closes and the webview navigates to Settings → Skills.

**Expected:** Correct Settings tab opens for each popover.

---

## Scenario 8: Buttons hide when no content available

**Goal:** Verify buttons are hidden when their respective content is empty.

1. Remove all command files from `.shofer/commands/` and `~/.shofer/commands/`
   (if possible in test environment).
2. Confirm the ⚡ Commands button is not rendered.
3. Remove all skill files from `.shofer/skills/` and `~/.shofer/skills/`.
4. Confirm the 🎓 Skills button is not rendered.

**Expected:** Buttons return `null` when their lists are empty.

---

## Scenario 9: Open-file button opens SKILL.md or command source

**Goal:** Verify the file-open (ExternalLink) icon opens the correct file.

1. Open the Commands popover.
2. Hover over a command with a `filePath`.
3. Click the ExternalLink icon.
4. Confirm the file opens in the VS Code editor.
5. Open the Skills popover.
6. Hover over a skill.
7. Click the ExternalLink icon.
8. Confirm the `SKILL.md` file opens in the editor.

**Expected:** `openFile` IPC message opens the correct file for both command
and skill rows.

---

## Scenario 10: Loaded skills cleared on context condensation

**Goal:** Verify that `loadedSkills` is cleared when context condensation
occurs.

1. Start a task and load a skill.
2. Confirm the skill appears as "Loaded" in the Skills popover.
3. Trigger context condensation (send many messages or reduce the condensation
   threshold).
4. After condensation completes, re-open the Skills popover.
5. Confirm the previously-loaded skill now appears under "Available" (not
   "Loaded").

**Expected:** `loadedSkills` is cleared on all three condensation paths.

---

## Scenario 11: Loaded skills survive task rehydration

**Goal:** Verify that loaded skills are restored when a task is rehydrated
from history.

1. Start a task and load a skill.
2. Note the loaded skill in the popover.
3. Reload the VS Code window (or restart the extension).
4. Re-open the task from history.
5. Open the Skills popover.
6. Confirm the previously-loaded skill still shows under "Loaded" (though
   path may be empty, the name is preserved).

**Expected:** Skill names survive `HistoryItem.loadedSkills` rehydration.
