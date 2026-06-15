# Claude Code & Claude Cowork Configuration Reference

Claude Code (the developer CLI tool) and Claude Cowork (the agentic local workspace environment built into the Claude Desktop App) rely on a structured folder configuration. They organize project rules, settings, custom routines, and workflow extensions under the `.claude/` directory or at the project root. In the current ecosystem, these tools leverage advanced local-first execution combined with autonomous background tasks, reducing human-in-the-loop friction through adaptive risk classification.

## 1. Global & Hierarchical Workspace Instructions

Instead of tracking separate files for general profiles, Claude uses structured Markdown to read files detailing both global code standards and folder-scoped contexts.

### `CLAUDE.md` (or `.claude/CLAUDE.md`)

**Function:** The single source of truth for project-level identity, commands, and rules. Claude reads this automatically at the start of a session. It is meant to be factual, detailing what the codebase _is_, and can be nested hierarchically (e.g., `/src/api/CLAUDE.md` handles specific module logic).

**💡 Auto Memory Convergence:** While manual edits to `CLAUDE.md` are fully respected, Claude Code features Auto Memory. As the agent works, it autonomously tracks, saves, and updates build behaviors, successful commands, and debugging insights across independent sessions without requiring manual documentation.

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

**🛡️ Auto Mode Governance:** This file configures Claude's native Auto Mode classifiers. Auto Mode evaluates system risk levels automatically — safely bypassing manual permission prompts for ~83% of standard operations while maintaining strict blockades on highly destructive shell behaviors.

**Syntax:** Strict JSON validated against Claude's schema.

```json
{
	"$schema": "https://code.claude.com/schema/settings.json",
	"watchAndReload": true,
	"autoMode": {
		"enabled": true,
		"riskClassifier": "default"
	},
	"hooks": {
		"postEdit": "npm run lint --fix"
	}
}
```

### `.claude/settings.local.json`

**Function:** Overrides team-wide settings with your personal machine configurations or experimental developer hooks. Claude Code automatically configures Git to safely ignore this file upon generation.

## 4. Custom Agents & Parallel Task Orchestration

Claude lets you isolate context, spin up focused workflows, or break down large-scale operations across independent sandboxes.

### `.claude/subagents/*.json` or `.claude/subagents/*.md`

**Function:** Defines specialized profiles or limits context when Claude Code spins up sub-processes to solve modular tasks independently.

**Batch Execution & Native Worktrees:** Through the `/batch` engine, Claude natively orchestrates complex architectural changes. Large tasks are automatically decomposed into isolated background units, each executing within its own dynamically managed Git worktree, keeping your main workspace clean.

```json
{
	"name": "security-auditor",
	"systemPrompt": "You are a secure code reviewer. Analyze the file changes for dependencies with known CVEs.",
	"allowedTools": ["fileViewer"]
}
```

## 5. Standardized AI Skills

Claude implements the cross-platform Agent Skills Open Standard format to execute multi-step procedures.

### `.claude/skills/[skill-name]/SKILL.md`

**Function:** Teaches Claude a reusable execution strategy. It can be triggered manually via `/skill-name` or picked up automatically by Claude based on the YAML description matching your prompt.

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

## 6. Model Context Protocol (MCP) Integration

Claude Code natively supports a repository-level configuration file called `.mcp.json` at your project root. This connects Claude to tools specific to this single codebase without adding them globally to your computer.

### `.mcp.json`

```json
{
	"mcpServers": {
		"sqlite-db-explorer": {
			"command": "uvx",
			"args": ["mcp-server-sqlite", "--db-path", "./data/dev.db"]
		}
	}
}
```

**Protocol:** JSON-RPC local process communication (STDIO/SSE). Claude runs MCP servers as local subprocesses, granting direct access to your filesystem and terminal environment.

## Summary Directory Cheat Sheet

| File / Directory Path                                 | Layer / Target   | Primary Capability                                                 |
| ----------------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `CLAUDE.md`                                           | Workspace Root   | Core orientation, commands, and Auto Memory tracking.              |
| `.claude/rules/*.md`                                  | Path/Task Scoped | Granular formatting rules based on directory target patterns.      |
| `.claude/settings.json`                               | Project / Team   | Checked-in tool permissions, Auto Mode caps, and hooks.            |
| `.claude/subagents/*.json` / `.claude/subagents/*.md` | On-Demand        | Bounded tool access, specialized profiles, and `/batch` worktrees. |
| `.claude/skills/*/SKILL.md`                           | Intent Matching  | Multi-step task automation scripts and templated instructions.     |
| `.mcp.json`                                           | Project Tools    | Codebase-specific database or terminal protocol connections.       |
