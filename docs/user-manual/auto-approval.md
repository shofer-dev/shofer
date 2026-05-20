# Auto-Approval

Shofer's auto-approval system lets you control when the AI agent can act
without asking for permission first. You configure it through a set of toggles
— each controlling a specific category of actions — accessible from the
**AutoApproveDropdown** in the chat input bar.

<!-- XXX: Screenshot — The AutoApproveDropdown open, showing the full list of
     toggle categories (Read-Only, Write, Browser, MCP, Mode Switch, Subtasks,
     Command Execution, Follow-Up Questions) with their on/off states and
     additional options (Outside Workspace, Protected Files, Uncategorized MCP).
     The dropdown should be attached to the gear/sliders icon next to the mode
     selector and API config selector in the ChatTextArea. -->

## How It Works

Every time the agent wants to use a tool, run a command, or ask a follow-up
question, the extension checks your auto-approval settings. The request matches
the **first applicable rule** in this order:

1. Some lightweight actions are **always auto-approved** — they have no side
   effects and don't need explicit permission.
2. If the **master toggle** (`autoApprovalEnabled`) is off, everything goes
   to you for approval.
3. If the master toggle is on, each category toggle is checked.

If a toggle is off, Shofer shows you the tool's parameters and waits for your
**Approve** or **Reject** click before proceeding.

## Toggle Reference

<!-- XXX: Screenshot — The Settings panel (SettingsView) scrolled to the
     "Auto-Approval" section showing all toggles as labelled switches with
     their additional option dropdowns next to them. -->

Each toggle is a simple ON/OFF switch. The table below explains what each one
controls and lists any extra options that refine its behavior.

| Toggle                  | What It Auto-Apprroves                                                                      | Extra Options                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read-Only**           | Reading files, searching code, listing directories, fetching web pages, getting diagnostics | **Outside Workspace** — also allow reading files _outside_ the project folder                                                                                                          |
| **Write**               | Creating, editing, renaming, or deleting files                                              | **Outside Workspace** — allow writing outside the project folder; **Protected Files** — allow modifying `.shoferignore`, `.shofermodes`, `AGENTS.md`, and other sensitive config files |
| **Browser**             | Browser automation tools (navigate, click, screenshot, etc.)                                | —                                                                                                                                                                                      |
| **MCP**                 | MCP (Model Context Protocol) tool calls and resource access                                 | **Uncategorized MCP** — also allow MCP tools that don't have an explicit tool group assigned                                                                                           |
| **Mode Switch**         | Switching the agent between modes (Code, Architect, Debug, etc.)                            | —                                                                                                                                                                                      |
| **Subtasks**            | Spawning, cancelling, and completing background child tasks                                 | —                                                                                                                                                                                      |
| **Command Execution**   | Running shell commands                                                                      | **Allowed Commands** / **Denied Commands** — see [Command Allowlisting](#command-allowlisting) below                                                                                   |
| **Follow-Up Questions** | Auto-selecting the first suggested answer after a countdown                                 | **Timeout** — milliseconds to wait before auto-selecting (e.g., `5000` for 5 seconds); without this, the toggle alone does nothing                                                     |

> **Mode-scoped:** Each mode (Code, Architect, Debug, etc.) has its own set
> of auto-approval toggles. Toggling Read-Only ON in Code mode does NOT
> affect Architect mode. Switch modes via the **ModeSelector** dropdown.
>
> <!-- XXX: Screenshot — Two side-by-side AutoApproveDropdowns: one with
>      Code mode selected and Read-Only + Write ON, another with Architect
>      mode selected and only Read-Only ON. The mode label above each
>      dropdown should make it clear they're independent. -->

## Always Auto-Approved Actions

These actions never require your approval, regardless of toggle state:

| Action                              | Why                                            |
| ----------------------------------- | ---------------------------------------------- |
| **Updating the todo list**          | UI-only, no side effects                       |
| **Loading a skill**                 | Skills must be installed by you first          |
| **Renaming a task**                 | Non-destructive metadata change                |
| **Sending feedback**                | Appends a line to the extension output channel |
| **Checking background task status** | Reads in-memory state only                     |
| **Waiting for background tasks**    | Event-driven, no polling                       |
| **Checking MCP call status**        | Reads in-memory async call state               |
| **Fetching web pages**              | HTTP GET of public URLs                        |
| **Finding files by name**           | Glob matching against workspace index          |
| **Viewing images**                  | Reads a file for visual analysis               |
| **Getting diagnostics**             | Language-server errors/warnings                |
| **Listing changed files**           | Session-local file tracking                    |
| **Project info**                    | Detected languages, frameworks, build system   |
| **Reading project structure**       | Directory tree                                 |
| **Finding code references**         | LSP "find all references"                      |
| **Symbol search**                   | LSP workspace symbols                          |

## Command Allowlisting

The **Command Execution** toggle is a _gate_ — turning it ON by itself does
**not** auto-approve any command. You must also configure **Allowed Commands**
(a list of command prefixes) for the toggle to have any effect.

### How It Works

When enabled, each shell command is split by `&&`, `||`, `;`, `|`, `&`, and
newlines into sub-commands. Each sub-command is matched against your allowlist
and denylist using a **"longest prefix wins"** rule:

<!-- XXX: Screenshot — The Settings panel showing the Command Execution
     section with Allowed Commands (a multi-line text input containing
     "git", "npm run", "go") and Denied Commands (containing "git push",
     "npm run build"). Below it, a sample command "git status && npm test"
     with a green checkmark annotation "auto-approve" and a breakdown
     showing each sub-command match result. -->

| allowedCommands          | deniedCommands | Command              | Result          | Why                                                                                |
| ------------------------ | -------------- | -------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `["git"]`                | `[]`           | `git status`         | ✅ Auto-approve | Allowlist match                                                                    |
| `["git"]`                | `["git push"]` | `git push origin`    | ❌ Auto-deny    | Denylist `"git push"` (10 chars) beats allowlist `"git"` (4 chars)                 |
| `["git push --dry-run"]` | `["git push"]` | `git push --dry-run` | ✅ Auto-approve | Allowlist `"git push --dry-run"` (20 chars) beats denylist `"git push"` (10 chars) |
| `["*"]`                  | `["rm"]`       | `rm -rf /`           | ❌ Auto-deny    | Wildcard `*` matches everything, but denylist entry blocks `rm`                    |
| `["*"]`                  | `[]`           | `echo hello`         | ✅ Auto-approve | Wildcard with no denylist                                                          |
| `["git"]`                | `[]`           | `npm install`        | 🔶 Ask user     | No allowlist match for `npm`                                                       |
| `[]` (empty)             | `[]`           | `anything`           | 🔶 Ask user     | Nothing matches                                                                    |

**Key rules:**

- If the longest match is on the allowlist → approved
- If the longest match is on the denylist → denied
- If both match → whichever prefix is longer wins
- If neither matches → the user is asked
- If **any** sub-command in a chain is denied, the whole chain is denied

### Wildcard `*`

Putting `*` in your allowed commands approves _everything_ — but you can still
block specific commands via the denylist. Denylist entries override `*` when
their prefix is more specific.

### Dangerous Patterns (Never Auto-Approved)

Certain shell patterns are **never** auto-approved, even with
`allowedCommands = ["*"]`. These patterns can execute arbitrary commands
through shell expansion and always require explicit approval:

- `${var@P}` — prompt string expansion (executes embedded commands)
- `${var@Q}`, `${var@E}`, `${var@A}`, `${var@a}` — parameter expansion operators
- `${!var}` — indirect variable references
- `<<<$(...)` or `` <<<`...` `` — here-strings with command substitution
- `=(...)` — Zsh process substitution
- `*(e:...:)`, `?(e:...:)` — Zsh glob qualifiers with code execution

## Cost & Request Limits

Beyond per-tool approval, Shofer also tracks cumulative cost and API request
count. When either exceeds a configured threshold, the user is prompted for
approval regardless of toggle state. Configure these in **Settings → Limits**.

<!-- XXX: Screenshot — The Settings panel showing the Limits section with
     "Maximum Consecutive Auto-Approved Requests" set to 20 and "Maximum
     Consecutive Auto-Approved Cost (USD)" set to 5.00. Below it, a
     BudgetLimitDialog triggered mid-task showing "Request limit reached:
     20 requests. Continue?" with Yes/No buttons. -->

## Security Best Practices

- **Start with toggles OFF** and enable them incrementally as you build trust
  in the agent's behavior.
- **Use the denylist for destructive commands** (`rm`, `git push --force`,
  `shutdown`, `format`) even when you allowlist broadly with `*`.
- **Keep "Protected Files" OFF** unless you genuinely want the agent editing
  your `.shoferrules`, `AGENTS.md`, or VS Code workspace settings.
- **Leave "Outside Workspace" OFF** unless you're comfortable with the agent
  reading or writing files anywhere on your filesystem.
- **Review the Always Auto-Approved list** above — some actions like
  `fetch_web_page` never prompt, so they won't appear in your approval flow.
- **Per-mode configuration matters** — a Write toggle ON in Code mode does
  not grant write in Architect mode. Set up each mode's toggles based on
  what you expect the agent to do in that mode.
