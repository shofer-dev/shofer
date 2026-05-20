# Commands & Skills — Quick-Access Buttons

Next to the mode and API config selectors in the chat input bar, you'll find two
compact buttons that let you browse and insert slash commands and skills without
typing or opening Settings.

<!-- XXX: Full-width screenshot of the ChatTextArea bar showing the full row of
controls: ModeSelector, ApiConfigSelector, AutoApproveDropdown,
WorktreeIndicator, CommandsButton (⚡), and SkillsButton (🎓). The CommandsButton
popover should be open, showing grouped slash commands. Caption: "The chat input
bar with the Commands popover open." -->

---

## Commands Button (⚡)

Click the **⚡ Commands** button to see every slash command available in your
workspace. Commands are grouped by source:

- **Project Commands** — defined in your workspace's `.shofer/commands/` directory.
- **Global Commands** — defined in your user-level `~/.shofer/commands/` directory.
- **Built-in Commands** — provided by Shofer itself (e.g., `init`).

<!-- XXX: Close-up of the Commands popover with all three groups visible and one
command hovered to show the open-file (ExternalLink) icon. Caption: "Commands
popover showing Project, Global, and Built-in groups." -->

**To use a command:**

1. Click ⚡ to open the popover.
2. Click any command — it's appended to the chat input as `/command-name`.
3. Review the command text, edit if needed, then click **Send**.

Commands with an **argument hint** (e.g., `/review <branch-name>`) include the
placeholder in the inserted text — just replace it with your value before
sending.

The popover header includes a **↻ refresh button** (re-reads the commands
directories) and a **⚙ gear** (opens Settings → Slash Commands). Each command
row also shows a file-open icon on hover when the command has a known source
file.

---

## Skills Button (🎓)

Click the **🎓 Skills** button to browse all available skills. The popover
shows skills in two sections:

1. **Loaded** (with a green ✓ checkmark) — skills already loaded into the
   current task's context. Clicking a loaded skill re-inserts its instruction
   text so the model can reference it again.
2. **Available** — skills not yet loaded, grouped by mode restriction:
    - **All Modes** (🌐 icon) — skills available in every mode.
    - **Per-mode groups** (📁 icon) — skills restricted to specific modes,
      sorted alphabetically.

<!-- XXX: Close-up of the Skills popover showing both the Loaded section (with
green checkmarks) and the Available section (grouped by mode). One loaded skill
and two available skills visible. Caption: "Skills popover with loaded and
available skills." -->

**To use a skill:**

1. Click 🎓 to open the popover.
2. Click any skill — the text `Use the <skill-name> skill` is inserted into
   the chat input.
3. Click **Send**. The model will load the skill's instructions via its tool-
   calling mechanism and then follow them.

The popover header includes a **↻ refresh button** (re-discovers skills from
`.shofer/skills/` directories) and a **⚙ gear** (opens Settings → Skills). Each
skill row shows a file-open icon on hover (opens the `SKILL.md` file in the
editor).

> **Note:** Skills are never auto-executed. Shofer always inserts an
> instruction and lets you decide when (and whether) to send it.

---

## Loaded Skills Tracking

As a task runs, Shofer remembers which skills the model has already loaded.
This information is shown in the Skills popover so you always know what's
active in your current conversation.

- **On load:** The skill appears in the "Loaded" section with a ✓.
- **On context condensation:** When Shofer summarizes the conversation to free
  up context window space, the loaded-skills list is cleared (summarization
  invalidates previously loaded skill instructions).

---

## Refreshing

Both popovers have a **↻ refresh** button in the header:

- **Commands:** Re-reads the `.shofer/commands/` directories (project and
  global) and picks up any newly added or removed command files.
- **Skills:** Re-discovers all `SKILL.md` files from `.shofer/skills/`
  directories and updates the popover list. The Skills button also
  automatically refreshes every time you open its popover, so loaded/unloaded
  status is always current.

---

## When Buttons Are Hidden

- The **Commands** button hides when there are no commands available (no
  project, global, or built-in commands).
- The **Skills** button hides when there are no skills available (no
  `SKILL.md` files discovered in any skills directory).

Both buttons are always enabled regardless of task state — you can browse and
insert commands and skills even while Shofer is actively working.
