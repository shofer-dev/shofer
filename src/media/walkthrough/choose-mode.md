# Choose a Mode

Shofer ships with **6 built-in modes** that control what tools the AI can use. Switch modes anytime via the dropdown in the chat input bar. This feature is powerful because it not only lets you control access to tools, but also which models each mode can use. For example a lower-cost model is probably more appropriate for searching a vast codebase.

In practice, however, Shofer will automatically switch to the best mode for the task, so you can leave it to default.

<img src="images/modes.png" alt="Mode Selector" width="280" />

## Built-in Modes

| Mode               | Best For                                             | Tool Groups                                                                         |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 💻 **Code**        | Writing, modifying, and refactoring code             | `read`, `write`, `execute`, `mcp`, `mode`, `subtasks`, `questions`, `uncategorized` |
| 🏗️ **Architect**   | Planning and designing before writing code           | `read`, `write` (.md only), `mcp`, `questions`                                      |
| 🪲 **Debug**       | Troubleshooting errors and diagnosing root causes    | `read`, `write`, `execute`, `mcp`, `subtasks`, `questions`, `uncategorized`         |
| 🔎 **Code Search** | Searching the codebase for functions and patterns    | `read`, `execute`, `mcp`, `questions`                                               |
| 🌐 **Web Search**  | Browsing and extracting web content                  | `browser`, `mcp`, `questions`                                                       |
| 👀 **Reviewer**    | Reviewing code for bugs, security, and design issues | `read`, `execute`, `mcp`, `questions`                                               |

## Custom Modes

Create your own modes with a `.shofer/shofermodes` file — control exactly which tools are available per mode.

Select a mode from the dropdown in the chat input bar to continue.
