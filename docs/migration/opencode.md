# OpenCode Configuration Reference

OpenCode uses specific file names, directories, and configuration structures to customize behavior, apply coding standards, build automated workflows, define agent permissions, and connect external tools. Because OpenCode natively supports multiple surfaces — including its TUI (Terminal UI), Desktop App, and multi-IDE extensions (via the Agent Client Protocol) — these configuration layers ensure a consistent AI agent experience no matter where you are writing code.

## 1. Global Workspace Custom Instructions

These files serve as the central knowledge base for your project. They are loaded into OpenCode's context to provide essential background on your codebase structure, conventions, and development workflows.

### `AGENTS.md`

**Function:** The primary, open-standard repository-level instructions file. OpenCode automatically generates this file when you run the `init` command in a project directory. It tells all OpenCode primary and subagents about the rules of your repository.

**Note:** If you are migrating from Anthropic's tooling, OpenCode automatically falls back to reading `CLAUDE.md` if `AGENTS.md` does not exist.

**Syntax:** Standard Markdown. Keep it scannable with clear headings.

```markdown
# Development Guide

## Architecture

- Microservices architecture with Node.js/TypeScript
- PostgreSQL for primary data storage

## Coding Conventions

- Prefer functional array methods (flatMap, filter, map) over for loops.
- Do not extract single-use helpers preemptively.
```

## 2. Dedicated AI Agents & Personas

OpenCode ships with built-in primary agents (like Build and Plan) and subagents (like General, Explore, and Scout). However, you can construct custom agents tailored to specific project architectures or global workflows.

### `.opencode/agent/*.md` or `~/.config/opencode/agent/*.md`

**Function:** Defines a custom agent persona. Project-specific agents live in your repository (`.opencode/agent/`), while global agents you want available everywhere live in your home directory (`~/.config/opencode/agent/`). You can invoke these specialized agents to constrain the AI to specific rules and tool boundaries.

**Syntax:** Markdown files containing domain-specific guidelines.

```markdown
# Frontend Architect Rules

- All React components must use strict TypeScript typing for props.
- State management must rely on Zustand, avoiding raw Context API for complex states.
- Ensure styling adheres strictly to the defined Tailwind configuration without inline styles.
```

## 3. Reusable Agent Skills

Skills are specialized, highly-targeted toolkits and workflows that agents can access dynamically. Instead of bloating your primary `AGENTS.md` with niche processes (like how to deploy a specific Docker container or how to run a complex database migration), you can define them as modular skills.

### `.opencode/skill/<name>/SKILL.md`

**Function:** The entrypoint for an OpenCode Skill. OpenCode reads the description in the YAML frontmatter to automatically discover and load the skill (via its built-in skill tool) only when the agent needs it to solve a relevant task. OpenCode discovers these locally, globally, and even reads Claude-compatible `.claude/skills/` directories.

**Syntax:** Markdown with a strict YAML frontmatter header.

```markdown
---
name: "docker-deploy"
description: "Use this skill when asked to containerize an application, write Dockerfiles, or debug Kubernetes deployments."
---

# Execution Steps

1. Always use Alpine Linux as the base image to minimize footprint.
2. Run `npm ci` instead of `npm install` for reproducible builds.
3. Expose port 8080 by default.
```

## 4. Provider, Model & Tool Configuration

Unlike proprietary cloud-only agents, OpenCode is entirely model-agnostic and gives you granular control over what the LLM is allowed to execute on your local machine.

### `opencode.json` (or `opencode.jsonc`)

**Function:** The central configuration file for OpenCode. It manages your LLM providers (Anthropic, OpenAI, OpenRouter, or local models via LM Studio/Atomic Chat), designates default models, and maintains a strict permissions boundary for tools.

**Syntax:** JSON or JSONC format.

```json
{
	"provider": {
		"openai": {
			"models": {
				"gpt-5": {
					"options": {
						"reasoningEffort": "high"
					}
				}
			}
		}
	},
	"permission": {
		"edit": "allow",
		"bash": "ask",
		"lsp": "allow",
		"mymcp_*": "ask"
	}
}
```

## 5. Security & Content Exclusion

Managing what the AI is allowed to read is vital for protecting local environment variables, credentials, and proprietary configurations.

### Repository Content Exclusions

**Function:** OpenCode operates on a privacy-first, local-execution architecture. It does not ingest your code into a centralized training proxy.

**Syntax & Rules:**

OpenCode natively respects your project's `.gitignore` file. If a file is ignored by Git, OpenCode will strictly exclude it from file searches, directory globbing, and read operations. Keeping your local sensitive files (`.env`, `.pem` keys, etc.) tightly tracked in `.gitignore` provides a robust, zero-configuration foundational barrier.

## 6. Model Context Protocol (MCP) & Deep LSP Integration

Because OpenCode operates locally, it handles external tool extensions and workspace integrations through fundamentally different architectural layers than cloud-based tools like GitHub Copilot.

### A. Local and Remote MCP Servers

OpenCode natively embraces the open Model Context Protocol (MCP). Instead of relying on a proprietary cloud marketplace, OpenCode connects directly to standard MCP servers running locally or remotely. You can tightly govern these via the `opencode.json` permissions block, allowing you to enforce mandatory user approval (`ask`) before a risky MCP tool executes.

### B. Live LSP Code Diagnostics

OpenCode goes a step beyond standard terminal tools by integrating directly with your Language Server Protocol (LSP) servers (such as Rust Analyzer, PyRight, or TypeScript). Governed by the `lsp` tool permission, OpenCode intercepts real-time compiler feedback, diagnostics, and type errors, automatically feeding them back to the LLM. This enables the agent to fix syntax errors interactively before you even save the file.

### Comparison: OpenCode vs GitHub Copilot Tool Integration

| Feature               | OpenCode                                                 | GitHub Copilot                                                 |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Protocol Design       | Open Model Context Protocol (MCP)                        | Proprietary GitHub Marketplace Extensions                      |
| Execution Location    | Local JSON-RPC over STDIO or REST                        | Secure HTTPS Webhook endpoints communicating with GitHub Cloud |
| Tool Governance       | Granular (allow/deny/ask) per tool via `opencode.json`   | Account/Enterprise level extension installation                |
| Live Code Diagnostics | Native LSP server integration (compilers, type-checkers) | Primarily relies on pre-execution code analysis                |

## Summary Cheat Sheet

| File / Path                        | Scope            | Primary Purpose                                   |
| ---------------------------------- | ---------------- | ------------------------------------------------- |
| `AGENTS.md` (or `CLAUDE.md`)       | Global Workspace | Always-on coding styles and structural rules.     |
| `opencode.json` / `opencode.jsonc` | Global / Local   | Providers, custom models, and tool permissions.   |
| `.opencode/agent/*.md`             | Project Specific | Custom project personas (e.g., backend expert).   |
| `~/.config/opencode/agent/*.md`    | Global System    | Global personas available across all directories. |
| `.opencode/skill/*/SKILL.md`       | Auto-Discovered  | Reusable, multi-step workflows loaded on-demand.  |
