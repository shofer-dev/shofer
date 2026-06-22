# VS Code MCP Configuration Compatibility

**Goal:** Make Shofer automatically discover and use MCP servers configured through
VS Code's built-in MCP support (`.vscode/mcp.json`, user-level config, MCP marketplace),
eliminating the need to configure the same server twice.

## Background

VS Code 1.99+ introduced built-in MCP support:

- **Project-level:** `.vscode/mcp.json` — workspace-scoped MCP server definitions
- **User-level:** `~/.vscode/mcp.json` (or `%APPDATA%/Code/User/mcp.json`) — global MCP servers
- **Marketplace:** Extensions that bundle MCP servers

Shofer currently has its own parallel MCP config system:

- **Global:** `<globalStorage>/settings/mcp_settings.json`
- **Project:** `.shofer/mcp.json`

If a user has already configured MCP servers in VS Code (for Copilot or other LM
features), they must re-enter them in Shofer. This is redundant work.

## Schema Comparison

### VS Code's `mcp.json` schema

```json
{
  "servers": {
    "server-name": {
      "type": "stdio" | "sse" | "streamable-http",
      "command": "node",          // stdio only
      "args": ["server.js"],      // stdio only
      "env": { "KEY": "value" },  // stdio only
      "url": "http://...",        // sse / streamable-http only
      "headers": { "Authorization": "..." }
    }
  }
}
```

### Shofer's `mcp_settings.json` / `.shofer/mcp.json` schema

```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio" | "sse" | "streamable-http",
      "command": "node",
      "args": ["server.js"],
      "env": { "KEY": "value" },
      "url": "http://...",
      "headers": { "Authorization": "..." },
      // Shofer-specific extensions:
      "disabled": false,
      "timeout": 60,
      "disabledTools": [],
      "toolGroups": {},
      "watchPaths": []
    }
  }
}
```

Key differences:

1. Top-level key: `"servers"` (VS Code) vs `"mcpServers"` (Shofer)
2. Shofer adds: `disabled`, `timeout`, `disabledTools`, `toolGroups`, `watchPaths`
3. VS Code adds: built-in variable substitution (`${env:...}`, `${workspaceFolder}`, etc.)
4. VS Code may have additional fields we don't yet know about (the spec is evolving)

## Tasks

### V1. Add VS Code MCP config as a read-only source

- [ ] **Read `.vscode/mcp.json`** from workspace root

    - Add alongside existing [`getProjectMcpPath()`](extensions/shofer/src/services/mcp/McpHub.ts:642)
    - Add as `getVscodeMcpPath()` that returns `.vscode/mcp.json` if it exists
    - Add watcher via `vscode.workspace.createFileSystemWatcher` (same pattern as `.shofer/mcp.json`)

- [ ] **Read user-level VS Code MCP config**

    - Determine path: check VS Code's user data directory
    - Likely `os.homedir()/.vscode/mcp.json` or via VS Code API
    - Add watcher

- [ ] **Schema mapping**

    - Create `mapVscodeMcpServerToShofer(config)` that:
        1. Moves `config.servers[name]` → `{ mcpServers: { [name]: ... } }`
        2. Adds Shofer defaults: `disabled: false`, `timeout: 60`, `disabledTools: []`, `toolGroups: {}`
        3. Preserves all transport fields as-is
    - Handle VS Code variable substitution (or skip — Shofer's LLM might not need it)

- [ ] **Source tagging**

    - Add `"vscode-project"` and `"vscode-user"` as source values on `McpServer`
    - These servers are **read-only** — users cannot edit/delete them from Shofer's MCP UI
    - Add visual indicator in the MCP tab: "(VS Code)" badge

- [ ] **Duplicate detection**

    - If a server is in BOTH `.shofer/mcp.json` and `.vscode/mcp.json`:
        - Shofer's config wins (allows override of Shofer-specific metadata)
        - Show informational note: "Also defined in VS Code config — Shofer settings take precedence"
    - Same for `mcp_settings.json` vs user-level VS Code config

- [ ] **Re-read on VS Code config changes**
    - Extend [`debounceConfigChange()`](extensions/shofer/src/services/mcp/McpHub.ts:580) to also handle
      VS Code MCP config paths
    - When `.vscode/mcp.json` changes → remap → `updateServerConnections()` for `"vscode-project"` source

### V2. Consider adopting VS Code's `mcp.json` as the primary format

- [ ] **Evaluate moving Shofer's project config to `.vscode/mcp.json`**

    - Pro: single file, no duplication, VS Code UI can edit it
    - Con: `.shofer/mcp.json` supports Shofer-specific fields VS Code would strip
    - Alternative: keep `.shofer/mcp.json` for Shofer-specific metadata, but also read `.vscode/mcp.json`

- [ ] **Evaluate compatible schema extension**
    - VS Code's schema allows unknown fields? (Check VS Code 1.99+ behavior)
    - If yes: could store Shofer metadata in `.vscode/mcp.json` directly under a `"x-shofer"` key
        ```json
        {
        	"servers": {
        		"my-server": {
        			"type": "stdio",
        			"command": "node",
        			"args": ["server.js"],
        			"x-shofer": {
        				"disabledTools": ["dangerous_tool"],
        				"toolGroups": { "read_tool": "read" }
        			}
        		}
        	}
        }
        ```

### V3. MCP marketplace discovery

- [ ] **Research VS Code MCP marketplace API**
    - Is there an API to list installed MCP server extensions?
    - `vscode.extensions.all` filtered by MCP contribution point?
    - This may require a separate investigation task

## Files Touched

| File                                           | Changes                                                       |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `src/services/mcp/McpHub.ts`                   | Add VS Code MCP config readers, watchers, schema mapping      |
| `packages/types/src/`                          | Add `"vscode-project"` / `"vscode-user"` to source union type |
| `webview-ui/src/components/mcp/McpView.tsx`    | Show "(VS Code)" badge on auto-discovered servers             |
| `webview-ui/src/components/mcp/McpToolRow.tsx` | Gray out edit/delete on VS Code servers                       |
| `docs/settings_overlay.md`                     | Document VS Code MCP integration in §3                        |
