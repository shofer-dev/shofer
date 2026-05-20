# Where Shofer Stores Your Settings — Backup, Restore & Reset

Shofer stores your API keys, mode customizations, MCP server definitions,
auto-approval preferences, and other settings across several places on
your machine. This guide explains what lives where, how to back everything
up, how to restore from a backup, and how to factory-reset.

---

## Quick Reference: What Lives Where

| What You Configure                               | Where It's Stored                          | Survives Restart?    |
| ------------------------------------------------ | ------------------------------------------ | -------------------- |
| API keys (Anthropic, OpenAI, etc.)               | OS credential store (Keychain / libsecret) | ✅ Yes               |
| API provider profiles & model choices            | OS credential store (profiles blob)        | ✅ Yes               |
| Non-secret API settings (base URLs, temperature) | VS Code global state (SQLite)              | ✅ Yes               |
| Custom modes (`.shofermodes` file)               | `<project>/.shofermodes` (YAML file)       | ✅ Yes (it's a file) |
| Custom modes (Settings UI)                       | `custom_modes.yaml` in Shofer data dir     | ✅ Yes               |
| MCP server definitions                           | Settings → Tools → MCP Servers             | ✅ Yes               |
| Auto-approval toggles, custom instructions       | VS Code global state (SQLite)              | ✅ Yes               |
| Task history                                     | `<data>/tasks/<id>/` (JSON files)          | ✅ Yes               |

---

## Backing Up Your Settings

### Full Export (Recommended)

The easiest way to back up **everything** (API profiles, keys, modes, auto-approval
settings, custom instructions) is the Export button:

1. Open Shofer settings: click the ⚙️ gear icon in the Shofer panel title bar
2. Navigate to the **About** tab
3. Click **Export**

<!-- XXX: Screenshot — About tab in SettingsView showing the Export, Import, and Reset buttons in a row. The Export button should be highlighted or called out with an arrow annotation. -->

This saves a `shofer-code-settings.json` file containing your full configuration.

> **Note:** MCP server definitions are NOT included in the export. To back up MCP
> configs separately, copy `mcp_settings.json` from your Shofer data directory
> (see [Finding Your Data Directory](#finding-your-data-directory)).

### What the Export Contains

- **All API provider profiles** — including API keys, model IDs, base URLs, and
  temperature/rate-limit settings
- **All custom modes** that you created via Settings → Modes
- **Global custom instructions** and **mode-specific custom instructions**
- **Auto-approval settings** — which tool groups are auto-approved
- **Command execution permissions, cost limits, checkpoint settings**, and more

### What Is NOT Exported

| Not Exported                 | Why                                                            |
| ---------------------------- | -------------------------------------------------------------- |
| MCP server definitions       | Managed separately; copy `mcp_settings.json` manually          |
| Project `.shofermodes` files | Already in your git repo — no need to export                   |
| Task history                 | Per-task data — export individual tasks from the History panel |

---

## Restoring Settings

### Full Import

1. Open Shofer settings → **About** tab
2. Click **Import**
3. Choose a previously-exported `shofer-code-settings.json` file

<!-- XXX: Screenshot — File open dialog showing selection of a shofer-code-settings.json file, with the file path visible. -->

Import is **additive** — existing profiles not in the import file are preserved.
API keys in the import file overwrite existing ones for matching profiles.

### Per-Mode Import/Export

The **Modes** tab has its own Export/Import system for individual mode definitions:

- **Export** button next to each mode → saves a single `.yaml` file with that
  mode's definition, instructions, and bundled rules
- **Import** button in the Modes toolbar → load a `.yaml` file into either:
    - **Project** (`.shofermodes`) — available in this workspace only
    - **Global** (`custom_modes.yaml`) — available in all workspaces on your machine

<!-- XXX: Screenshot — Modes tab showing the Export icon button next to a mode row (e.g. "💻 Code") and the Import button in the toolbar at the top. -->

---

## Factory Reset

The **Reset** button in Settings → About wipes all Shofer settings back to
defaults. This is **destructive and cannot be undone**.

> ⚠️ **Export your settings first** if you want to restore them later.

### What Reset Wipes

| Wiped                                                   | Not Wiped                                   |
| ------------------------------------------------------- | ------------------------------------------- |
| ✅ All API profiles & keys                              | ❌ MCP server configs (`mcp_settings.json`) |
| ✅ Global settings (auto-approval, custom instructions) | ❌ Project `.shofermodes` file              |
| ✅ Custom modes                                         | ❌ VS Code `settings.json`                  |
| ✅ Task history                                         |                                             |

---

## Custom Modes: `.shofermodes` vs Settings UI

You can define custom modes in **two places**, and they merge with a specific
order of precedence:

| Source              | Location                     | Priority    | Shared via Git?     |
| ------------------- | ---------------------------- | ----------- | ------------------- |
| `.shofermodes` file | `<project>/.shofermodes`     | **Highest** | ✅ Yes              |
| Settings → Modes    | `custom_modes.yaml` (global) | Medium      | ❌ No (per-machine) |
| Built-in modes      | Compiled into extension      | Lowest      | —                   |

When the same mode slug exists in both `.shofermodes` and global settings, the
`.shofermodes` version **always wins**.

<!-- XXX: Screenshot — Side-by-side: a .shofermodes file open in the editor showing a custom mode definition (YAML), and the Modes tab in Settings showing the same mode with a "project" source badge. -->

---

## Auto-Import on Startup (Code-Server / Docker)

If you run Shofer in code-server or a container environment, you can pre-configure
it to import settings automatically on every startup:

1. Export your settings from a configured Shofer instance
2. Place `shofer-code-settings.json` at a known path (e.g. `/etc/shofer/settings.json`)
3. Set the VS Code setting `shofer.autoImportSettingsPath` to that path

```json
{
	"shofer.autoImportSettingsPath": "/etc/shofer/settings.json"
}
```

On extension activation, all API profiles and global settings are imported
automatically. This is especially useful in Docker where the OS credential
store may not persist across restarts.

> **Note:** The auto-import only runs on startup. To re-import without restarting,
> use the **Import** button in Settings → About manually.

---

## Finding Your Data Directory

Shofer stores its runtime data under VS Code's global storage directory:

| Platform | Typical Path                                                        |
| -------- | ------------------------------------------------------------------- |
| Linux    | `~/.config/Code/User/globalStorage/shofer.dev/`                     |
| macOS    | `~/Library/Application Support/Code/User/globalStorage/shofer.dev/` |
| Windows  | `%APPDATA%\Code\User\globalStorage\shofer.dev\`                     |

Within this directory:

| Path                         | Contents                      |
| ---------------------------- | ----------------------------- |
| `settings/custom_modes.yaml` | Your custom mode definitions  |
| `settings/mcp_settings.json` | MCP server definitions        |
| `tasks/<id>/`                | Per-task history and messages |
| `cache/`                     | Cached model lists            |

You can override this path with the `shofer.customStoragePath` VS Code setting.

---

## Frequently Asked Questions

### Why do my MCP servers survive a factory reset?

MCP server definitions live in `mcp_settings.json`, which is **not** part of
the reset process. To clear MCP servers, delete them manually in
Settings → Tools → MCP Servers, or delete the `mcp_settings.json` file
from your data directory.

### Can I share my API keys across machines with Export/Import?

Yes. The Export file contains your API keys (in `providerProfiles.apiConfigs.*.apiKey`
fields). Importing this file on another machine will copy those keys into that
machine's OS credential store. Be careful who you share the export file with.

### What happens if both `.shofermodes` and `custom_modes.yaml` define the same mode?

The `.shofermodes` version wins. If you later delete the mode from `.shofermodes`,
the global version from `custom_modes.yaml` takes effect again.

### Do I need to restart after editing `.shofermodes`?

No. Shofer watches `.shofermodes` for changes and reloads mode definitions
automatically within seconds. The same applies to `mcp_settings.json` and
`custom_modes.yaml`.
