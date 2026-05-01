# MCP Tool Category Buckets

**Status:** Implemented  
**Last Updated:** 2026-04-30

## Overview

MCP Tool Category Buckets enable fine-grained mode-based access control for MCP (Model Context Protocol) tools. Instead of treating all MCP tools as a single monolithic group, each tool can now be classified into specific categories, allowing precise permission control based on the tool's purpose.

## Motivation

### The Problem

Previously, Roo Code's mode system had a simple but problematic approach to MCP tools:

- Modes either allowed **all** MCP tools (by including the `mcp` group) or **none**
- This created two major security and usability issues:
    1. **Over-permissioning**: A read-only mode that needed file-reading MCP tools would also gain access to destructive tools like `github_delete_repo`
    2. **Under-permissioning**: To safely run a code-writing agent, users had to either allow all MCP tools or block useful read-only tools entirely

### The Solution

MCP Tool Category Buckets allow MCP servers and users to classify each tool into one of the existing tool groups:

- **`read`** - Read-only operations (file reading, data fetching, queries)
- **`edit`** - Write/modify operations (file editing, resource creation)
- **`command`** - System command execution
- **`mcp`** - MCP administration and resource access
- **`modes`** - Mode switching and task management
- **`uncategorized`** - Default category for tools without explicit classification (backward compatible with existing behavior)

## How It Works

### Tool Classification

Tools are classified in priority order:

1. **User Configuration** - Highest priority

    - Users can override or assign groups per tool in their MCP config
    - Useful for servers that don't implement native grouping or for custom permission needs

2. **Server Declaration** - Medium priority

    - MCP servers can include a `group` field in their tool definitions
    - Encourages self-describing tools with proper categorization

3. **Default Fallback** - Lowest priority
    - Tools without explicit group assignment default to `uncategorized`
    - Maintains backward compatibility with existing MCP servers

### Mode-Based Filtering

When a mode requests tools:

- Each MCP tool's group is looked up based on the classification rules
- The tool is made available only if the mode's allowed groups include that tool's group
- This replaces the previous all-or-nothing approach with per-tool granularity

### Backward Compatibility

- **No breaking changes**: Tools without `group` fields continue to work exactly as before
- **Safe migration**: Existing configurations require no changes
- **Gradual adoption**: Servers and users can adopt grouping at their own pace

## Configuration

### Server-Side Group Declaration

MCP servers can classify their tools by adding a `group` field:

```json
{
  "tools": [
    {
      "name": "get_pull_request",
      "description": "Get details of a PR",
      "inputSchema": {...},
      "group": "read"
    },
    {
      "name": "create_issue",
      "description": "Create a GitHub issue",
      "inputSchema": {...},
      "group": "edit"
    },
    {
      "name": "run_workflow",
      "description": "Trigger a GitHub Actions workflow",
      "inputSchema": {...},
      "group": "command"
    }
  ]
}
```

### User-Side Overrides

Users can override or assign groups in their MCP configuration:

**Global config** (`~/.roo/mcp.json`):

```json
{
	"mcpServers": {
		"github": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-github"],
			"toolGroups": {
				"get_pull_request": "read",
				"create_issue": "edit",
				"merge_pull_request": "command"
			}
		}
	}
}
```

**Project config** (`.roo/mcp.json`):

```json
{
	"mcpServers": {
		"slack": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-slack"],
			"toolGroups": {
				"read_messages": "read",
				"post_message": "edit"
			}
		}
	}
}
```

## Use Cases

### Safe Read-Only Mode

**Before:** Architect mode needed GitHub file reading but got repository deletion too

**After:** Configure GitHub MCP server with proper groups:

```json
"toolGroups": {
  "get_file_contents": "read",
  "get_pull_request": "read",
  "delete_repo": "command"  // Not available in architect mode
}
```

### Secure Code Writing

**Before:** Code mode had to allow all MCP tools or block useful helpers

**After:** Allow specific tool groups as needed:

```json
"groups": ["read", "edit", "command"]  // Excludes blanket "mcp" access
```

### Custom Restricted Mode

Create a mode that only allows safe read operations:

```json
{
	"slug": "safe-research",
	"name": "Safe Research Mode",
	"roleDefinition": "Research information without making changes",
	"groups": ["read", "uncategorized"]
}
```

## Implementation Notes

### Key Files Modified

1. **Type Definitions**

    - `packages/types/src/mcp.ts` - Added `group` field to `McpTool`
    - `packages/types/src/tool.ts` - Added `uncategorized` tool group

2. **MCP Server Management**

    - `src/services/mcp/McpHub.ts` - Added `toolGroups` config, group resolution, and `getMcpToolMetadata()` helper

3. **Tool Filtering**

    - `src/core/prompts/tools/filter-tools-for-mode.ts` - Rewrote `filterMcpToolsForMode()` for per-tool group membership

4. **Tool Building**

    - `src/core/task/build-tools.ts` - Updated to pass `mcpToolMeta` to the filter

5. **Settings UI**

    - `webview-ui/src/components/settings/SettingsView.tsx` - Passes `mcpServers` state to `ToolsSettings`
    - `webview-ui/src/components/settings/ToolsSettings.tsx` - Displays MCP tools under their assigned groups with a blue "MCP" badge
    - `webview-ui/src/i18n/locales/en/settings.json` - Added `"mcpTool": "MCP"` badge label

6. **Testing**
    - `src/core/prompts/tools/__tests__/mcp-filtering.spec.ts` - Comprehensive test suite (12 cases)

### Behavior Changes

**When upgrading servers with group support:**

- Tools with explicit groups become accessible based on mode configuration
- Tools without groups continue to work as before (default to `uncategorized`)
- No configuration changes required on the user side

**When modes specify tool groups:**

- Only tools matching the allowed groups become available
- The gateway tools `use_mcp_tool` and `access_mcp_resource` are managed automatically
- Existing modes continue to work unchanged

## Migration Path

### For MCP Server Developers

1. **Add group classification** to your tool definitions
2. **Update documentation** to inform users about tool categories
3. **Test with different modes** to ensure proper behavior
4. **Gradual rollout** - tools without groups remain fully functional

### For Users

1. **No immediate action required** - existing functionality preserved
2. **Optionally add tool group overrides** in MCP config for custom permissioning
3. **Create custom modes** that leverage granular tool access
4. **Update modes** to include specific groups instead of blanket `mcp` access

## Future Enhancements

Potential future improvements (not currently implemented):

- **Resource group classification** - Apply similar grouping to MCP resources
- **Dynamic group assignment** - Auto-classify tools based on usage patterns
- **Group hierarchy** - Support for nested or sub-groups
- **Custom groups** - User-defined tool group categories
- **Group visualization** - UI for viewing and managing tool classifications

## References

- [MCP Specification](https://modelcontextprotocol.io/)
- [Roo Code Modes Documentation](../modes/README.md)
- [Tool Group Configuration](../tool-groups/README.md)
