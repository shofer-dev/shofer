# Claude Code & Claude Cowork Configuration Reference

Just like GitHub Copilot, Claude Code (the official developer CLI tool) and Claude Cowork (the Agentic local workspace environment built into the Claude Desktop App) rely heavily on a structured folder configuration. They organize project rules, settings, custom routines, and workflow extensions under the `.claude/` directory or at the project root.

## 1. Global & Hierarchical Workspace Instructions

Instead of tracking separate files for general profiles, Claude uses structured Markdown to read files detailing both global code standards and folder-scoped contexts.

### `CLAUDE.md` (or `.claude/CLAUDE.md`)

**Function:** The single source of truth for project-level identity, commands, and rules. Claude reads this automatically at the start of a session. Unlike standard custom instructions, it is meant to be factual, not instructional (tell Claude what the codebase _is_, not just what to do). It can also be nested hierarchically (e.g., `/src/api/CLAUDE.md` handles specific module logic).

**Syntax:** Standard Markdown. Keep it under 200 lines for the highest rule adherence.

```markdown
# Project Name & Setup

## Dev Commands

- Build: `npm run build`
- Test: `npm run test`
- Format: `npm run lint --fix`

## Technical Conventions

- Standard export style is named exports, no default exports.
- Use strict TypeScript; explicitly type all public API surfaces.
```

**Tip:** You can type `/memory` directly in a live Claude Code CLI session to instantly open and modify this file.

## 2. Granular Rules & Path Scoping

To keep your root `CLAUDE.md` slim, Claude supports targeted rule sets that load dynamically based on the directory or task context.

### `.claude/rules/*.md`

**Function:** Houses modular rules applied when working on matching paths, patterns, or language stacks.

**Syntax:** Markdown file containing a YAML frontmatter block that defines `description` qualifiers or file glob paths.

```markdown
---
description: "Database schema and migration rules"
applyTo: "src/db/**/*.ts"
---

# Migration Requirements

- Never alter existing table columns directly; always write an additive migration.
- Always include down/rollback steps for every schema change.
```

## 3. Tool Settings and Behavior Configuration

Claude tracks local preferences, security configurations, and permissions through standard JSON environments.

### `.claude/settings.json`

**Function:** Centralized configuration checked into version control to align tool settings, security boundaries, and model hooks for the entire team.

**Syntax:** Strict JSON validated against Claude's schema.

```json
{
	"$schema": "https://code.claude.com/schema/settings.json",
	"watchAndReload": true,
	"hooks": {
		"postEdit": "npm run lint --fix"
	}
}
```

### `.claude/settings.local.json`

**Function:** Overrides team-wide settings with your personal machine configurations or experimental developer hooks.

**Syntax:** Same format as `settings.json`. Claude Code automatically configures Git to safely ignore this file upon generation so you don't accidentally check it in.

## 4. Custom Agents & Specialized Task Scopes

Claude lets you isolate context or spin up focused workflows using defined agent configurations.

### `.claude/subagents/*.json` or `.claude/subagents/*.md`

**Function:** Defines specialized profiles or limits context when Claude Code spins up sub-processes to solve modular tasks independently.

**Syntax:** JSON or Markdown frontmatter detailing the specific tools, system prompts, and boundary constraints of that sub-agent.

```json
{
	"name": "security-auditor",
	"systemPrompt": "You are a secure code reviewer. Analyze the file changes for dependencies with known CVEs.",
	"allowedTools": ["fileViewer"]
}
```

## 5. Standardized AI Skills

Claude implements the same cross-platform Agent Skills Open Standard format to execute multi-step procedures.

### `.claude/skills/[skill-name]/SKILL.md`

**Function:** Teaches Claude a reusable execution strategy. It can be triggered manually in chat via `/skill-name` or picked up automatically by Claude based on the YAML description matching your prompt.

**Syntax:** YAML frontmatter parameters followed by procedural instruction steps.

```markdown
---
name: "generate-unit-test"
description: "Use this skill when asked to create an automated test file or mock suite for a newly introduced module."
---

# Checklist Steps

1. Locate the index or target file.
2. Generate a matching `.spec.ts` or `.test.ts` alongside it.
3. Use Vitest utilities for mocking HTTP responses.
```

**Note:** The directory can also hold supplemental script files, templates, or expected golden format layouts (e.g., `.claude/skills/generate-unit-test/mock-template.ts`).

## 6. Model Context Protocol (MCP) Integration

Claude Code natively supports a repository-level configuration file called `.mcp.json` at your project root. This allows you to check in codebase-specific tools (like a local database explorer or project linter) that spin up automatically for anyone working on the repository. Claude communicates with MCP servers via JSON-RPC over local process communication (STDIO/SSE).

### `.mcp.json`

**Function:** Declares repository-scoped Model Context Protocol servers. This connects Claude to tools specific to this single codebase without adding them globally to your computer.

**Syntax:** Structured JSON matching Anthropic's standard MCP host schema. Each server entry specifies a `command`, `args`, and optionally `env` for environment variables.

```json
{
	"mcpServers": {
		"sqlite-db-explorer": {
			"command": "uvx",
			"args": ["mcp-server-sqlite", "--db-path", "./data/dev.db"]
		},
		"custom-project-tool": {
			"command": "node",
			"args": ["./scripts/mcp-tool-server.js"],
			"env": {
				"API_SECRET_KEY": "local_dev_key"
			}
		}
	}
}
```

**Protocol:** JSON-RPC local process communication (STDIO/SSE). Unlike Copilot (which uses HTTPS webhooks for cloud-hosted extensions), Claude runs MCP servers as local subprocesses, giving it direct access to your filesystem and terminal.

## 7. Execution Inclusions

### `.worktreeinclude`

**Function:** Explicitly dictates to the agent which uncommitted files or dynamically generated structures inside the project root boundary are safe to crawl or include in its analysis maps, serving as an explicit opt-in mechanism.

**Syntax:** Matches the traditional line-by-line file pattern format of a `.gitignore` file.

## Summary Directory Cheat Sheet

| File / Directory Path                                 | Layer / Target   | Primary Capability                                                |
| ----------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `CLAUDE.md`                                           | Workspace Root   | Core project orientation, run/test commands, conventions.         |
| `.claude/rules/*.md`                                  | Path/Task Scoped | Granular formatting rules based on directory target patterns.     |
| `.claude/settings.json`                               | Project / Team   | Checked-in tool permissions, settings, and lifecycle hooks.       |
| `.claude/settings.local.json`                         | Developer Local  | Local setup variations, ignored automatically by source control.  |
| `.claude/subagents/*.json` / `.claude/subagents/*.md` | On-Demand        | Specialized profiles with bounded tool access and system prompts. |
| `.claude/skills/*/SKILL.md`                           | Intent Matching  | Multi-step task automation scripts and templated instructions.    |
| `.mcp.json`                                           | Project Tools    | Codebase-specific database or terminal protocol connections.      |
| `.worktreeinclude`                                    | Working Tree     | Opts-in untracked files into Claude's discovery context.          |
