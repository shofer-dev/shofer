# Settings Storage & Merge — Integration Test Scenarios

Feature under test: Settings storage layers, mode merge precedence, export/import
round-trip, factory reset, auto-import on startup, and file watcher-based reload.  
Sources: [`settings_overlay.md`](../docs/settings_overlay.md),
[`ProviderSettingsManager.ts`](../src/core/config/ProviderSettingsManager.ts),
[`ContextProxy.ts`](../src/core/config/ContextProxy.ts),
[`CustomModesManager.ts`](../src/core/config/CustomModesManager.ts),
[`McpHub.ts`](../src/services/mcp/McpHub.ts),
[`importExport.ts`](../src/core/config/importExport.ts),
[`autoImportSettings.ts`](../src/utils/autoImportSettings.ts),
[`ShoferProvider.ts`](../src/core/webview/ShoferProvider.ts).

## Smoke Tests

These should pass on every build.

### S1 — Full export produces valid JSON with both sections

- Open Settings → About → click **Export**.
- Save the file.
- **Assert**: File is `shofer-code-settings.json`. Parses as valid JSON.
- **Assert**: Top-level keys include `providerProfiles` and `globalSettings`.
- **Assert**: `providerProfiles.apiConfigs` is a non-empty object with profile entries.
- **Assert**: `globalSettings.mode` is a non-empty string (e.g., `"code"`).

### S2 — Full import restores API profiles

- Export settings (S1). Delete a known API profile via Settings → Providers.
- **Assert**: The profile no longer appears in the ApiConfigSelector dropdown.
- Settings → About → **Import** the previously exported file.
- **Assert**: The deleted profile reappears in the ApiConfigSelector dropdown.
- **Assert**: The profile's model, base URL, and temperature are restored.

### S3 — Full import is additive (does not delete existing profiles)

- Create a new API profile ("test-keep-me") via Settings → Providers.
- Export settings, then delete the file on disk.
- Import an older settings file that does not contain "test-keep-me".
- **Assert**: "test-keep-me" still exists alongside the imported profiles.

### S4 — Factory reset clears API profiles

- Ensure at least one API profile exists.
- Settings → About → **Reset** → confirm the modal dialog.
- **Assert**: ApiConfigSelector shows zero profiles or only the default.
- **Assert**: Custom instructions field in Settings → Modes is empty.
- **Assert**: Auto-approval toggles are back to defaults (off).

### S5 — Factory reset does not delete MCP server configs

- Add an MCP server via Settings → Tools → MCP Servers.
- Perform factory reset (S4).
- **Assert**: The MCP server still appears in Settings → Tools → MCP Servers.
- **Assert**: The MCP server is still connected (tools appear in the MCP tool list).

## Functional Tests

### F1 — `.shofermodes` takes precedence over global `custom_modes.yaml`

**Given** a mode slug `"reviewer"` exists in both:

- `.shofermodes` with `roleDefinition: "Project reviewer — strict"`
- `custom_modes.yaml` with `roleDefinition: "Global reviewer — lenient"`

**When** the workspace is active

**Then** the mode dropdown shows `roleDefinition: "Project reviewer — strict"`
**And** editing the mode in Settings shows `source: "project"`

**Cleanup**: Remove `"reviewer"` from `.shofermodes` or delete `.shofermodes`.

### F2 — Deleting `.shofermodes` restores global version of same slug

**Given** the setup from F1 (project mode overrides global)

**When** `.shofermodes` is deleted (or the `"reviewer"` slug is removed from it)

**Then** the mode dropdown now shows `roleDefinition: "Global reviewer — lenient"`
**And** editing the mode in Settings shows `source: "global"`

### F3 — Mode merge updates within seconds of editing `.shofermodes`

- Open `.shofermodes` and change a built-in mode's `roleDefinition`.
- Save the file.
- Wait up to 3 seconds.
- **Assert**: The ModeSelector dropdown or Settings → Modes reflects the new
  `roleDefinition` without restarting VS Code.
- Revert the change and wait.
- **Assert**: The original `roleDefinition` is restored.

### F4 — Export excludes project modes (only `source: "global"` custom modes)

**Given** `.shofermodes` defines a custom mode `"my-project-mode"`
**And** `custom_modes.yaml` defines a custom mode `"my-global-mode"`

**When** Settings → About → Export

**Then** `globalSettings.customModes` contains `"my-global-mode"` (source: "global")
**And** `globalSettings.customModes` does NOT contain `"my-project-mode"`

### F5 — MCP project config (`.shofer/mcp.json`) is watched for changes

- Create `<workspace>/.shofer/mcp.json` with a valid MCP server definition.
- Wait up to 3 seconds.
- **Assert**: The MCP server appears in Settings → Tools → MCP Servers (marked as project server).
- Delete `.shofer/mcp.json`.
- Wait up to 3 seconds.
- **Assert**: The project MCP server disappears from the server list.

### F6 — MCP file deletions trigger cleanup of project servers

**Given** `.shofer/mcp.json` defines a project MCP server that is running

**When** `.shofer/mcp.json` is deleted

**Then** the project server connections are closed
**And** the MCP server list no longer includes the project server
**And** no error notification is shown (clean teardown)

### F7 — Auto-import on startup with valid settings file

- Set `shofer.autoImportSettingsPath` to a valid `shofer-code-settings.json` path.
- Restart VS Code (or reload the extension).
- **Assert**: The API profiles from the import file appear in ApiConfigSelector.
- **Assert**: `globalSettings.customInstructions` from the import file is applied.

### F8 — Auto-import on startup with missing file (graceful no-op)

- Set `shofer.autoImportSettingsPath` to a non-existent file path.
- Restart VS Code.
- **Assert**: Extension activates normally with no error dialogs.
- **Assert**: No "Failed to import settings" notification is shown.

### F9 — Per-mode export produces valid YAML

- Settings → Modes → click Export next to any mode.
- Save the `.yaml` file.
- **Assert**: File contains `slug`, `name`, `roleDefinition` fields.
- **Assert**: File parses as valid YAML.

### F10 — Per-mode import into project level writes to `.shofermodes`

- Export a mode from a different workspace (or create a valid mode YAML manually).
- Settings → Modes → Import → select the file → choose **Project** level.
- **Assert**: The imported mode appears in `.shofermodes`.
- **Assert**: The mode shows `source: "project"` in the Modes tab.

### F11 — Per-mode import into global level writes to `custom_modes.yaml`

- Settings → Modes → Import → select a mode YAML → choose **Global** level.
- **Assert**: The imported mode appears in `custom_modes.yaml`.
- **Assert**: The mode shows `source: "global"` in the Modes tab.

### F12 — SecretStorage keys are correctly prefixed

- Inspect the VS Code SecretStorage entries after creating an API profile.
- **Assert**: The profiles blob key is `shofer_config_api_config` (not `roo_cline_config_api_config`).
- **Assert**: Individual API key entries are stored under their canonical names
  (e.g., `apiKey`, `openRouterApiKey`, `geminiApiKey`).

### F13 — `custom_modes.yaml` is auto-created on first Settings UI use

- Delete `custom_modes.yaml` from the data directory.
- Open Settings → Modes.
- **Assert**: A fresh `custom_modes.yaml` is created containing `customModes: []`.
- **Assert**: No error is shown to the user.

## Edge-Case Tests

### E1 — Duplicate slug in `.shofermodes` and global: global is ignored

**Given** F1 setup (both sources define `"reviewer"`)
**When** the global `"reviewer"` mode is edited via Settings → Modes
**Then** the edit has no effect on the active mode (project version still wins)
**And** if `.shofermodes` is deleted, the global edits become visible

### E2 — Export with zero API profiles still produces valid JSON

- Delete all API profiles.
- Settings → About → Export.
- **Assert**: `providerProfiles.apiConfigs` is `{}`.
- **Assert**: `providerProfiles.currentApiConfigName` is a valid string (or empty).
- **Assert**: File is still valid JSON.

### E3 — Import with conflicting profile IDs merges correctly

- Export settings from machine A.
- On machine B, create a profile with the same name but different model.
- Import the machine A settings file.
- **Assert**: Only one profile with that name exists.
- **Assert**: The imported profile's model overwrites the local one (import wins for matching names/IDs).
- **Assert**: Other unique profiles from both machines co-exist.

### E4 — Reset while MCP servers are running does not disrupt connections

- Start a task that uses an MCP server.
- Perform factory reset (S4) in the Settings panel.
- **Assert**: The MCP server remains connected.
- **Assert**: The task can still call MCP tools (the MCP hub was unaffected by reset).
