# Installing & Configuring Third-Party Tool Extensions

Shofer can use tools from companion VS Code extensions. This makes Shofer
extensible — extensions can add tools for controlling the editor UI, the
browser, or any other system, and Shofer discovers them automatically.

This page explains what tool extensions are, how to install and configure
them, and how they differ from Shofer's built-in tools and MCP server tools.

## How Tool Extensions Work

A **tool extension** is a regular VS Code extension that registers itself
as a "private tool provider." Instead of using Copilot's tool API
(`vscode.lm.tools`), it uses a dedicated Shofer-only channel so that
Copilot never sees or calls these tools.

When Shofer starts, it:

1. Reads the `shofer.privateToolProviders` configuration to find installed
   tool extensions.
2. Calls each extension's **get-definitions command** to learn what tools
   it provides (their names, descriptions, and input schemas).
3. Assigns each tool to a **tool group** for access control.
4. At runtime, calls the extension's **invoke command** whenever Shofer's
   model decides to use one of those tools.

## Installing a Tool Extension

Install a tool extension the same way you install any VS Code extension.
Two companion extensions are available:

| Extension                 | Tools Provided                                                                                   | Marketplace             |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- |
| **Arkware VSCode Tools**  | Editor controls: open/close files, focus panels, navigate the explorer, execute VS Code commands | `arkware-vscode-tools`  |
| **Arkware Browser Tools** | Browser automation: navigate pages, click elements, fill forms, take screenshots                 | `arkware-browser-tools` |

After installing, Shofer needs a one-time configuration entry so it knows
where to find the extension's tools. Add this to your `settings.json`:

```json
{
	"shofer.privateToolProviders": {
		"vscode-tools": {
			"getDefinitionsCommand": "arkware.vscodeTools.getDefinitions",
			"invokeToolCommand": "arkware.vscodeTools.invokeTool"
		},
		"browser-tools": {
			"getDefinitionsCommand": "arkware.browserTools.getDefinitions",
			"invokeToolCommand": "arkware.browserTools.invokeTool"
		}
	}
}
```

<!-- XXX screenshot: VS Code settings editor showing the shofer.privateToolProviders
     object with vscode-tools and browser-tools entries expanded, highlighting
     the getDefinitionsCommand and invokeToolCommand fields -->

Restart Shofer (or reload the VS Code window: `Ctrl+Shift+P` → "Reload Window").
The extension's tools appear in Shofer's tool set immediately.

## Configuring Tool Groups

Every tool in Shofer belongs to a **tool group** — a category like "read",
"write", "browser", or "execute". Tool groups control:

- **Which modes can use the tool** (e.g., Code mode allows "write" tools;
  Reviewer mode does not).
- **Whether the tool is auto-approved** (you can toggle auto-approval per
  group in the `AutoApproveDropdown`).

Shofer assigns groups to extension tools through a three-step fallback:

1. If the tool definition itself declares a `group`, that wins.
2. Otherwise, Shofer checks a per-tool mapping you can set in `settings.json`.
3. If neither exists, the tool goes into the default `"uncategorized"` group.

### Setting per-tool groups

To override the group for a specific tool, add a `toolGroups` mapping under
the provider's config namespace:

```json
{
	"shofer.vscode-tools.toolGroups": {
		"ide_file_read": "read",
		"ide_file_open": "execute",
		"ide_file_reveal_in_explorer": "execute",
		"ide_file_list": "read",
		"ide_execute_vscode_command": "execute"
	}
}
```

<!-- XXX screenshot: AutoApproveDropdown expanded in the chat input bar,
     showing the toggles per tool group (read, write, execute, browser, mcp,
     mode, subtasks, questions, uncategorized). The 'browser' group toggle
     should be highlighted to show where extension browser tools are gated. -->

### Available groups

| Group           | What it controls       | Example extension tool                        |
| --------------- | ---------------------- | --------------------------------------------- |
| `read`          | Read-only access       | `ide_file_read`, `ide_file_list`              |
| `write`         | Content mutations      | (extension tools rarely write files directly) |
| `execute`       | System/editor commands | `ide_file_open`, `ide_execute_vscode_command` |
| `browser`       | Web automation         | `browser_navigate`, `browser_click`           |
| `mcp`           | MCP protocol tools     | (not used by extension tools)                 |
| `mode`          | Mode switching         | (not used by extension tools)                 |
| `subtasks`      | Task management        | (not used by extension tools)                 |
| `questions`     | User-facing questions  | (not used by extension tools)                 |
| `uncategorized` | Fallback default       | Any tool without an explicit group            |

## How Extension Tools Appear in Chat

When Shofer's model uses an extension tool, it looks the same as any other
tool call in the chat: a collapsible block showing the tool name, its
arguments, and the result. The only difference is the tool name prefix —
extension tools use `ide_*` (editor) or `browser_*` (browser) naming.

<!-- XXX screenshot: ChatView showing a tool call row for "ide_file_read"
     with arguments { "path": "src/main.ts" } and a result containing
     the file contents -->

## Differences From Built-in Tools and MCP Tools

|                      | Built-in Tools                               | Extension Tools                     | MCP Tools                   |
| -------------------- | -------------------------------------------- | ----------------------------------- | --------------------------- |
| **Where defined**    | Inside Shofer's source code                  | In a separate VS Code extension     | On an external MCP server   |
| **Examples**         | `read_file`, `apply_diff`, `execute_command` | `ide_file_open`, `browser_navigate` | `server__tool_name`         |
| **Installation**     | Always available                             | Install extension + add config      | Add server to MCP settings  |
| **Config key**       | (none — built in)                            | `shofer.privateToolProviders`       | MCP server config           |
| **Group assignment** | Hardcoded in `TOOL_GROUPS`                   | Configurable via `toolGroups`       | Configurable via MCP config |

## Troubleshooting

### Tools don't appear after installing an extension

1. Check that the extension is **activated** — open the VS Code Output panel
   and select the extension's output channel (e.g., "Arkware VSCode Tools").
2. Verify your `settings.json` has the correct `shofer.privateToolProviders`
   entry with the right command IDs.
3. Reload the VS Code window (`Ctrl+Shift+P` → "Reload Window").

### Tools appear but are grayed out / unavailable

The current mode may not allow the tool's assigned group. Check the mode's
allowed groups in **Settings → Modes** and ensure the tool's group is
listed there.

### A tool keeps asking for approval when I expect it to be auto-approved

Check the `AutoApproveDropdown` in the chat input bar. Make sure the toggle
for the tool's group is enabled.

### "Provider Error" when the model tries to use an extension tool

The extension's invoke command may have failed. Open the Shofer output
channel (`Ctrl+Shift+P` → "Shofer: Show Output Channel") and look for
errors. Also check the extension's own output channel for stack traces.
