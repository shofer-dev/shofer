# Choose a Mode

Shofer ships with **5 built-in modes** that control what toolsthe AI can use. Switch modes anytime via the dropdown in the chat input bar. This feature is powerful because it not only lets you control access to tools, but also which models each mode can use. For example a lower-cost model is probably more appropriate for searching a vast codebase.

In practice, however, Shofer will automatically switch to the best mode for the task, so you can leave it to default.

<img src="images/modes.png" alt="Mode Selector" width="280" />

## Built-in Modes

| Mode                | Best For                                             | Tool Groups                                                                         |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 💻 **Code**         | Writing, modifying, and refactoring code             | `read`, `write`, `execute`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized` |
| 🏗️ **Architect**    | Planning and designing before writing code           | `read`, `write` (.md only), `mcp`, `questions`                                      |
| ❓ **Ask**          | Getting explanations, answers, or recommendations    | `read`, `mcp`                                                                       |
| 🪲 **Debug**        | Troubleshooting errors and diagnosing root causes    | `read`, `write`, `execute`, `mcp`, `subtasks`, `questions`, `uncategorized`         |
| 🪃 **Orchestrator** | Coordinating complex work by delegating to sub-tasks | (none — delegates via `new_task`)                                                   |

## Custom Modes

Create your own modes with a `.shofermodes` file — control exactly which tools are available per mode. Common custom modes include Reviewer, Search, Opinion, and Browser.

Select a mode from the dropdown in the chat input bar to continue.
