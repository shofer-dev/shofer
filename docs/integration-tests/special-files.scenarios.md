# Shofer Special Files — Integration Test Scenarios

Feature under test: Shofer's recognition of and behavior around special workspace files (`.shofer/shoferignore`, `.shofer/shofermodes`, `.shofer/rules/`, `.shofer/commands/`, `.shofer/skills/`, `AGENTS.md`, `.shoferprotected` patterns).  
Sources: [`ShoferIgnoreController`](../src/core/ignore/ShoferIgnoreController.ts), [`ShoferProtectedController`](../src/core/protect/ShoferProtectedController.ts), [`CustomModesManager`](../src/core/config/CustomModesManager.ts), [`shofer_special_files.md`](../docs/shofer_special_files.md).

## Smoke Tests

These should pass on every build.

### S1 — `.shofer/shoferignore` blocks file reads

- Create a project with `.shofer/shoferignore` containing `secrets/**`.
- Create `secrets/api.key` with dummy content.
- Start a new task and ask the AI to `read_file secrets/api.key`.
- **Assert**: The tool call fails with an error indicating the path is ignored. The error is surfaced in the chat UI.
- **Assert**: `list_files` on the project root does not show `secrets/` entries (when "Show ignored files" is OFF), or shows them with a 🔒 badge (when ON).

### S2 — `.shofer/shofermodes` defines a custom mode

- Place a valid `.shofer/shofermodes` file in the workspace root with one custom mode (slug `"review"`).
- Open/reload the project.
- **Assert**: The custom mode appears in the ModeSelector dropdown.
- **Assert**: Switching to the custom mode loads the mode's `roleDefinition`, `customInstructions`, and tool restrictions.
- **Assert**: The mode's `source` is `"project"` in the UI (popover or badge).

### S3 — `AGENTS.md` injected into system prompt

- Create `AGENTS.md` at the workspace root containing `# Rule: Always use spaces not tabs`.
- Start a new task.
- **Assert**: The system prompt (visible via verbose logging or a debug tool) contains `# Agent Rules Standard (AGENTS.md)` followed by the file content.

### S4 — Protected files cannot be written without approval

- With auto-approval disabled, ask the AI to `write_to_file .shofer/shoferignore` with new content.
- **Assert**: An approval prompt appears in the chat UI asking the user to approve the write to a protected file.
- **Assert**: The prompt references that the file is a Shofer configuration file and requires approval.

### S5 — `.shofer/mcp.json` auto-git-ignored

- Create `.shofer/mcp.json` in a git-tracked project.
- **Assert**: `git status` does not list `.shofer/mcp.json` as untracked (it is ignored by the extension's auto-git-ignore mechanism).
- **Assert**: The file is write-protected (requires approval to edit via Shofer tools).

## Functional Tests

### F1 — `.shofer/shoferignore` blocks shell commands on ignored files

- Create `.shofer/shoferignore` with `data/**`.
- Create `data/report.csv`.
- Ask the AI to run `execute_command` with `cat data/report.csv`.
- **Assert**: The command is blocked. Chat UI shows an error indicating the command tried to access an ignored file.

### F2 — `.shofer/rules/` files loaded at task start

- Create `.shofer/rules/style-guide.md` with `# Style: prefer arrow functions`.
- Start a new task.
- **Assert**: The system prompt includes `# Rules from .shofer/rules/style-guide.md:` followed by the content.

### F3 — `.shofer/rules-code/` only loaded in Code mode

- Create `.shofer/rules-code/only-code.md` with `# Code-only instruction`.
- Start a task in Code mode → **Assert**: instruction appears in the system prompt.
- Start a task in Ask mode → **Assert**: instruction does NOT appear in the system prompt.

### F4 — Mode-specific rules override global rules

- Create `~/.shofer/rules-code/global.md` with `# Global code rule`.
- Create `<workspace>/.shofer/rules-code/project.md` with `# Project code rule`.
- Start a task in Code mode.
- **Assert**: Both rules appear, and project rules load after global rules (so project takes logical precedence).

### F5 — `.shofer/commands/` provides slash commands

- Create `.shofer/commands/deploy.md` with YAML front matter (`description`, `argumentHint`, `mode`).
- **Assert**: Typing `/` in the chat input shows `deploy` in the slash command palette.
- **Assert**: The command's description and argument hint are shown.
- Invoke `/deploy staging` → **Assert**: the mode switches to the mode specified in front matter (if set).

### F6 — `.shoferrules*` files are write-protected

- Ask the AI to `write_to_file .shoferrules` (bare, no extension) with content.
- **Assert**: The write triggers a protected-file approval prompt.
- (The same applies to `.shoferrules-code`, `.shoferrules-debug`, etc.)

### F7 — `*.code-workspace` files are write-protected

- Ask the AI to `write_to_file my-project.code-workspace` with content.
- **Assert**: The write triggers a protected-file approval prompt.

### F8 — `.shoferprotected` is an active protected pattern despite being "reserved"

- Ask the AI to `write_to_file .shoferprotected` (the file exists in `PROTECTED_PATTERNS` but no subsystem loads it yet).
- **Assert**: The write triggers a protected-file approval prompt (because the pattern is in the hardcoded list, regardless of the file's reserved status).

### F9 — `.vscode/**` is readable but write-protected

- Ask the AI to `read_file .vscode/settings.json`.
- **Assert**: The read succeeds (`.vscode` is not blocked by `.shofer/shoferignore` by default).
- Ask the AI to `write_to_file .vscode/settings.json` with new content.
- **Assert**: The write requires approval (write-protected pattern).

### F10 — Legacy rules files still work as fallback

- Remove `.shofer/rules/` directory.
- Create `.roorules` file at workspace root with a rule.
- Start a task → **Assert**: the rule content is loaded (legacy fallback).
- Create `.shofer/rules/modern.md` → **Assert**: the legacy file is ignored and the modern directory is used instead.

### F11 — `shofer.enableSubfolderRules` controls subfolder rule discovery

- Set `shofer.enableSubfolderRules` to `true`.
- Create `<workspace>/subdir/.shofer/rules/nested.md` with a rule.
- **Assert**: The nested rule appears in the system prompt.
- Set `shofer.enableSubfolderRules` to `false`.
- **Assert**: The nested rule does NOT appear.

### F12 — `shofer.useAgentRules` controls AGENTS.md loading

- Set `shofer.useAgentRules` to `true` (default).
- Create `AGENTS.md` at workspace root with a rule.
- **Assert**: The rule appears in the system prompt.
- Set `shofer.useAgentRules` to `false`.
- **Assert**: The rule does NOT appear.

## Edge Cases

### E1 — Malformed `.shofer/shofermodes` does not crash the extension

- Write invalid YAML in `.shofer/shofermodes` (e.g., unclosed quote).
- **Assert**: Shofer loads without crashing. The mode selector shows only default modes. An error is logged to the output channel.

### E2 — `.shofer/shoferignore` with broken symlinks

- Add a pattern to `.shofer/shoferignore` that matches a broken symlink.
- **Assert**: Shofer tools do not crash when encountering the broken symlink. The file is either allowed or denied gracefully.

### E3 — Protection check for paths outside workspace

- Ask the AI to `write_to_file ../outside-workspace/.shofer/shoferignore`.
- **Assert**: `ShoferProtectedController.isWriteProtected()` returns `false` for paths starting with `..`. The path is not incorrectly flagged as protected.

### E4 — `.vscode/` listed explicitly in `.shofer/shoferignore`

- Add `.vscode/` to `.shofer/shoferignore`.
- Ask the AI to `read_file .vscode/settings.json`.
- **Assert**: The file is blocked by `.shofer/shoferignore` (read blocked), even though `.vscode/**` is only write-protected by default.

### E5 — Skills discovery from both `.shofer/skills/` and `.agents/skills/`

- Create a skill in `~/.shofer/skills/example/SKILL.md`.
- Create a different skill of the same name in `~/.agents/skills/example/SKILL.md`.
- **Assert**: The `.shofer/skills/` version takes priority.

### E6 — `.shofer/worktrees/` is inside `.shofer/` so write-protected

- Ask the AI to `write_to_file .shofer/worktrees/tmp/file.txt` with content.
- **Assert**: The write requires approval (`.shofer/**` is a protected pattern).

### E7 — Duplicate `.shoferrules*` in `PROTECTED_PATTERNS` (known code issue)

- The pattern `.shoferrules*` appears twice in `ShoferProtectedController.PROTECTED_PATTERNS`.
- **Assert**: `isWriteProtected()` still returns `true` for `.shoferrules` and `.shoferrules-code` (the duplicate is harmless but should be cleaned up).
