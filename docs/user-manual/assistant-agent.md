# Assistant Agent

The Assistant Agent is a **persistent, read-only AI companion** that lives inside
your Shofer workspace. It accumulates knowledge about your codebase over time,
answering questions from your main coding agents without them having to re-read
files they've already seen. Think of it as a long-term memory for your AI
assistants — it runs on a separate, cost-optimized model with a very large
context window, keeping token costs low while staying informed.

## What It Does

- **Answers codebase questions** — Shofer tasks call [`ask_assistant_agent`](#the-ask_assistant_agent-tool) to ask about your project: "What does UserService do?", "Where is auth logic?", "List the public API of PaymentHandler."
- **Accumulates knowledge** — each question and answer is remembered. The agent's context window fills organically as tasks ask questions, so it gets smarter over time.
- **Stays aware of changes** — when Shofer tools modify files, or when you edit files externally, the agent is notified. It won't blindly trust stale content.
- **Persists across restarts** — the agent's conversation history survives VS Code restarts. When you re-open your workspace, it picks up right where it left off.

## How It Differs from `rag_search`

|                       | `rag_search`                                     | Assistant Agent                                             |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| **How it works**      | Vector search over indexed code                  | Conversational Q&A with persistent memory                   |
| **Best for**          | Finding code by meaning across the whole project | Follow-up questions, multi-turn exploration                 |
| **Remembers context** | No — each search is independent                  | Yes — conversation history accumulates                      |
| **Tool access**       | N/A (returns snippets)                           | Has full read-only tool access (can read files, grep, etc.) |
| **Cost model**        | Per-embedding                                    | Per-token chat; cumulative cost tracked                     |

Both tools are complementary — `rag_search` is great for initial discovery, the
Assistant Agent is great for deeper investigation.

## Quick Start

### 1. Link an API Configuration Profile

The Assistant Agent needs an LLM to run. It uses **any API Configuration profile**
you've already set up in Shofer — just pick one:

1. Open **Settings** (gear icon in the toolbar, or `Ctrl+,`).
2. Under **Providers**, create or select an API Configuration profile (e.g., "openrouter"
   with Claude Haiku, or "gemini" with Gemini Flash).
3. Under **Assistant Agent**, select that profile from the **Linked Profile** dropdown.

> **💡 Model choice:** The Assistant Agent is designed for cheap, large-context models.
> Ideal choices: Gemini 2.0 Flash (1M token window), GPT-4o-mini (128K), Claude Haiku.
> A 128K+ context window is recommended for best results.

<!-- XXX: Screenshot — SettingsView scrolled to the "Assistant Agent" section,
     showing the "Enabled" toggle ON, the "Linked Profile" dropdown with a
     provider selected, and the optional "Max Context Tokens" override field.
     The "Context Fill Threshold" slider should be visible at 80%. -->

### 2. Enable the Agent

Toggle **Assistant Agent → Enabled** to ON. The agent will start initializing
immediately. You'll see the status badge in the chat input toolbar change.

<!-- XXX: Screenshot — The Shofer chat-input toolbar (ChatTextArea) showing the
     AssistantAgentStatusBadge with a "Ready" state indicator and a percentage
     (e.g., "Ready (0%)" on first start). -->

### 3. That's It

Your coding agents will now automatically use
[`ask_assistant_agent`](#the-ask_assistant_agent-tool) when they need codebase
knowledge. You don't need to do anything else — the agent works behind the
scenes.

## Toolbar Badge & Popover

The Assistant Agent's status badge lives in the **chat input toolbar** (the row
of controls at the bottom of the chat). It shows:

| State                 | What It Means                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------ |
| **Standby**           | Agent is configured but not started. Click to start it.                                    |
| **Initializing...**   | Agent is starting up — loading config, restoring conversation.                             |
| **Ready (42%)**       | Agent is idle, waiting for questions. The percentage shows how full its context window is. |
| **Busy (42%)**        | Processing a question. The badge pulses to show activity.                                  |
| **Nearly Full (87%)** | Context window is above the fill threshold — truncation may happen soon.                   |
| **Error**             | Configuration or connection issue. Click the badge for details.                            |

<!-- XXX: Screenshot — A close-up of the AssistantAgentStatusBadge in the
     toolbar, annotated with callouts for the state text, percentage fill,
     and pulsing animation. Show two states side by side: Ready (0%) and
     Busy (35%). -->

### Popover

Click the badge to open a popover with detailed information:

- **Current state** and model name
- **Context usage bar** — visual progress bar showing `current / max` tokens
- **Context window source** — shows whether the token limit came from the model's
  reported context window, an override, or is unresolved
- **Cost tracking** — total input/output/truncated tokens and estimated USD cost
- **Files in context** — list of files the agent currently knows about
- **Quick Actions:**
    - **Start / Stop** — control agent lifecycle
    - **View Chat** — open the dedicated chat panel
    - **Clear Context** — reset the conversation (preserves cost tracking)
    - **Open Settings** — jump to the Assistant Agent settings section

<!-- XXX: Screenshot — The AssistantAgentPopover opened from the badge, showing
     the context usage bar at ~35%, the cost tracking row, the file list, and
     the Quick Actions buttons at the bottom. -->

## Chat View Panel

The **View Chat** action opens a dedicated read-only panel showing everything the
Assistant Agent has seen and done:

- **Full conversation history** — every question/answer pair, newest at the bottom
- **Live streaming** — when the agent is Busy, you can watch answers stream in
  token-by-token, including reasoning (collapsible) and tool calls (expandable)
- **Message metadata** — which task asked the question, timestamps, file references
- **Context sidebar** — files in context with token estimates, token usage bar

The panel is **read-only** — you can't send messages directly. All interaction
happens through the `ask_assistant_agent` tool used by your coding agents. This
keeps the context window clean and predictable.

<!-- XXX: Screenshot — The AssistantAgentChatPanel showing a conversation with
     2-3 Q&A pairs. The latest assistant response should be streaming (partial
     text visible), with a reasoning block collapsed above it and a tool_call
     block expanded below showing file contents. The context sidebar on the
     right should show 3 files with token estimates. -->

## The `ask_assistant_agent` Tool

Your coding agents use this tool automatically. You don't need to invoke it
yourself, but understanding its parameters helps you know what to expect:

| Parameter          | Required | Default        | Description                                                      |
| ------------------ | -------- | -------------- | ---------------------------------------------------------------- |
| `question`         | Yes      | —              | The question to ask about the codebase.                          |
| `contextFiles`     | No       | —              | File paths to load into context before answering.                |
| `timeoutMs`        | No       | 300000 (5 min) | Hard time limit for an answer. If exceeded, the call is aborted. |
| `softTimeoutSec`   | No       | 60             | Hint for how long the agent should spend (not enforced).         |
| `softResultLength` | No       | 2000           | Hint for max answer length in characters (not enforced).         |

The tool is **auto-approved** — it never requires your manual approval, since it
uses a separate, cost-optimized model and is strictly read-only.

## Context Window & Truncation

The Assistant Agent has a **context window** — the maximum number of tokens it
can "remember" at once. By default, this is set to the model's reported context
window (e.g., 128K for GPT-4o-mini, 1M for Gemini Flash).

### How the Window Fills

1. Each question and answer takes up tokens in the window.
2. Files loaded into context (via `contextFiles` or the agent's own `read_file`
   calls) also consume tokens.
3. The **directory tree** of your workspace is always present (~10% of the window).

### Fill Threshold Warning

When the window reaches **80% full** (configurable), the badge shows "Nearly Full"
and questions carry a warning. This is your cue that old conversations will soon
be dropped.

### Truncation Policy

When the window is full, the agent **truncates** — it simply drops the oldest
content. There is no summarization or compression:

1. Least-recently-referenced **file contexts** are dropped first.
2. If still over budget, the oldest **conversation turns** are dropped next.
3. A marker message is inserted: _"[N earlier messages were truncated due to context limit]"_

Truncated content is permanently lost from the agent's memory. The **system
prompt** (including the workspace directory tree) is never truncated.

### Clear Context

If you want to reset the agent's memory entirely, use the **Clear Context**
button in the popover or run the `Shofer: Assistant Agent: Clear Context`
command. This drops all messages and file contexts but preserves the cost
tracking. The agent starts fresh with just the system prompt and directory tree.

## Cost Tracking

The Assistant Agent tracks cumulative token usage and estimated cost across its
entire lifecycle, including across VS Code restarts:

- **Total input tokens** — tokens sent to the model (questions, file contents, conversation history)
- **Total output tokens** — tokens generated by the model (answers)
- **Total truncated tokens** — tokens dropped by context window enforcement
- **Estimated cost (USD)** — calculated from the provider's published per-token pricing

Cost information is visible in:

- The **popover** (click the toolbar badge)
- The **chat view panel** (context sidebar)
- The **Settings** page

> **💡 Note:** The cost estimate depends on the provider publishing pricing data.
> For local models (Ollama) or custom OpenAI-compatible endpoints, fallback
> conservative estimates are used.

## Configuration Reference

| Setting                    | Default           | Description                                                                                   |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| **Enabled**                | `true`            | Master on/off toggle.                                                                         |
| **Linked Profile**         | _(none)_          | API Configuration profile providing credentials and model selection.                          |
| **Max Context Tokens**     | _(model default)_ | Optional override for the context window size. Leave unset to use the model's reported limit. |
| **Context Fill Threshold** | `0.80` (80%)      | Fraction at which the "Nearly Full" warning triggers.                                         |

## Commands

All Assistant Agent commands are available via the Command Palette (`Ctrl+Shift+P`):

| Command                                  | Action                                                |
| ---------------------------------------- | ----------------------------------------------------- |
| `Shofer: Assistant Agent: Start`         | Start the agent from Standby state.                   |
| `Shofer: Assistant Agent: Stop`          | Stop the agent and cancel all pending questions.      |
| `Shofer: Assistant Agent: Clear Context` | Reset the conversation to just the system prompt.     |
| `Shofer: Assistant Agent: Show Chat`     | Open the dedicated chat view panel.                   |
| `Shofer: Assistant Agent: Open Settings` | Open Settings focused on the Assistant Agent section. |

## File Awareness & KV-Cache Preservation

The Assistant Agent stays aware of file changes without invalidating its
attention cache (which would slow down subsequent requests and increase cost):

- **External edits** — if you edit files in VS Code or via git, a file watcher
  detects the change and marks the file as stale. The agent will re-read it
  when needed.
- **Shofer tool edits** — when Shofer tools modify files (via `write_to_file`,
  `apply_diff`, etc.), the agent is notified. Files are NOT evicted from
  context — instead, a "recently modified" hint is attached to the next
  question so the model knows the content may be outdated.

This approach preserves the LLM provider's **KV cache** (attention cache),
keeping requests fast and cheap.

## Worktree Awareness

Shofer creates per-task git worktrees under `.shofer/worktrees/` for isolated
work. The Assistant Agent:

- **Never loads worktree files** — these are ephemeral and branch-specific
- **Only tracks main-branch files** — its knowledge represents the primary branch
- **One agent per workspace** — all tasks share the same assistant agent

## What It Can't Do

The Assistant Agent is **strictly read-only**. It cannot:

- Modify files
- Run commands
- Create new tasks
- Use MCP tools (browser, Kubernetes, etc.)
- Switch modes
- Send messages to the user

These restrictions are enforced at the tool-filtering layer — the agent's system
prompt and internal tool set both prevent write operations.
