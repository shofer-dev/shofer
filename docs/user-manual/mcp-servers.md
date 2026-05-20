# MCP Servers — Connecting External Tools & Resources

Give Shofer access to external tools by connecting MCP (Model Context
Protocol) servers. MCP servers can provide anything from web search and
database queries to file-system access and browser automation — all
callable by the LLM as if they were built-in tools.

---

## How It Works

1. You add an MCP server configuration (a JSON entry specifying the
   server's transport type and connection details).
2. Shofer connects to the server and discovers its available tools and
   resources.
3. The discovered tools appear in the LLM's tool list alongside Shofer's
   built-in tools, using the naming convention `mcp--<server>--<tool>`.
4. When the LLM calls one of these tools, Shofer routes the call to the
   MCP server, streams the result back, and displays it in chat.

---

## Adding an MCP Server

MCP servers are configured in JSON files. There are two scopes:

| Scope   | Location                       | Applies To             |
| ------- | ------------------------------ | ---------------------- |
| Project | `.shofer/mcp.json`             | Current workspace only |
| Global  | VS Code settings → MCP Servers | All workspaces         |

Project config takes priority when the same server name appears in both.

<!-- XXX: Screenshot showing the Settings UI with an MCP Servers section open,
     a couple of servers configured, and the connection status indicators
     (green checkmark / red X) visible. -->

---

## Server Configuration

Each server entry supports the following fields:

| Field           | Required For              | Description                                            |
| --------------- | ------------------------- | ------------------------------------------------------ |
| `type`          | automatic (inferred)      | `"stdio"`, `"sse"`, or `"streamable-http"`             |
| `command`       | `stdio`                   | The executable to spawn (e.g., `"node"`, `"python"`)   |
| `args`          | `stdio`                   | Arguments passed to the command                        |
| `cwd`           | `stdio`                   | Working directory (defaults to workspace)              |
| `env`           | `stdio`                   | Extra environment variables                            |
| `url`           | `sse` / `streamable-http` | Server endpoint URL                                    |
| `headers`       | `sse` / `streamable-http` | Custom HTTP headers                                    |
| `disabled`      | optional                  | Set to `true` to skip this server at startup           |
| `timeout`       | optional                  | Per-tool-call timeout in seconds (1–3600, default: 60) |
| `disabledTools` | optional                  | Tool names to hide from the LLM                        |
| `toolGroups`    | optional                  | Per-tool group override for auto-approval              |

### Example: Local Node.js Server (stdio)

```json
{
	"my-tools": {
		"type": "stdio",
		"command": "node",
		"args": ["./mcp-servers/my-tools/dist/server.js"],
		"timeout": 60
	}
}
```

### Example: Remote HTTP Server (streamable-http)

```json
{
	"arkware-tools": {
		"type": "streamable-http",
		"url": "http://localhost:30089",
		"disabled": false
	}
}
```

### Using Environment Variables in Paths

You can inject environment variables and the workspace folder path into
config values using `${env:KEY}` and `${workspaceFolder}`:

```json
{
	"my-server": {
		"type": "stdio",
		"command": "${env:HOME}/.local/bin/mcp-server",
		"args": ["--data-dir", "${workspaceFolder}/.mcp-data"]
	}
}
```

---

## Controlling Which Tools the LLM Sees

### Disabling Individual Tools

If a server exposes tools you don't want the LLM to use, list them in
`disabledTools`. The server stays connected but those tools won't appear
in the LLM's tool list:

```json
{
	"my-server": {
		"command": "node",
		"args": ["server.js"],
		"disabledTools": ["dangerous_tool", "slow_tool"]
	}
}
```

### Disabling an Entire Server

Set `"disabled": true` to prevent Shofer from connecting to a server
at all. Useful for temporarily removing a server without deleting its
configuration.

---

## Auto-Approval of MCP Tools

By default, every MCP tool call requires your approval. You can configure
auto-approval to skip the prompt for trusted servers:

1. **Master gate:** Enable the **Always Allow MCP** toggle in the
   auto-approval settings.
2. **Per-tool control:** Assign tool groups to individual tools via the
   `toolGroups` field so only specific tools auto-approve.

<!-- XXX: Screenshot showing the AutoApproveDropdown with the MCP toggle
     enabled and per-group toggles visible. -->

Example with per-tool group assignment:

```json
{
	"readonly-server": {
		"command": "node",
		"args": ["server.js"],
		"toolGroups": {
			"search_tool": "read",
			"fetch_tool": "read"
		}
	}
}
```

With `alwaysAllowMcp` enabled and these tools assigned to the `"read"`
group, Shofer auto-approves `search_tool` and `fetch_tool` without
prompting. Any tool left unassigned defaults to `"uncategorized"` and still
requires approval.

---

## Server Status & Troubleshooting

Connection status is visible in the Settings view. Each server shows:

- **Connected** (green): Server is running and tools are available.
- **Disconnected** (red): Server connection failed or was lost. Hover for
  error details.

<!-- XXX: Screenshot showing the MCP Servers section of Settings with one
     server showing green/connected and another showing red/disconnected
     with an error tooltip visible. -->

### Common Issues

| Symptom                         | Likely Cause                                     |
| ------------------------------- | ------------------------------------------------ |
| Server stays "disconnected"     | Command not found, wrong `cwd`, or process crash |
| "Tool not found" error in chat  | Tool name mismatch or tool disabled in config    |
| Timeout errors                  | `timeout` too low for long-running operations    |
| Server appears but has no tools | Server started but didn't register any tools     |

Config files are watched automatically — saving `mcp.json` triggers a
reconnect without restarting Shofer.

---

## Using MCP Resources

Some MCP servers expose **resources** (files, data blobs, API responses)
in addition to tools. Shofer can access these via the
[`access_mcp_resource`](./native-tools.md#access_mcp_resource) tool. The
LLM provides the server name and resource URI, and Shofer fetches the
content.

---

## MCP in the Chat

When the LLM calls an MCP tool, you'll see:

- The tool name displayed as `mcp--<server>--<tool>` in the chat row.
- Real-time execution status: **started → output → completed** (or
  **error**).
- The tool result rendered as text, with images displayed inline.

<!-- XXX: Screenshot showing a chat conversation where the LLM calls
     mcp--arkware--web_search, the result is streaming back with a
     progress indicator, and the final result is displayed with a
     citation. -->

---

## Related Docs

- [Native Tools Reference](./native-tools.md) — all built-in Shofer tools
- [Tool Categories](./tool-categories.md) — how tool groups work
- [Architecture: MCP](../mcp.md) — developer-level implementation details
