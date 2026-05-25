# Assistant Agent

The **Assistant Agent** is a persistent, read-only AI companion that builds up codebase knowledge over time and answers questions across tasks — even across VS Code restarts.

## What It Does

- Runs on a **low-cost model with a large context window** (you choose the model)
- Survives task completion and VS Code restarts — conversation history is persisted
- Learns organically: each question adds context, building an ever-richer understanding of your codebase
- **Strictly read-only** — can only read files, search code, and look up symbols. Cannot write, execute, or use MCP tools

## How to Use It

Tasks ask the Assistant Agent via the [`ask_assistant_agent`]() tool:

> _"What does the UserService class do and where is it defined?"_

The agent answers from its accumulated knowledge without the calling task having to re-load files into its own context window. This saves tokens and keeps the main task focused.

## Setup

1. Open **Settings** → enable the Assistant Agent
2. Choose a lightweight model (e.g., Gemini Flash, GPT-4o-mini)
3. The agent starts with an empty context and fills it as tasks ask questions

The **Assistant Agent Status** badge in the Shofer sidebar shows whether the agent is active and processing.

## Key Benefits

- **Context reuse** — knowledge persists across tasks, no redundant file loading
- **Cost efficient** — uses a cheap model; each answer costs a fraction of a cent
- **KV-cache friendly** — append-only context window keeps the provider's attention cache warm
- **File-aware** — notified of file changes to keep its knowledge fresh

[Read the full Assistant Agent documentation](https://github.com/shofer-dev/shofer/blob/master/docs/assistant_agent.md)
