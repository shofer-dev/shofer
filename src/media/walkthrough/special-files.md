# Special Files

Shofer recognizes several files that control its behavior. These files are **write-protected** — Shofer cannot modify them without your explicit approval.

All Shofer-specific configuration files live under the `.shofer/` directory. `AGENTS.md` remains at the workspace root as it is an ecosystem convention shared across AI coding tools.

## Key Files

| File                      | Purpose                                              |
| ------------------------- | ---------------------------------------------------- |
| `.shofer/shoferignore`    | Hide files from Shofer (same syntax as `.gitignore`) |
| `.shofer/shofermodes`     | Define custom AI modes for your project              |
| `.shofer/worktreeinclude` | Files to copy into new worktrees                     |
| `AGENTS.md`               | Project rules injected into every task               |

## The `.shofer/` Directory

| Path                    | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `.shofer/rules/`        | Mode-agnostic rules (always active)            |
| `.shofer/rules-<mode>/` | Rules for a specific mode (e.g. `rules-code/`) |
| `.shofer/commands/`     | Custom slash commands                          |
| `.shofer/skills/`       | Domain-specific skill instructions             |
| `.shofer/mcp.json`      | Per-project MCP server configuration           |

## What "Write-Protected" Means

Shofer can read these files but cannot edit them without approval — even with auto-approval enabled. This protects your configuration from accidental changes by the AI.
