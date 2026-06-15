# GitHub Copilot Configuration Reference

GitHub Copilot utilizes specific files, directories, and extension configurations within your repository to customize behavioral rules, apply coding standards, and orchestrate cloud-hosted agents.

These configuration layers apply across modern IDE surfaces, the Copilot CLI, and Copilot's automated background environments.

## 1. Global Workspace Custom Instructions & Memory

These assets supply Copilot with continuous context regarding workspace identity, architectural layout, and engineering constraints.

### `.github/copilot-instructions.md`

**Function:** The primary, GitHub-specific repository-level instructions file. Automatically detected across modern IDE installations and Copilot Cloud pipelines.

**Syntax:** Standard Markdown. Keep it scannable with clear headings.

```markdown
# Engineering Standards

## Tech Stack

- Frontend: TypeScript, React, Tailwind CSS
- State Management: Zustand

## Coding Style

- Prefer functional components over classes.
```

### Copilot Memory (Cloud-Synced Graph)

**🧠 Cross-Session Persistence:** Beyond static files, Copilot relies on Copilot Memory (available across Pro/Enterprise profiles). This repository-scoped, cloud-synced memory graph captures coding styles, shared internal abstractions, and cross-file dependencies automatically over a rolling 28-day window across the IDE, CLI, and Code Review surfaces.

## 2. Granular & Targeted Instructions

If you need rules that apply only to specific file types, directories, or distinct engineering tasks, use targeted instruction files.

### `.github/instructions/*.instructions.md`

**Function:** Topic-specific instructions matched dynamically by Copilot based on active file patterns or specific task domains.

**Syntax:** Markdown with a YAML frontmatter block at the top containing an `applyTo` glob pattern.

```markdown
---
description: "Angular development standards"
applyTo: "src/app/**/*.ts"
---

# Angular Rules

- Always use standalone components.
```

## 3. Agent Sessions & Autonomous Cloud Agents

Copilot features an advanced background orchestration tier that abstracts human-to-AI interaction into independent, non-blocking units of work.

### `.github/agents/*.agent.md` or `*.agent.md`

**Function:** Outlines custom agent personas invoked in chat windows using `/name-of-agent`.

**Syntax:** Markdown with YAML frontmatter to declare the agent's behavior, traits, and tool boundaries.

```markdown
---
name: "terraform-expert"
description: "Architectural reviewer for Terraform and cloud infrastructure"
tools: ["terminal", "file-viewer"]
---

# Instructions

Validate infrastructure layouts against AWS Well-Architected frameworks.
```

### Copilot Cloud Agents (Asynchronous Sessions)

When developers initialize complex workflows or deep codebase changes, Copilot handles these via **Agent Sessions**. This model spins up autonomous Cloud Agents running inside ephemeral, isolated GitHub Actions environments for up to 59 minutes, executing multi-file tasks and compiling code in the background without locking up the local editor session.

## 4. Reusable Agent Skills

Skills are self-contained modular toolkits designed to teach Copilot specific multi-step workflows.

### `.github/skills/[skill-name]/SKILL.md`

**Function:** Self-contained toolkits mapping multi-step execution graphs. Copilot auto-discovers and reads the `description` block to fetch the skill whenever a matching request is issued.

**Syntax:** Markdown with a strict YAML frontmatter header.

```markdown
---
name: "add-error-handling"
description: "Use this skill when asked to add error handling following team specifications."
---

# Execution Steps

1. Synchronize target block anomalies.
2. Inject standardized logging parameters via `@error-utils.ts`.
```

## 5. Security & Content Exclusion

Managing what the AI is allowed to read is vital for protecting local environment variables and proprietary configurations.

### Repository Content Exclusions

**Function:** Blocks Copilot from loading, processing, or indexing highly sensitive repository structures (such as private encryption keys or `.env` scopes) into prompt data.

**Governance:** Official enterprise-grade exclusions are configured globally through the GitHub UI (**Settings > Copilot > Content exclusion**) to guarantee standardized enforcement across teams. Locally, Copilot strictly honors your project's `.gitignore` rules during routine codebase indexing and file scans.

## 6. Cloud Extensions & Tool Integration

GitHub Copilot bypasses local protocol configuration files in favor of remote, securely managed cloud integrations.

### A. Copilot Extensions (Marketplace Integration)

Tools are exposed as web services using the Agent Client Protocol (ACP) ecosystem or HTTPS webhook architectures. Configurations are managed via remote application manifests (`manifest.json`) in the GitHub Marketplace, communicating directly via secure cloud webhooks rather than local STDIO loops.

### B. Curated Multi-Model Engines

Copilot utilizes a metered, usage-based credit billing structure linked to a curated frontier model lineup. Users draw from their credit balance based on model performance weights (featuring frontier OpenAI and Anthropic pairs), while legacy platforms like Google Gemini have been retired from the core selector to guarantee tight ecosystem optimizations.

### Comparison: Claude vs Copilot Tool Integration

| Feature           | Claude Code / Cowork                              | GitHub Copilot                                               |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Local Config File | `.mcp.json` at repository root                    | None (uses global GitHub Marketplace extensions)             |
| Protocol Design   | JSON-RPC local process communication (STDIO/SSE)  | Secure HTTPS Webhook / ACP Protocol via GitHub Cloud         |
| Execution Vector  | Local background subprocesses or native worktrees | Cloud Agents running in isolated GitHub Actions environments |
| Context Model     | Local persistent AST-aware embedding database     | Cloud-synced 28-day repository memory graph                  |

## Summary Cheat Sheet

| File / Path                              | Scope            | Primary Purpose                                           |
| ---------------------------------------- | ---------------- | --------------------------------------------------------- |
| `.github/copilot-instructions.md`        | Global Workspace | Always-on styling bounds and architectural patterns.      |
| `.github/instructions/*.instructions.md` | Targeted Globs   | Structural rules mapped to specific file components.      |
| `.github/agents/*.agent.md`              | On-Demand (`/`)  | Custom persona parameters and explicit tool restrictions. |
| `.github/skills/*/SKILL.md`              | Auto-Discovered  | Procedural, reusable multi-step automation scripts.       |
