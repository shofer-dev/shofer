# GitHub Copilot Configuration Reference

GitHub Copilot uses several specific file names, directories, and extensions within your repository to customize behavior, apply coding standards, build automated workflows, or exclude sensitive paths.

These configuration layers apply across IDEs (VS Code, JetBrains), the Copilot CLI, and Copilot's cloud/agent environments.

## 1. Global Workspace Custom Instructions

These files are loaded into Copilot's context for every chat or code generation request in the workspace. They are ideal for stating domain rules, tech stack choices, and architecture patterns.

### `.github/copilot-instructions.md`

**Function:** The primary, GitHub-specific repository-level instructions file. Automatically detected by VS Code and Copilot Cloud.

**Syntax:** Standard Markdown. Keep it scannable with clear headings.

```markdown
# Engineering Standards

## Tech Stack

- Frontend: TypeScript, React, Tailwind CSS
- State Management: Zustand

## Coding Style

- Prefer functional components over classes.
- Use explicit error boundaries for async calls.
```

### `AGENTS.md`

**Function:** An open-standard fallback alternative to `copilot-instructions.md` placed in the repository root. It provides cross-platform instructions recognized by Copilot and other AI assistant platforms.

**Syntax:** Standard Markdown.

```markdown
# Project Conventions

- All internal utilities should be written in Go.
- Use the standard layout layout pattern for package structures.
```

## 2. Granular & Targeted Instructions

If you need rules that apply only to specific file types, directories, or distinct engineering tasks, use targeted instruction files.

### `.github/instructions/*.instructions.md`

**Function:** Topic-specific or framework-specific instructions. Copilot matches these dynamically based on file patterns or the task at hand.

**Syntax:** Markdown with a YAML frontmatter block at the top containing an `applyTo` glob pattern.

```markdown
---
description: "Angular development standards"
applyTo: "src/app/**/*.ts"
---

# Angular Rules

- Always use standalone components.
- Enforce strict typing on RxJS streams.
```

## 3. Dedicated AI Agents & Personas

Custom agents allow you to spin up specialized "teammates" (like a dedicated security auditor, a reviewer, or a DevOps specialist) that can be invoked via chat commands.  
[GitHub Docs](https://docs.github.com/en/copilot)

### `.github/agents/*.agent.md` or `*.agent.md`

**Function:** Defines a custom agent persona, its specific system prompts, and tool boundaries. You can summon it in Copilot Chat using `/name-of-agent`.

**Syntax:** Markdown with YAML frontmatter to declare the agent's behavior and traits.

```markdown
---
name: "terraform-expert"
description: "Architectural reviewer for Terraform and cloud infrastructure"
tools: ["terminal", "file-viewer"]
---

# Instructions

You are an expert Cloud Architect. When analyzing infrastructure files:

1. Validate against AWS Well-Architected frameworks.
2. Ensure no hardcoded secrets or open ingress rules (0.0.0.0/0) exist.
```

## 4. Reusable Agent Skills

Skills are self-contained modular toolkits designed to teach Copilot specific multi-step workflows. Unlike instructions, they can bundle external scripts, templates, and reference materials.

### `.github/skills/[skill-name]/SKILL.md`

**Function:** The entrypoint for an Agent Skill. The `description` is critical; Copilot relies on it to automatically discover and load the skill when a user asks a matching question.

**Syntax:** Markdown with a strict YAML frontmatter header.

```markdown
---
name: "add-error-handling"
description: "Use this skill when asked to add error handling, catch clauses, or logging wrappers to code blocks following team specifications."
---

# Execution Steps

1. Inspect the chosen code block for unhandled promises or throw statements.
2. Wrap synchronous operations in try/catch blocks.
3. Use the centralized `@error-utils.ts` wrapper for logging.
```

**Note:** The parent folder can contain supporting materials (e.g., `.github/skills/add-error-handling/template.ts` or `script.sh`) which Copilot will pull on-demand only when referenced inside `SKILL.md`.

## 5. Security & Content Exclusion

Managing what the AI is allowed to read is vital for protecting local environment variables and proprietary configurations.  
[GitHub Docs](https://docs.github.com/en/copilot)

### Repository Content Exclusions

**Function:** Prevents Copilot from reading, indexing, or using sensitive files (like `.env`, private keys, or internal credential stores) as prompt context.

**Syntax & Rules:**

While individual developers frequently request a local `.copilotignore` file, official enterprise-grade content exclusions are currently managed via the GitHub UI (**Settings > Copilot > Content exclusion**) rather than a loose working tree file to guarantee secure enforcement across teams.

However, Copilot strictly honors your project's `.gitignore` file for many workspace features (such as import maps or CLI file searches), meaning keeping your local sensitive files tightly tracked in `.gitignore` provides a solid foundational barrier.

## 6. Model Context Protocol (MCP) & External Tools

GitHub Copilot does **not** use a local workspace file like `.mcp.json` to configure tools or protocols. Instead, Copilot handles external tool extensions and integrations through two entirely different architectural layers.

### A. Copilot Extensions (Cloud & Chat Ecosystem)

Instead of running a local MCP server process, GitHub exposes tools as **Copilot Extensions**. These are built as standard HTTPS webhook services hosted on a server or cloud function and are integrated globally via the GitHub Marketplace.

**Syntax/Configuration:** Handled in a centralized manifest file (`github-extension.json` or `manifest.json`) when developing an extension, rather than sitting in your project's working tree. The communication protocol is secure HTTPS webhook endpoints communicating with GitHub Cloud — not local JSON-RPC over STDIO.

### B. Agentic Skills (Local Execution)

For local automation scripts or task-specific tooling running on your machine, Copilot expects you to declare those boundaries in the YAML frontmatter of a Skill file (see §4 above) rather than an MCP configuration block. Use the `tools` field to grant terminal or file access:

```markdown
---
name: "run-project-linter"
description: "Use this skill to clean up formatting errors or check code quality hooks."
tools: ["terminal"]
---

# Execution Steps

1. Run `npm run lint --fix` in the root directory.
2. Check the output for any remaining breaking failures.
```

### Comparison: Claude vs Copilot Tool Integration

| Feature                | Claude Code / Cowork                                            | GitHub Copilot                                                 |
| ---------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Local Config File      | `.mcp.json` at repository root                                  | None (uses global GitHub Marketplace extensions)               |
| Protocol Design        | JSON-RPC local process communication (STDIO/SSE)                | Secure HTTPS Webhook endpoints communicating with GitHub Cloud |
| Local Script Execution | Handled seamlessly inside `.mcp.json` via `node`/`python`/`uvx` | Handled via execution scripts bundled inside `.github/skills/` |

## Summary Cheat Sheet

| File / Path                              | Scope            | Primary Purpose                                   |
| ---------------------------------------- | ---------------- | ------------------------------------------------- |
| `.github/copilot-instructions.md`        | Global Workspace | Always-on coding styles and structural rules.     |
| `AGENTS.md`                              | Global Workspace | Cross-platform alternative for overall rules.     |
| `.github/instructions/*.instructions.md` | Targeted Globs   | Rules for specific file types or folders.         |
| `.github/agents/*.agent.md`              | On-Demand (`/`)  | Custom persona definitions and tool constraints.  |
| `.github/skills/*/SKILL.md`              | Auto-Discovered  | Complex, reusable workflows with bundled scripts. |
