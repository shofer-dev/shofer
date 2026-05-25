# Shofer

> State-of-the-art open-source AI coding.

---

## What Can Shofer Do For YOU?

- Generate, refactor, and debug code across your workspace
- Run **parallel tasks** with background child tasks — the AI delegates work concurrently
- **Auto-approve** tool categories you trust; require approval for the rest
- Choose from 9 built-in **modes**: Code, Architect, Ask, Debug, Reviewer, Search, Opinion, Browser, and Orchestrator
- Define **custom modes** with per-category tool access and file-scoped restrictions (`.shofermodes`)
- Query your codebase with **semantic search** (RAG indexing) and **git commit search** — requires a reachable **Qdrant v1.14.x** server.
- Create and install **skills** — reusable, mode-aware instruction packs
- Connect **MCP servers** for external tools (browser, database, Kubernetes, web search)
- Use the **Assistant Agent** — a persistent read-only AI companion that accumulates codebase knowledge
- Manage **git worktrees** for isolated parallel work — all in one VS Code window
- Review edits in the **File Changes Panel** — accept, revert, or diff every file Shofer modifies
- **Queue messages** while Shofer is busy; click **Send Now** to redirect it immediately
- Attach files via **drag & drop**, paste **images** for vision models, and export tasks as **Markdown or JSON**
- Set **USD cost limits** on any task — pause, abort, or kill when the cap is hit
- Read the full [User Manual](src/USER_MANUAL.md)

## Modes

Shofer ships with 9 built-in modes — choose from the Mode Selector dropdown in the chat input bar:

| Mode                | Best For                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| 💻 **Code**         | Writing, modifying, and refactoring code. Broadest tool access.          |
| 🏗️ **Architect**    | Planning and designing before writing code. Read + markdown-only writes. |
| ❓ **Ask**          | Getting explanations, answers, or recommendations. Read-only + MCP.      |
| 🪲 **Debug**        | Troubleshooting errors and diagnosing root causes.                       |
| 👀 **Reviewer**     | Reviewing code for issues without making changes.                        |
| 🔎 **Search**       | Fast codebase search and retrieval. Read-only.                           |
| 💭 **Opinion**      | Expert opinion on technology choices or architecture.                    |
| 🌐 **Browser**      | Web browsing, research, and data extraction.                             |
| 🪃 **Orchestrator** | Coordinating complex multi-step work by delegating to sub-tasks.         |

Create your own modes via [`.shofermodes`](src/USER_MANUAL.md#4-custom-modes) files at the project or global level.

Learn more: [User Manual](src/USER_MANUAL.md) • [Custom Modes](src/USER_MANUAL.md#4-custom-modes)

## Resources

- **[User Manual](src/USER_MANUAL.md):** The complete guide to every feature, setting, and concept in Shofer.
- **[Developer Documentation](https://shofer.dev/docs):** Official docs for installing, configuring, and mastering Shofer.
- **[GitHub Issues](https://github.com/shofer-dev/shofer/issues):** Report bugs and track development.
- **[Feature Requests](https://github.com/shofer-dev/shofer/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Have an idea? Share it with the developers.

---

## Local Setup & Development

1. **Clone** the repo:

```sh
git clone https://github.com/shofer-dev/shofer.git
```

2. **Install dependencies**:

```sh
pnpm install
```

3. **Run the extension**:

There are several ways to run the Shofer extension:

### Development Mode (F5)

For active development, use VSCode's built-in debugging:

Press `F5` (or go to **Run** → **Start Debugging**) in VSCode. This will open a new VSCode window with the Shofer extension running.

- Changes to the webview will appear immediately.
- Changes to the core extension will also hot reload automatically.

### Automated VSIX Installation

To build and install the extension as a VSIX package directly into VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

This command will:

- Ask which editor command to use (code/cursor/code-insiders) - defaults to 'code'
- Uninstall any existing version of the extension.
- Build the latest VSIX package.
- Install the newly built VSIX.
- Prompt you to restart VS Code for changes to take effect.

Options:

- `-y`: Skip all confirmation prompts and use defaults
- `--editor=<command>`: Specify the editor command (e.g., `--editor=cursor` or `--editor=code-insiders`)

### Manual VSIX Installation

If you prefer to install the VSIX package manually:

1.  First, build the VSIX package:
    ```sh
    pnpm vsix
    ```
2.  A `.vsix` file will be generated in the `bin/` directory (e.g., `bin/shofer-<version>.vsix`).
3.  Install it manually using the VSCode CLI:
    ```sh
    code --install-extension bin/shofer-<version>.vsix
    ```

---

We use [changesets](https://github.com/changesets/changesets) for versioning and publishing. Check our `CHANGELOG.md` for release notes.

---

## Disclaimer

**Please note** that Shofer, Inc does **not** make any representations or warranties regarding any code, models, or other tools provided or made available in connection with Shofer, any associated third-party tools, or any resulting outputs. You assume **all risks** associated with the use of any such tools or outputs; such tools are provided on an **"AS IS"** and **"AS AVAILABLE"** basis. Such risks may include, without limitation, intellectual property infringement, cyber vulnerabilities or attacks, bias, inaccuracies, errors, defects, viruses, downtime, property loss or damage, and/or personal injury. You are solely responsible for your use of any such tools or outputs (including, without limitation, the legality, appropriateness, and results thereof).

---

## Contributing

We love community contributions! Get started by reading our [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[Apache 2.0 © 2026 Shofer, Inc.](./LICENSE)
