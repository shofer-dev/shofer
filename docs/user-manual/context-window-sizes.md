# Context Window Sizes

Every AI model has a maximum **context window** — the total number of
tokens it can process in a single conversation turn. Shofer discovers this
size automatically for each model and shows it in the
[ContextWindowProgress] bar at the top of every task.

Understanding your model's context window size helps you plan: a 200K window
can hold a novel-length conversation with large files attached; a 32K window
is better suited for focused, short tasks.

## Where to See Your Model's Context Window Size

### The Context Window Bar

In the [TaskHeader] at the top of the chat area, you'll see a horizontal
progress bar. The right endpoint of this bar represents your model's
**maximum context window**. Hover over the bar to see the exact number of
tokens used and the total available:

`32,400 / 200,000 tokens`

<!-- XXX: Screenshot — TaskHeader showing the context window bar, with the mouse hovering over the bar to reveal the tooltip "32,400 / 200,000 tokens". The model name should be visible in the ApiConfigSelector dropdown in the chat input bar. -->

### In the API Configuration Selector

The [ApiConfigSelector] dropdown in the chat input bar shows your current
model. When you open the dropdown, each model entry displays its context
window size:

- **Anthropic Claude Sonnet 4** — 200K
- **OpenAI GPT-4o** — 128K
- **DeepSeek V4 Chat** — 1M

<!-- XXX: Screenshot — ApiConfigSelector dropdown open, showing 3-4 model entries with their context window sizes visible (e.g., "200K", "128K", "1M" next to each model name). -->

## How Shofer Discovers Context Window Sizes

Shofer determines the context window size differently depending on how
your model is connected. This happens automatically — you don't need to
configure anything.

### Models via Shofer Router (Direct API)

For models configured through the Shofer Router (Anthropic, OpenAI,
DeepSeek, Google, Ollama, etc.), the context window size comes directly
from Shofer's model registry. This is the most reliable path: the size
is hardcoded per model and always accurate.

### Models via VS Code LM API

If you use models through VS Code's built-in **Language Model API**
(e.g., GitHub Copilot models), Shofer enriches the basic information
VS Code provides with additional data from the Shofer Router:

- **Context window size** — the maximum tokens the model can handle
- **Pricing** — cost per 1M input/output tokens (shown in the selector)
- **Capabilities** — whether the model supports image input, tool calling,
  and prompt caching

This enrichment happens through side-channel commands that llm-provider
registers with VS Code. When you open the model selector, Shofer requests
this extra data and merges it with VS Code's built-in model list.

<!-- XXX: Screenshot — ApiConfigSelector dropdown open showing a VS Code Copilot model entry, with context window size, pricing, and capability icons visible next to the model name. -->

### Fallback Values

If Shofer cannot determine a model's context window size (rare — typically
only for unknown or newly released models), it uses a sensible default of
**128,000 tokens**. This fallback ensures the context window bar still
functions, but the bar may not accurately reflect your model's true
capacity.

If you suspect your model is showing the wrong context window size, try
switching to a different API configuration profile or contacting your
Shofer administrator to update the model registry.

## What Context Window Size Means for You

| Window Size | Practical Capacity                                     |
| ----------- | ------------------------------------------------------ |
| 32K         | ~80 pages of text; short, focused tasks                |
| 128K        | ~300 pages; full codebase exploration                  |
| 200K        | ~500 pages; novel-length analysis, multi-file projects |
| 1M          | ~2,500 pages; massive codebases, entire documentation  |

The context window includes **everything** the model sees: your prompt,
attached files, tool outputs, conversation history, and the model's own
responses. Larger windows let you work with more files and have longer
conversations without condensation kicking in.

## Related Settings

These settings control how Shofer uses the context window. See
[Context Management](context-management.md) for details:

| Setting                      | Default | Description                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------------- |
| `autoCondenseContext`        | `true`  | Enable automatic context condensation.                           |
| `autoCondenseContextPercent` | `90`    | Percentage of context window that triggers condensation (5–100). |
| Per-profile threshold        | `-1`    | Override the global threshold for a specific API profile.        |

## Troubleshooting

### My context window bar shows the wrong total

This can happen if your model was added to the Shofer Router registry
with an incorrect `context_length` value, or if you're using a VS Code
Copilot model that hasn't been mapped yet.

**To check**: hover over the context window bar and note the max token
count. Compare it with your model's published specification.

**To fix**: If using Shofer Router, the model registry needs updating
(this is a backend configuration change). If using VS Code Copilot models,
try restarting VS Code — the side-channel data is refreshed on startup.

### The bar shows 128,000 for all models

This indicates Shofer is using the fallback default for every model,
which means the enrichment data isn't reaching the UI. This was a known
bug (fixed in a recent release) where VS Code LM models fell through to
the static `128_000` default because the dynamic model list wasn't being
populated. If you're still seeing this, ensure you're on the latest
version of Shofer.
