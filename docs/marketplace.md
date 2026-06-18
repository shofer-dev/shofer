# Shofer Marketplace

> **⚠️ CURRENT STATUS: DISABLED**
>
> The marketplace feature is currently **disabled** via the [`MARKETPLACE_ENABLED`](extensions/shofer/packages/types/src/marketplace.ts:10) feature flag set to `false`. This means:
>
> - No marketplace tab is shown in the Shofer panel.
> - No marketplace buttons appear in MCP, Modes, ModeSelector, or Skills settings.
> - No API calls are made to the Shofer backend for marketplace data.
> - **No server-side infrastructure is required.**
>
> To re-enable the marketplace, set `MARKETPLACE_ENABLED = true` in [`packages/types/src/marketplace.ts`](extensions/shofer/packages/types/src/marketplace.ts:10).

## Overview

The Shofer Marketplace is an in-IDE catalog that lets users discover, browse, and install **Custom Modes** (`.shofer/shofermodes` entries) and **MCP Servers** (`mcp.json` entries) directly from the Shofer extension. It is backed by a remote API, caches results locally, and integrates deeply with VS Code's configuration files for both project-level and global installation scopes.

The marketplace was introduced in **v3.21.0** (June 2025). When enabled, it appears as a dedicated tab in the Shofer panel alongside Settings, History, Chat, and Cloud.

### Key capabilities

- Browse **public Modes and MCP servers** from the Shofer API
- **Filter** by type (MCP/Mode), search text, tags, and installation status
- **Install** items at project (`.shofer/shofermodes` / `.shofer/mcp.json`) or global (VS Code user settings) scope
- **Remove** previously installed marketplace items
- Support for **parameterized MCP installation** with user-provided values
- Support for **multiple installation methods** per MCP item
- **Telemetry** on installs, removals, tab views, and button clicks
- **5-minute in-memory cache** for API responses with exponential backoff retry

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Webview (React)                       │
│                                                          │
│  App.tsx ──► MarketplaceView ──► MarketplaceListView    │
│                  │                    │                  │
│                  │    MarketplaceItemCard                │
│                  │    MarketplaceInstallModal            │
│                  │    IssueFooter                        │
│                  │                    │                  │
│          MarketplaceViewStateManager (state machine)    │
│          useStateManager (React binding)                 │
└──────────────────────┬──────────────────────────────────┘
                       │  vscode.postMessage("fetchMarketplaceData")
                       │  vscode.postMessage("installMarketplaceItem")
                       │  vscode.postMessage("removeInstalledMarketplaceItem")
                       │  vscode.postMessage("filterMarketplaceItems")
                       ▼
┌─────────────────────────────────────────────────────────┐
│               Extension Host (Node.js)                   │
│                                                          │
│  ShoferProvider.ts                                       │
│    ├── fetchMarketplaceData()                            │
│    └── webviewMessageHandler.ts                          │
│          ├── "fetchMarketplaceData"                      │
│          ├── "filterMarketplaceItems"                    │
│          ├── "installMarketplaceItem"                    │
│          ├── "installMarketplaceItemWithParameters"      │
│          └── "removeInstalledMarketplaceItem"            │
│                                                          │
│  MarketplaceManager                                      │
│    ├── getMarketplaceItems()  ─► RemoteConfigLoader     │
│    ├── installMarketplaceItem() ─► SimpleInstaller       │
│    ├── removeInstalledMarketplaceItem()                  │
│    ├── getInstallationMetadata() (reads config files)    │
│    └── filterItems()                                     │
│                                                          │
│  RemoteConfigLoader                                      │
│    ├── loadAllItems() ─► GET /api/marketplace/modes     │
│    │                 ─► GET /api/marketplace/mcps       │
│    └── 5-min in-memory cache, 3 retries, exp. backoff   │
│                                                          │
│  SimpleInstaller                                         │
│    ├── installMode() ─► CustomModesManager              │
│    │                 ─► writes .shofer/shofermodes / global     │
│    ├── installMcp()  ─► writes .shofer/mcp.json / global │
│    ├── removeMode()  ─► CustomModesManager.delete()     │
│    └── removeMcp()   ─► updates mcp.json                │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    Shofer API                             │
│                                                          │
│  GET /api/marketplace/modes  ─► YAML response            │
│  GET /api/marketplace/mcps   ─► YAML response            │
│                                                          │
│  NOTE: Cloud/org integration previously provided         │
│  organization-specific MCP catalogs via a CloudService   │
│  but has been removed in the current codebase. The       │
│  orgSettings variable in MarketplaceManager remains      │
│  undefined.                                              │
└─────────────────────────────────────────────────────────┘
```

---

## Key Source Files

### Types & Schemas

| File                                                                                                                         | Purpose                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/types/src/marketplace.ts`](extensions/shofer/packages/types/src/marketplace.ts)                                   | Zod schemas for `MarketplaceItem`, `ModeMarketplaceItem`, `McpMarketplaceItem`, `McpParameter`, `McpInstallationMethod`, `InstallMarketplaceItemOptions`, `MarketplaceInstalledMetadata`                                          |
| [`packages/types/src/vscode-extension-host.ts`](extensions/shofer/packages/types/src/vscode-extension-host.ts) (lines 21-33) | Cloud types (formerly in `cloud.ts`) are now defined inline: `CloudUserInfo`, `CloudOrganizationMembership`, `ShareVisibility`. Organization-level MCP settings are no longer defined as a Zod schema.                            |
| [`packages/types/src/telemetry.ts`](extensions/shofer/packages/types/src/telemetry.ts) (lines 49-52)                         | Telemetry event names: `MARKETPLACE_ITEM_INSTALLED`, `MARKETPLACE_ITEM_REMOVED`, `MARKETPLACE_TAB_VIEWED`, `MARKETPLACE_INSTALL_BUTTON_CLICKED`                                                                                   |
| [`packages/types/src/vscode-extension-host.ts`](extensions/shofer/packages/types/src/vscode-extension-host.ts)               | Message types: `marketplaceData`, `filterMarketplaceItems`, `installMarketplaceItem`, `removeInstalledMarketplaceItem`, `marketplaceInstallResult`, `marketplaceRemoveResult`, `fetchMarketplaceData`, `marketplaceButtonClicked` |

### Extension Host (Backend)

| File                                                                                                                         | Purpose                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/services/marketplace/index.ts`](extensions/shofer/src/services/marketplace/index.ts)                                   | Barrel export for the marketplace service module                                                                                                                          |
| [`src/services/marketplace/MarketplaceManager.ts`](extensions/shofer/src/services/marketplace/MarketplaceManager.ts)         | Top-level coordinator: fetches items, filters, installs, removes, reads installation metadata                                                                             |
| [`src/services/marketplace/RemoteConfigLoader.ts`](extensions/shofer/src/services/marketplace/RemoteConfigLoader.ts)         | HTTP client that calls the Shofer API (`/api/marketplace/modes`, `/api/marketplace/mcps`), parses YAML, validates with Zod, caches results for 5 minutes                  |
| [`src/services/marketplace/SimpleInstaller.ts`](extensions/shofer/src/services/marketplace/SimpleInstaller.ts)               | Writes marketplace items to the correct config files (`.shofer/shofermodes`, `mcp.json`) at project or global scope; integrates with `CustomModesManager` for mode import |
| [`src/core/webview/ShoferProvider.ts`](extensions/shofer/src/core/webview/ShoferProvider.ts) (lines 2417-2448)               | Provides `fetchMarketplaceData()` method; `MarketplaceManager` is a class field                                                                                           |
| [`src/core/webview/webviewMessageHandler.ts`](extensions/shofer/src/core/webview/webviewMessageHandler.ts) (lines 3065-3183) | Routes webview messages to `MarketplaceManager` methods                                                                                                                   |
| [`src/activate/registerCommands.ts`](extensions/shofer/src/activate/registerCommands.ts) (lines 155-159)                     | Registers `marketplaceButtonClicked` command                                                                                                                              |
| [`src/core/config/CustomModesManager.ts`](extensions/shofer/src/core/config/CustomModesManager.ts) (lines 517-598)           | `deleteCustomMode()` accepts `fromMarketplace` flag for tailored error messages during marketplace removal                                                                |

### Webview UI (React)

| File                                                                                                                                                                             | Purpose                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`webview-ui/src/App.tsx`](extensions/shofer/webview-ui/src/App.tsx)                                                                                                             | Tab routing: `"marketplace"` tab renders `MarketplaceView`; tracks `MARKETPLACE_TAB_VIEWED` telemetry                                                                      |
| [`webview-ui/src/components/marketplace/MarketplaceView.tsx`](extensions/shofer/webview-ui/src/components/marketplace/MarketplaceView.tsx)                                       | Top-level container with MCP/Modes sub-tabs; triggers `fetchMarketplaceData` on mount and when org settings version changes                                                |
| [`webview-ui/src/components/marketplace/MarketplaceViewStateManager.ts`](extensions/shofer/webview-ui/src/components/marketplace/MarketplaceViewStateManager.ts)                 | State machine managing fetch/complete/error states, active tab, filter state; processes incoming `"state"` and `"marketplaceData"` messages; applies client-side filtering |
| [`webview-ui/src/components/marketplace/MarketplaceListView.tsx`](extensions/shofer/webview-ui/src/components/marketplace/MarketplaceListView.tsx)                               | Search bar, install-status dropdown, tag filter popover; renders cards in responsive grid; shows org MCPs section for cloud users                                          |
| [`webview-ui/src/components/marketplace/useStateManager.ts`](extensions/shofer/webview-ui/src/components/marketplace/useStateManager.ts)                                         | React hook binding to `MarketplaceViewStateManager`                                                                                                                        |
| [`webview-ui/src/components/marketplace/components/MarketplaceItemCard.tsx`](extensions/shofer/webview-ui/src/components/marketplace/components/MarketplaceItemCard.tsx)         | Individual card with name, author, description, tags, install/remove buttons, remove confirmation dialog                                                                   |
| [`webview-ui/src/components/marketplace/components/MarketplaceInstallModal.tsx`](extensions/shofer/webview-ui/src/components/marketplace/components/MarketplaceInstallModal.tsx) | Installation modal with scope selector (project/global), method picker (for multi-method MCPs), parameter inputs, prerequisites display, post-install success screen       |
| [`webview-ui/src/components/marketplace/IssueFooter.tsx`](extensions/shofer/webview-ui/src/components/marketplace/IssueFooter.tsx)                                               | Footer link to file a GitHub issue with the `marketplace.yml` template                                                                                                     |
| [`webview-ui/src/context/ExtensionStateContext.tsx`](extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx)                                                         | Holds `marketplaceItems` and `marketplaceInstalledMetadata` in React context                                                                                               |

### Entry points to the marketplace (from other views)

| View                                                                                                                                               | Trigger                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`webview-ui/src/components/mcp/McpView.tsx`](extensions/shofer/webview-ui/src/components/mcp/McpView.tsx) (lines 197-211)                         | "Marketplace" button in MCP settings header → opens marketplace to MCP tab   |
| [`webview-ui/src/components/modes/ModesView.tsx`](extensions/shofer/webview-ui/src/components/modes/ModesView.tsx) (lines 834-845)                 | "Marketplace" button in Modes settings → opens marketplace to Mode tab       |
| [`webview-ui/src/components/chat/ModeSelector.tsx`](extensions/shofer/webview-ui/src/components/chat/ModeSelector.tsx) (lines 315-322)             | "Marketplace" icon in mode selector dropdown → opens marketplace to Mode tab |
| [`webview-ui/src/components/settings/SkillsSettings.tsx`](extensions/shofer/webview-ui/src/components/settings/SkillsSettings.tsx) (lines 289-291) | "Marketplace" link in Skills settings → opens marketplace to Mode tab        |

### Telemetry

| File                                                                                                                         | Purpose                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`packages/telemetry/src/TelemetryService.ts`](extensions/shofer/packages/telemetry/src/TelemetryService.ts) (lines 258-302) | `captureMarketplaceItemInstalled()` and `captureMarketplaceItemRemoved()` methods |

---

## Data Flow

### 1. Opening the Marketplace

```
User clicks "Marketplace" button (MCP view / Mode selector / Settings)
  → App.tsx sets tab === "marketplace"
  → MarketplaceView mounts
  → Sends "fetchMarketplaceData" message to extension host
  → ShoferProvider.fetchMarketplaceData() calls MarketplaceManager
  → MarketplaceManager.getMarketplaceItems():
      1. RemoteConfigLoader.loadAllItems() fetches from API:
         GET /api/marketplace/modes → YAML → modeMarketplaceResponse Zod parse
         GET /api/marketplace/mcps  → YAML → mcpMarketplaceResponse Zod parse
      2. Returns { organizationMcps: [], marketplaceItems, errors }
      (Note: Cloud org settings integration has been removed; all items come from the public API.)
  → MarketplaceManager.getInstallationMetadata():
     1. Reads project .shofer/shofermodes and .shofer/mcp.json
     2. Reads global custom-modes.yaml and mcp-settings.json
     3. Returns { project: { [id]: { type } }, global: { [id]: { type } } }
  → Sends "marketplaceData" message to webview
  → MarketplaceViewStateManager.handleMessage("marketplaceData") updates state
```

### 2. Installing an Item

```
User clicks "Install" on a card
  → MarketplaceInstallModal opens
  → User selects scope (project/global) and fills parameters
  → User clicks "Install"
  → Sends "installMarketplaceItem" message with:
     { mpItem: MarketplaceItem, mpInstallOptions: { target, parameters } }
  → webviewMessageHandler routes to marketplaceManager.installMarketplaceItem()
  → MarketplaceManager:
     1. Shows info toast "Installing item: ..."
     2. SimpleInstaller.installItem(item, { target, parameters })
        For modes:
          - Parses item.content as YAML
          - Calls CustomModesManager.importModeWithRules()
          - Writes to .shofer/shofermodes (project) or custom-modes.yaml (global)
        For MCPs:
          - Handles single or multi-method content
          - Replaces {{paramName}} placeholders in config
          - Writes to .shofer/mcp.json (project) or mcp-settings.json (global)
     3. Shows success toast
     4. Captures telemetry (MARKETPLACE_ITEM_INSTALLED)
     5. Opens the modified config file at the inserted line
  → Sends "marketplaceInstallResult" to webview (success)
  → Webview shows post-install screen with "Go to MCP/Modes" action
  → Extension refreshes state via postStateToWebview()
```

### 3. Removing an Item

```
User clicks "Remove" on an installed card
  → Confirmation dialog appears
  → User confirms removal
  → Sends "removeInstalledMarketplaceItem" with { mpItem, mpInstallOptions: { target } }
  → MarketplaceManager.removeInstalledMarketplaceItem():
     1. Shows info toast "Removing item: ..."
     2. SimpleInstaller.removeItem(item, { target })
        For modes: CustomModesManager.deleteCustomMode(slug, fromMarketplace=true)
        For MCPs: Removes server from mcp.json file
     3. Captures telemetry (MARKETPLACE_ITEM_REMOVED)
  → Sends "marketplaceRemoveResult" to webview
  → Webview refreshes data
  → Extension host sends updated state
```

---

## Marketplace Item Schema

### Base Fields (common to both types)

| Field           | Type           | Required | Description                                      |
| --------------- | -------------- | -------- | ------------------------------------------------ |
| `id`            | `string`       | Yes      | Unique identifier (also used as MCP server name) |
| `name`          | `string`       | Yes      | Display name                                     |
| `description`   | `string`       | Yes      | Description text                                 |
| `author`        | `string`       | No       | Author name                                      |
| `authorUrl`     | `string` (URL) | No       | Link to author's profile                         |
| `tags`          | `string[]`     | No       | Filterable tags                                  |
| `prerequisites` | `string[]`     | No       | Required dependencies or setup steps             |

### Mode-Specific Fields

| Field     | Type     | Required | Description                                                              |
| --------- | -------- | -------- | ------------------------------------------------------------------------ |
| `type`    | `"mode"` | Yes      | Discriminant                                                             |
| `content` | `string` | Yes      | YAML content defining the mode (slug, name, roleDefinition, tools, etc.) |

### MCP-Specific Fields

| Field        | Type                                | Required | Description                                                                       |
| ------------ | ----------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `type`       | `"mcp"`                             | Yes      | Discriminant                                                                      |
| `url`        | `string` (URL)                      | Yes      | Link to MCP documentation or source                                               |
| `content`    | `string \| McpInstallationMethod[]` | Yes      | Either a single JSON MCP config string, or an array of named installation methods |
| `parameters` | `McpParameter[]`                    | No       | Global parameters (shared across all methods)                                     |

### McpInstallationMethod

| Field           | Type             | Description                                     |
| --------------- | ---------------- | ----------------------------------------------- |
| `name`          | `string`         | Display name for the method (shown in dropdown) |
| `content`       | `string`         | JSON MCP server config for this method          |
| `parameters`    | `McpParameter[]` | Method-specific parameters                      |
| `prerequisites` | `string[]`       | Method-specific prerequisites                   |

### McpParameter

| Field         | Type      | Description                                          |
| ------------- | --------- | ---------------------------------------------------- |
| `name`        | `string`  | Human-readable parameter name                        |
| `key`         | `string`  | Template key (replaced as `{{key}}` in content)      |
| `placeholder` | `string`  | Placeholder text for the input field                 |
| `optional`    | `boolean` | Whether the parameter is optional (default: `false`) |

### Installation Options

| Field        | Type                    | Default     | Description                                                                     |
| ------------ | ----------------------- | ----------- | ------------------------------------------------------------------------------- |
| `target`     | `"project" \| "global"` | `"project"` | Installation scope                                                              |
| `parameters` | `Record<string, any>`   | —           | User-provided parameter values; includes `_selectedIndex` for multi-method MCPs |

### Installation Metadata

```typescript
interface MarketplaceInstalledMetadata {
	project: Record<string, { type: string }> // id → { type: "mode" | "mcp" }
	global: Record<string, { type: string }> // id → { type: "mode" | "mcp" }
}
```

This is computed at runtime by reading the actual config files (`.shofer/shofermodes`, `mcp.json`, etc.) rather than stored in a database.

---

## API Endpoints

The marketplace fetches data from the Shofer API. The base URL is defined by the `SHOFER_API_URL` environment variable (defaulting to `"https://app.shofer.dev"`) in [`RemoteConfigLoader.ts`](extensions/shofer/src/services/marketplace/RemoteConfigLoader.ts:12).

| Endpoint                     | Response Format                              | Description                |
| ---------------------------- | -------------------------------------------- | -------------------------- |
| `GET /api/marketplace/modes` | YAML with `{ items: ModeMarketplaceItem[] }` | All available custom modes |
| `GET /api/marketplace/mcps`  | YAML with `{ items: McpMarketplaceItem[] }`  | All available MCP servers  |

- Requests send `Accept: application/json` and `Content-Type: application/json` headers
- Timeout: 10 seconds
- Retries: up to 3 with exponential backoff (1s, 2s, 4s)
- Cache: 5-minute in-memory cache per category (modes/mcps)
- The `hideMarketplaceMcps` organization setting causes the MCP fetch to be skipped entirely (returns empty array)

---

## Organization / Cloud Integration

When a user is authenticated with **Shofer Cloud**, organization settings would augment the marketplace. However, the cloud integration that provided organization-controlled MCP catalogs has been removed from the current codebase. The `orgSettings` variable in [`MarketplaceManager.getMarketplaceItems()`](extensions/shofer/src/services/marketplace/MarketplaceManager.ts:41) is always `undefined`, and the comment reads `"Cloud services removed; orgSettings remains undefined"`.

The [`MarketplaceView`](extensions/shofer/webview-ui/src/components/marketplace/MarketplaceView.tsx) still watches `organizationSettingsVersion` from `ExtensionStateContext` and re-fetches marketplace data whenever the version changes, though in the current code this version is always `-1`.

---

## Client-Side State Management

The [`MarketplaceViewStateManager`](extensions/shofer/webview-ui/src/components/marketplace/MarketplaceViewStateManager.ts) implements a state machine with these transitions:

| Transition       | Payload                                      | Effect                                                                                              |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `FETCH_ITEMS`    | —                                            | Sets `isFetching: true`                                                                             |
| `FETCH_COMPLETE` | `{ items: MarketplaceItem[] }`               | Updates `allItems`, computes `displayItems` with active filters, sets `isFetching: false`           |
| `FETCH_ERROR`    | —                                            | Preserves current items, resets `isFetching`                                                        |
| `SET_ACTIVE_TAB` | `{ tab: "mcp" \| "mode" }`                   | Switches active tab, no re-fetch                                                                    |
| `UPDATE_FILTERS` | `{ filters: Partial<ViewState["filters"]> }` | Updates filters, re-applies filtering client-side, sends `filterMarketplaceItems` to extension host |

### Filter States

| Filter      | Type                                      | Values                  | Description                               |
| ----------- | ----------------------------------------- | ----------------------- | ----------------------------------------- |
| `type`      | `string`                                  | `""`, `"mcp"`, `"mode"` | Filter by item type                       |
| `search`    | `string`                                  | any text                | Case-insensitive name/description search  |
| `tags`      | `string[]`                                | array of tag strings    | Items must have at least one matching tag |
| `installed` | `"all" \| "installed" \| "not_installed"` | —                       | Filter by install status                  |

Filters are applied client-side in `filterItems()` which checks type, search, tags, and install status against `installedMetadata`.

---

## Configuration File Locations

### Project Scope

| Item Type | File Path                         | Format                           |
| --------- | --------------------------------- | -------------------------------- |
| Mode      | `<workspace>/.shofer/shofermodes` | YAML (`customModes: [...]`)      |
| MCP       | `<workspace>/.shofer/mcp.json`    | JSON (`{ mcpServers: { ... } }`) |

### Global Scope

| Item Type | File Path                            | Format |
| --------- | ------------------------------------ | ------ |
| Mode      | `<globalSettings>/custom-modes.yaml` | YAML   |
| MCP       | `<globalSettings>/mcp-settings.json` | JSON   |

The global settings directory is resolved via [`ensureSettingsDirectoryExists()`](extensions/shofer/src/utils/globalContext.ts).

---

## Webview ↔ Extension Host Messages

### Webview → Extension Host

| Message Type                           | Payload                        | Description                         |
| -------------------------------------- | ------------------------------ | ----------------------------------- |
| `fetchMarketplaceData`                 | —                              | Requests fresh marketplace data     |
| `filterMarketplaceItems`               | `{ type?, search?, tags? }`    | Applies server-side filters         |
| `installMarketplaceItem`               | `{ mpItem, mpInstallOptions }` | Installs an item                    |
| `installMarketplaceItemWithParameters` | `{ item, parameters }`         | Installs with pre-filled parameters |
| `removeInstalledMarketplaceItem`       | `{ mpItem, mpInstallOptions }` | Removes an installed item           |
| `marketplaceButtonClicked`             | `{ marketplaceTab? }`          | Opens marketplace to specific tab   |

### Extension Host → Webview

| Message Type               | Payload                                                                         | Description                    |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `marketplaceData`          | `{ organizationMcps, marketplaceItems, marketplaceInstalledMetadata, errors? }` | Full marketplace state         |
| `marketplaceInstallResult` | `{ success, slug, error? }`                                                     | Installation outcome           |
| `marketplaceRemoveResult`  | `{ success, slug, error? }`                                                     | Removal outcome                |
| `state`                    | `{ marketplaceItems?, marketplaceInstalledMetadata? }`                          | Included in regular state sync |

---

## Error Handling

- **API fetch failures**: `MarketplaceManager.getMarketplaceItems()` returns `{ organizationMcps: [], marketplaceItems: [], errors: [...] }` instead of throwing
- **Install/remove failures**: Toast notifications via `vscode.window.showErrorMessage()` with localized messages
- **Invalid YAML/JSON in config files**: `SimpleInstaller` checks for `YAMLParseError` / `SyntaxError` before overwriting and throws descriptive errors
- **Missing content/slug**: Validation at install time — `SimpleInstaller` throws if mode content lacks a slug or is in array format
- **Network timeout**: User sees a warning toast: _"Marketplace data could not be loaded due to network restrictions. Core functionality remains available."_
- **Empty state**: Rendered with an inbox icon, descriptive text, and a "Clear all filters" button

---

## Privacy

Per the [Shofer Privacy Policy](extensions/shofer/PRIVACY.md):

> When you browse or search the Marketplace for Model Configuration Profiles (MCPs) or Custom Modes, Shofer makes a secure API call to Shofer's backend servers to retrieve listing information. These requests send only the query parameters (e.g., extension version, search term) necessary to fulfill the request and do not include your code, prompts, or personally identifiable information.

---

## Gaps, Issues & Improvement Areas

The following deficiencies were discovered during the 2026-05-20 verification of this doc against the live codebase.

1. **`cancelMarketplaceInstall` message type not documented**: The [`WebviewMessage` union](extensions/shofer/packages/types/src/vscode-extension-host.ts:642) includes `"cancelMarketplaceInstall"` but this doc does not mention it in the message tables.

2. **`filterMarketplaceItems` handler doesn't do server-side filtering**: The webview message handler at [`webviewMessageHandler.ts:3065-3074`](extensions/shofer/src/core/webview/webviewMessageHandler.ts:3065) delegates to `MarketplaceManager.filterItems()`, which is a private method that does client-side filtering — not a server-side operation. The doc describes it as "Applies server-side filters" in the message table but the actual behavior is local.

3. **Stale line numbers for `McpView.tsx` marketplace button**: The doc says lines 197-211 but the button block spans lines 196-217 in the current source. The start (`MARKETPLACE_ENABLED &&`) is at line 196 and the closing `</StandardTooltip>)` is at line 216-217.

4. **Stale line numbers for `SkillsSettings.tsx` marketplace link**: The doc says lines 289-291 but the `window.postMessage` block starts at line 288.

5. **`filterMarketplaceItems` message payload mismatch**: The Webview → Extension Host table says the payload is `{ type?, search?, tags? }` but the actual handler at [`webviewMessageHandler.ts:3065-3074`](extensions/shofer/src/core/webview/webviewMessageHandler.ts:3065) accesses `message.filters.type`, `message.filters.search`, `message.filters.tags` — the payload is nested under `filters`, not flat.

6. **`McpView.tsx` line range in entry points table**: Doc says lines 197-211 but the marketplace button spans 196-217.

7. **No `PRIVACY.md` verification**: The Privacy section references `extensions/shofer/PRIVACY.md` which was not verified to exist during this review.

8. **Phantom `CloudService` and `OrganizationSettings`**: The doc previously described a `CloudService` providing `OrganizationSettings` with `mcps`, `hiddenMcps`, and `hideMarketplaceMcps` fields. Cloud integration has been removed; `MarketplaceManager.constructor` no longer creates a `CloudService` and `orgSettings` stays `undefined`. This doc has been updated but the `hideMarketplaceMcps` bullet in the API Endpoints section (§ "The `hideMarketplaceMcps` organization setting causes…") is still misleading since `orgSettings` is always `undefined` — the MCP fetch is never skipped.

## Release History

| Version  | Date       | Change                                                            |
| -------- | ---------- | ----------------------------------------------------------------- |
| v3.21.0  | 2025-06-17 | Initial marketplace release with MCPs and modes                   |
| v3.21.2  | 2025-06-20 | Fix marketplace blanking after populating; resolve timeout issues |
| v3.21.3  | 2025-06-21 | Display installed MCPs in marketplace                             |
| v3.22.6  | 2025-07-02 | Add import/export modes functionality                             |
| v3.23.7  | 2025-07-11 | Link to marketplace from modes and MCP tab                        |
| v3.23.15 | 2025-07-18 | Move marketplace icon from overflow menu to top navigation        |
| v3.25.21 | 2025-08-21 | Add "installed" filter to marketplace                             |
| v3.39.0  | 2026-01-08 | Rename marketplace button references                              |
