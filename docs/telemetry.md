# Shofer Telemetry System

<!-- TOC -->

- [Architecture Overview](#architecture-overview)
- [Package: `@shofer/telemetry`](#package-shofertelemetry)
    - [`TelemetryService`](#telemetryservice)
    - [`PostHogTelemetryClient`](#posthogtelemetryclient)
    - [`BaseTelemetryClient`](#basetelemetryclient)
- [Package: `@shofer/types` — Telemetry Types](#package-shofertypes--telemetry-types)
    - [`TelemetrySetting`](#telemetrysetting)
    - [`TelemetryEventName`](#telemetryeventname)
    - [`TelemetryProperties`](#telemetryproperties)
    - [Error Utilities](#error-utilities)
    - [`ApiProviderError`](#apiprovidererror)
    - [`ConsecutiveMistakeError`](#consecutivemistakeerror)
- [Webview-Side Telemetry](#webview-side-telemetry)
- [Telemetry Flow & Initialization](#telemetry-flow--initialization)
- [Event Catalog](#event-catalog)
    - [Task Lifecycle Events](#task-lifecycle-events)
    - [Tool & Mode Events](#tool--mode-events)
    - [Context & Performance Events](#context--performance-events)
    - [UI & Interaction Events](#ui--interaction-events)
    - [Cloud & Marketplace Events](#cloud--marketplace-events)
    - [Error Events](#error-events)
- [Privacy & Data Filtering](#privacy--data-filtering)
- [Opt-Out Mechanism](#opt-out-mechanism)
- [Integration Points](#integration-points)
    - [Extension Host (`src/`)](#extension-host-src)
    - [Code Indexing Service](#code-indexing-service)
    - [AI Providers](#ai-providers)
    - [Webview UI](#webview-ui)
- [Testing](#testing)
    <!-- /TOC -->

---

## Architecture Overview

Shofer uses a **multi-client telemetry architecture** with a singleton [`TelemetryService`](packages/telemetry/src/TelemetryService.ts:24) that acts as a multiplexer, fanning out all events to one or more registered [`TelemetryClient`](packages/types/src/telemetry.ts:275) implementations. The system is split across two packages and two runtime environments:

```
┌─────────────────────────────────────────────────────────┐
│  Extension Host (Node.js)                                │
│                                                          │
│  TelemetryService (singleton)                            │
│  ├── PostHogTelemetryClient  ──► posthog-node  ──► ph.shofer.dev │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  Webview UI (Browser)                                    │
│                                                          │
│  TelemetryClient (singleton)                             │
│  └── posthog-js  ───────────► ph.shofer.dev             │
└─────────────────────────────────────────────────────────┘
```

| Component                                                                       | Runtime                  | Library        | Endpoint                |
| ------------------------------------------------------------------------------- | ------------------------ | -------------- | ----------------------- |
| [`PostHogTelemetryClient`](packages/telemetry/src/PostHogTelemetryClient.ts:30) | Node.js (extension host) | `posthog-node` | `https://ph.shofer.dev` |
| [`TelemetryClient`](webview-ui/src/utils/TelemetryClient.ts:5)                  | Browser (webview)        | `posthog-js`   | `https://ph.shofer.dev` |

---

## Package: `@shofer/telemetry`

**Location:** [`packages/telemetry/`](packages/telemetry/)

**Dependencies:** `posthog-node@^5.0.0`, `zod@^3.25.61`, `@shofer/types`

### `TelemetryService`

**File:** [`packages/telemetry/src/TelemetryService.ts`](packages/telemetry/src/TelemetryService.ts)

The central orchestration point for all telemetry. Implements a **singleton pattern** via `TelemetryService.createInstance()` and `TelemetryService.instance`.

#### Key Methods

| Method                                                                                            | Description                                                                            |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`createInstance(clients?)`](packages/telemetry/src/TelemetryService.ts:366)                      | Creates the singleton. Throws if already created.                                      |
| [`instance`](packages/telemetry/src/TelemetryService.ts:375)                                      | Static getter; throws if not initialized.                                              |
| [`hasInstance()`](packages/telemetry/src/TelemetryService.ts:383)                                 | Safe check before accessing `.instance`.                                               |
| [`isGloballyEnabled()`](packages/telemetry/src/TelemetryService.ts:334)                           | Returns whether `TELEMETRY_ENABLED` env var is set.                                    |
| [`register(client)`](packages/telemetry/src/TelemetryService.ts:27)                               | Registers a new `TelemetryClient`.                                                     |
| [`setProvider(provider)`](packages/telemetry/src/TelemetryService.ts:38)                          | Sets a `TelemetryPropertiesProvider` on all clients for automatic property enrichment. |
| [`updateTelemetryState(isOptedIn)`](packages/telemetry/src/TelemetryService.ts:61)                | Toggles telemetry on/off across all clients.                                           |
| [`captureEvent(eventName, properties?)`](packages/telemetry/src/TelemetryService.ts:75)           | Generic event capture; fans out to all clients.                                        |
| [`captureException(error, additionalProperties?)`](packages/telemetry/src/TelemetryService.ts:88) | Exception capture (PostHog error tracking).                                            |
| [`shutdown()`](packages/telemetry/src/TelemetryService.ts:356)                                    | Gracefully shuts down all clients.                                                     |

#### Convenience Event Methods

The service provides typed convenience methods for every event type. Each method internally calls [`captureEvent()`](packages/telemetry/src/TelemetryService.ts:75) with the appropriate [`TelemetryEventName`](packages/types/src/telemetry.ts:20) enum value:

| Method                                                                              | Event                        | Parameters                                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| [`captureTaskCreated`](packages/telemetry/src/TelemetryService.ts:96)               | `TASK_CREATED`               | `taskId`                                                                          |
| [`captureTaskRestarted`](packages/telemetry/src/TelemetryService.ts:100)            | `TASK_RESTARTED`             | `taskId`                                                                          |
| [`captureTaskCompleted`](packages/telemetry/src/TelemetryService.ts:104)            | `TASK_COMPLETED`             | `taskId`                                                                          |
| [`captureConversationMessage`](packages/telemetry/src/TelemetryService.ts:108)      | `TASK_CONVERSATION_MESSAGE`  | `taskId`, `source`                                                                |
| [`captureLlmCompletion`](packages/telemetry/src/TelemetryService.ts:112)            | `LLM_COMPLETION`             | `taskId`, `{inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, cost?}` |
| [`captureModeSwitch`](packages/telemetry/src/TelemetryService.ts:125)               | `MODE_SWITCH`                | `taskId`, `newMode`                                                               |
| [`captureToolUsage`](packages/telemetry/src/TelemetryService.ts:129)                | `TOOL_USED`                  | `taskId`, `tool`                                                                  |
| [`captureCheckpointCreated`](packages/telemetry/src/TelemetryService.ts:133)        | `CHECKPOINT_CREATED`         | `taskId`                                                                          |
| [`captureCheckpointDiffed`](packages/telemetry/src/TelemetryService.ts:137)         | `CHECKPOINT_DIFFED`          | `taskId`                                                                          |
| [`captureCheckpointRestored`](packages/telemetry/src/TelemetryService.ts:141)       | `CHECKPOINT_RESTORED`        | `taskId`                                                                          |
| [`captureContextCondensed`](packages/telemetry/src/TelemetryService.ts:145)         | `CONTEXT_CONDENSED`          | `taskId`, `isAutomaticTrigger`, `usedCustomPrompt?`                               |
| [`captureSlidingWindowTruncation`](packages/telemetry/src/TelemetryService.ts:153)  | `SLIDING_WINDOW_TRUNCATION`  | `taskId`                                                                          |
| [`captureCodeActionUsed`](packages/telemetry/src/TelemetryService.ts:157)           | `CODE_ACTION_USED`           | `actionType`                                                                      |
| [`capturePromptEnhanced`](packages/telemetry/src/TelemetryService.ts:161)           | `PROMPT_ENHANCED`            | `taskId?`                                                                         |
| [`captureSchemaValidationError`](packages/telemetry/src/TelemetryService.ts:165)    | `SCHEMA_VALIDATION_ERROR`    | `{schemaName, error}`                                                             |
| [`captureDiffApplicationError`](packages/telemetry/src/TelemetryService.ts:170)     | `DIFF_APPLICATION_ERROR`     | `taskId`, `consecutiveMistakeCount`                                               |
| [`captureShellIntegrationError`](packages/telemetry/src/TelemetryService.ts:174)    | `SHELL_INTEGRATION_ERROR`    | `taskId`                                                                          |
| [`captureConsecutiveMistakeError`](packages/telemetry/src/TelemetryService.ts:178)  | `CONSECUTIVE_MISTAKE_ERROR`  | `taskId`                                                                          |
| [`captureMcpAsyncCallStarted`](packages/telemetry/src/TelemetryService.ts:188)      | `MCP_ASYNC_CALL_STARTED`     | `taskId`, `{callId, serverName, toolName}`                                        |
| [`captureMcpAsyncCallCompleted`](packages/telemetry/src/TelemetryService.ts:195)    | `MCP_ASYNC_CALL_COMPLETED`   | `taskId`, `{callId, serverName, toolName, isError, durationMs}`                   |
| [`captureMcpAsyncCallCancelled`](packages/telemetry/src/TelemetryService.ts:202)    | `MCP_ASYNC_CALL_CANCELLED`   | `taskId`, `{callId, serverName, toolName, durationMs}`                            |
| [`captureMcpAsyncCallTimedOut`](packages/telemetry/src/TelemetryService.ts:209)     | `MCP_ASYNC_CALL_TIMED_OUT`   | `taskId`, `{callId, serverName, toolName, timeoutSec}`                            |
| [`captureBudgetExceeded`](packages/telemetry/src/TelemetryService.ts:220)           | `BUDGET_EXCEEDED`            | `taskId`, `{rootTaskId, limitUsd, spentUsd, action, modelId}`                     |
| [`captureTabShown`](packages/telemetry/src/TelemetryService.ts:237)                 | `TAB_SHOWN`                  | `tab`                                                                             |
| [`captureModeSettingChanged`](packages/telemetry/src/TelemetryService.ts:245)       | `MODE_SETTINGS_CHANGED`      | `settingName`                                                                     |
| [`captureCustomModeCreated`](packages/telemetry/src/TelemetryService.ts:254)        | `CUSTOM_MODE_CREATED`        | `modeSlug`, `modeName`                                                            |
| [`captureMarketplaceItemInstalled`](packages/telemetry/src/TelemetryService.ts:266) | `MARKETPLACE_ITEM_INSTALLED` | `itemId`, `itemType`, `itemName`, `target`, `properties?`                         |
| [`captureMarketplaceItemRemoved`](packages/telemetry/src/TelemetryService.ts:290)   | `MARKETPLACE_ITEM_REMOVED`   | `itemId`, `itemType`, `itemName`, `target`                                        |
| [`captureTitleButtonClicked`](packages/telemetry/src/TelemetryService.ts:303)       | `TITLE_BUTTON_CLICKED`       | `button`                                                                          |
| [`captureTelemetrySettingsChanged`](packages/telemetry/src/TelemetryService.ts:312) | `TELEMETRY_SETTINGS_CHANGED` | `previousSetting`, `newSetting`                                                   |
| [`captureCodeIndexSegmentDedup`](packages/telemetry/src/TelemetryService.ts:346)    | `CODE_INDEX_SEGMENT_DEDUP`   | `{fileCount, totalBlocks, reused, embedded, deleted}`                             |
| [`capturePeerMessageSent`](packages/telemetry/src/TelemetryService.ts:346)          | `TASK_PEER_MESSAGE_SENT`     | `taskId`, peer-message metadata                                                   |
| [`capturePeerMessageReceived`](packages/telemetry/src/TelemetryService.ts:350)      | `TASK_PEER_MESSAGE_RECEIVED` | `taskId`, peer-message metadata                                                   |
| [`capturePeerDiscovery`](packages/telemetry/src/TelemetryService.ts:354)            | `TASK_PEER_DISCOVERY`        | `taskId`, discovery metadata                                                      |
| [`isTelemetryEnabled`](packages/telemetry/src/TelemetryService.ts:323)              | —                            | Returns `true` if any client has telemetry enabled                                |

### `PostHogTelemetryClient`

**File:** [`packages/telemetry/src/PostHogTelemetryClient.ts`](packages/telemetry/src/PostHogTelemetryClient.ts)

The primary Node.js-side telemetry client, backed by [`posthog-node`](https://www.npmjs.com/package/posthog-node).

#### Configuration

| Setting          | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| **PostHog host** | `https://ph.shofer.dev`                                    |
| **Distinct ID**  | `vscode.env.machineId`                                     |
| **API key**      | `process.env.POSTHOG_API_KEY` from [`.env`](.env.sample:1) |

#### Event Subscription

Uses an **exclusion list** pattern: subscribes to all events **except** `TASK_MESSAGE` and `LLM_COMPLETION` (line 30). These are excluded from PostHog because they contain high-cardinality payload data.

```typescript
// From BaseTelemetryClient constructor call (lines 37-43):
{
    type: "exclude",
    events: [TelemetryEventName.TASK_MESSAGE, TelemetryEventName.LLM_COMPLETION],
}
```

#### Privacy Filters

The client **filters out git repository properties** from all events via [`isPropertyCapturable()`](packages/telemetry/src/PostHogTelemetryClient.ts:55). Properties excluded:

- `repositoryUrl`
- `repositoryName`
- `defaultBranch`

#### Two-Phase Telemetry Gating

[`updateTelemetryState(didUserOptIn)`](packages/telemetry/src/PostHogTelemetryClient.ts:155) implements a two-phase check:

1. **VSCode global telemetry level** — must be `"all"` (reads `telemetry.telemetryLevel` from VSCode configuration)
2. **User opt-in** — the extension-specific `telemetrySetting` must not be `"disabled"`

If either check fails, telemetry is disabled and `posthog-node` is set to `optOut()`.

#### Error Filtering in `captureException`

[`captureException()`](packages/telemetry/src/PostHogTelemetryClient.ts:85) applies the following filters before sending:

1. **402 Payment Required** — filtered out (billing issues are expected)
2. **429 Rate Limit** — filtered out (rate limits are expected)
3. **Messages starting with `429`** — filtered out
4. **Messages containing `rate limit`** (case-insensitive) — filtered out

For non-filtered errors, the method:

- Extracts structured properties from [`ApiProviderError`](packages/types/src/telemetry.ts:456) instances (provider, modelId, operation, errorCode)
- Extracts structured properties from [`ConsecutiveMistakeError`](packages/types/src/telemetry.ts:506) instances (taskId, counts, reason)
- Overrides the error message with the most descriptive nested message (e.g., upstream provider errors from OpenRouter metadata)
- Appends `$app_version` from the provider's telemetry properties
- Merges any additional properties passed by the caller

### `BaseTelemetryClient`

**File:** [`packages/telemetry/src/BaseTelemetryClient.ts`](packages/telemetry/src/BaseTelemetryClient.ts)

Abstract base class implementing the [`TelemetryClient`](packages/types/src/telemetry.ts:275) interface. Provides:

| Feature                 | Description                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event subscription**  | Include/exclude event filtering via [`isEventCapturable()`](packages/telemetry/src/BaseTelemetryClient.ts:18)                                                                 |
| **Provider reference**  | Weak reference to a [`TelemetryPropertiesProvider`](packages/types/src/telemetry.ts:255) via [`setProvider()`](packages/telemetry/src/BaseTelemetryClient.ts:64)              |
| **Property enrichment** | [`getEventProperties()`](packages/telemetry/src/BaseTelemetryClient.ts:36) merges provider properties with event-specific properties, with event properties taking precedence |
| **Property filtering**  | Hook method [`isPropertyCapturable()`](packages/telemetry/src/BaseTelemetryClient.ts:32) for subclass privacy filtering                                                       |

---

## Package: `@shofer/types` — Telemetry Types

**File:** [`packages/types/src/telemetry.ts`](packages/types/src/telemetry.ts)

### `TelemetrySetting`

Three possible values:

```typescript
type TelemetrySetting = "unset" | "enabled" | "disabled"
```

| Value        | Meaning                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| `"unset"`    | User hasn't made a choice yet. Treated as **disabled** until explicitly set. |
| `"enabled"`  | User explicitly opted in.                                                    |
| `"disabled"` | User explicitly opted out.                                                   |

### `TelemetryEventName`

Complete enum of all telemetry event names:

```typescript
enum TelemetryEventName {
	// Task lifecycle
	TASK_CREATED = "Task Created",
	TASK_RESTARTED = "Task Reopened",
	TASK_COMPLETED = "Task Completed",
	TASK_MESSAGE = "Task Message",
	TASK_CONVERSATION_MESSAGE = "Conversation Message",

	// LLM
	LLM_COMPLETION = "LLM Completion",

	// Mode & Tool
	MODE_SWITCH = "Mode Switched",
	MODE_SELECTOR_OPENED = "Mode Selector Opened",
	TOOL_USED = "Tool Used",

	// Checkpoints
	CHECKPOINT_CREATED = "Checkpoint Created",
	CHECKPOINT_RESTORED = "Checkpoint Restored",
	CHECKPOINT_DIFFED = "Checkpoint Diffed",

	// UI / Settings
	TAB_SHOWN = "Tab Shown",
	MODE_SETTINGS_CHANGED = "Mode Setting Changed",
	CUSTOM_MODE_CREATED = "Custom Mode Created",

	// Context
	CONTEXT_CONDENSED = "Context Condensed",
	SLIDING_WINDOW_TRUNCATION = "Sliding Window Truncation",

	// Code Actions
	CODE_ACTION_USED = "Code Action Used",
	PROMPT_ENHANCED = "Prompt Enhanced",

	// UI
	TITLE_BUTTON_CLICKED = "Title Button Clicked",

	// Auth
	AUTHENTICATION_INITIATED = "Authentication Initiated",

	// Marketplace
	MARKETPLACE_ITEM_INSTALLED = "Marketplace Item Installed",
	MARKETPLACE_ITEM_REMOVED = "Marketplace Item Removed",
	MARKETPLACE_TAB_VIEWED = "Marketplace Tab Viewed",
	MARKETPLACE_INSTALL_BUTTON_CLICKED = "Marketplace Install Button Clicked",

	// Sharing
	SHARE_BUTTON_CLICKED = "Share Button Clicked",
	SHARE_ORGANIZATION_CLICKED = "Share Organization Clicked",
	SHARE_PUBLIC_CLICKED = "Share Public Clicked",
	SHARE_CONNECT_TO_CLOUD_CLICKED = "Share Connect To Cloud Clicked",

	// Account
	ACCOUNT_CONNECT_CLICKED = "Account Connect Clicked",
	ACCOUNT_CONNECT_SUCCESS = "Account Connect Success",
	ACCOUNT_LOGOUT_CLICKED = "Account Logout Clicked",
	ACCOUNT_LOGOUT_SUCCESS = "Account Logout Success",

	// Provider
	FEATURED_PROVIDER_CLICKED = "Featured Provider Clicked",

	// Upsell
	UPSELL_DISMISSED = "Upsell Dismissed",
	UPSELL_CLICKED = "Upsell Clicked",

	// Errors
	SCHEMA_VALIDATION_ERROR = "Schema Validation Error",
	DIFF_APPLICATION_ERROR = "Diff Application Error",
	SHELL_INTEGRATION_ERROR = "Shell Integration Error",
	CONSECUTIVE_MISTAKE_ERROR = "Consecutive Mistake Error",
	CODE_INDEX_ERROR = "Code Index Error",
	ASSISTANT_AGENT_ERROR = "Assistant Agent Error",
	TELEMETRY_SETTINGS_CHANGED = "Telemetry Settings Changed",
	MODEL_CACHE_EMPTY_RESPONSE = "Model Cache Empty Response",
	READ_FILE_LEGACY_FORMAT_USED = "Read File Legacy Format Used",
	BUDGET_EXCEEDED = "Budget Exceeded",
	CODE_INDEX_SEGMENT_DEDUP = "Code Index Segment Dedup",

	// Async MCP tool calls
	MCP_ASYNC_CALL_STARTED = "MCP Async Call Started",
	MCP_ASYNC_CALL_COMPLETED = "MCP Async Call Completed",
	MCP_ASYNC_CALL_CANCELLED = "MCP Async Call Cancelled",
	MCP_ASYNC_CALL_TIMED_OUT = "MCP Async Call Timed Out",

	// Peer messaging (task-to-task)
	TASK_PEER_MESSAGE_SENT = "Task Peer Message Sent",
	TASK_PEER_MESSAGE_RECEIVED = "Task Peer Message Received",
	TASK_PEER_DISCOVERY = "Task Peer Discovery",
}
```

### `TelemetryProperties`

Every event is enriched with properties from the [`TelemetryPropertiesProvider`](packages/types/src/telemetry.ts:255) (implemented by [`ShoferProvider`](src/core/webview/ShoferProvider.ts)):

#### Static App Properties (computed once at startup)

- `appName` — always `"Shofer"`
- `appVersion` — from `package.json`
- `vscodeVersion` — VSCode version string
- `platform` — OS platform
- `editorName` — editor name (e.g., `"vscode"`)
- `hostname` — optional machine hostname

#### Dynamic App Properties (computed per event)

- `language` — user's selected UI language (e.g., `"en"`)
- `mode` — current mode slug (e.g., `"code"`, `"architect"`)

#### Cloud Properties

- `cloudIsAuthenticated` — whether the user is signed into Shofer Cloud

#### Task Properties (present when a task is active)

- `taskId` — current task ID
- `parentTaskId` — parent task ID for subtasks
- `apiProvider` — provider name (e.g., `"anthropic"`, `"openrouter"`)
- `modelId` — model identifier
- `diffStrategy` — diff strategy name
- `isSubtask` — boolean indicating if current task is a subtask
- `todos` — optional breakdown of todo list state (`{total, completed, inProgress, pending}`)

#### Git Properties (filtered from PostHog)

- `repositoryUrl` — sanitized HTTPS repo URL
- `repositoryName` — repo name
- `defaultBranch` — default branch

### Error Utilities

The types package provides a suite of error classification utilities used by the telemetry system:

| Function                                                                                 | File Location      | Purpose                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| [`getErrorStatusCode(error)`](packages/types/src/telemetry.ts:347)                       | `telemetry.ts:335` | Extracts HTTP status code from OpenAI SDK errors                                                   |
| [`getErrorMessage(error)`](packages/types/src/telemetry.ts:397)                          | `telemetry.ts:385` | Extracts most descriptive error message (prioritizes nested metadata → `error.message`)            |
| [`extractMessageFromJsonPayload(message)`](packages/types/src/telemetry.ts:362)          | `telemetry.ts:350` | Parses JSON-embedded error messages (e.g., `503 {"error":{"message":"..."}}`)                      |
| [`shouldReportApiErrorToTelemetry(code?, msg?)`](packages/types/src/telemetry.ts:434)    | `telemetry.ts:422` | Returns `false` for expected errors (402, 429, rate limit patterns)                                |
| [`isApiProviderError(error)`](packages/types/src/telemetry.ts:473)                       | `telemetry.ts:461` | Type guard for `ApiProviderError`                                                                  |
| [`extractApiProviderErrorProperties(error)`](packages/types/src/telemetry.ts:487)        | `telemetry.ts:475` | Extracts `{provider, modelId, operation, errorCode?}`                                              |
| [`isConsecutiveMistakeError(error)`](packages/types/src/telemetry.ts:525)                | `telemetry.ts:513` | Type guard for `ConsecutiveMistakeError`                                                           |
| [`extractConsecutiveMistakeErrorProperties(error)`](packages/types/src/telemetry.ts:539) | `telemetry.ts:527` | Extracts `{taskId, consecutiveMistakeCount, consecutiveMistakeLimit, reason, provider?, modelId?}` |

### `ApiProviderError`

```typescript
class ApiProviderError extends Error {
	constructor(
		message: string,
		provider: string, // e.g., "OpenRouter", "Anthropic"
		modelId: string, // e.g., "gpt-4", "claude-sonnet-4-5"
		operation: string, // e.g., "createMessage", "completePrompt"
		errorCode?: number, // HTTP status code
	)
}
```

### `ConsecutiveMistakeError`

```typescript
type ConsecutiveMistakeReason = "no_tools_used" | "tool_repetition" | "unknown"

class ConsecutiveMistakeError extends Error {
	constructor(
		message: string,
		taskId: string,
		consecutiveMistakeCount: number,
		consecutiveMistakeLimit: number,
		reason: ConsecutiveMistakeReason,
		provider?: string,
		modelId?: string,
	)
}
```

---

## Webview-Side Telemetry

**File:** [`webview-ui/src/utils/TelemetryClient.ts`](webview-ui/src/utils/TelemetryClient.ts)

A **browser-side** singleton that uses [`posthog-js`](https://www.npmjs.com/package/posthog-js) for UI interaction tracking.

### Initialization

Called from [`App.tsx`](webview-ui/src/App.tsx:191) after state hydration:

```typescript
telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, machineId)
```

### Configuration

| Setting            | Value                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- |
| **API host**       | `https://ph.shofer.dev`                                                                |
| **UI host**        | `https://us.posthog.com`                                                               |
| **Persistence**    | `localStorage`                                                                         |
| **Autocapture**    | Disabled (`capture_pageview: false`, `capture_pageleave: false`, `autocapture: false`) |
| **Identification** | `posthog.identify(distinctId)` on load                                                 |

### UI Events Tracked

| UI Component          | Event                                   | Source                                                                                                   |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Mode Selector         | `MODE_SELECTOR_OPENED`                  | [`ModeSelector.tsx`](webview-ui/src/components/chat/ModeSelector.tsx:56)                                 |
| Marketplace Tab       | `MARKETPLACE_TAB_VIEWED`                | [`App.tsx`](webview-ui/src/App.tsx:224)                                                                  |
| Marketplace Install   | `MARKETPLACE_INSTALL_BUTTON_CLICKED`    | [`MarketplaceItemCard.tsx`](webview-ui/src/components/marketplace/components/MarketplaceItemCard.tsx:82) |
| (webview)             | `ACCOUNT_CONNECT_CLICKED`               | — (source file not yet present)                                                                          |
| Cloud Connect Success | `ACCOUNT_CONNECT_SUCCESS`               | [`useCloudUpsell.ts`](webview-ui/src/hooks/useCloudUpsell.ts:28)                                         |
| Upsell Dismissed      | `UPSELL_DISMISSED`                      | [`DismissibleUpsell.tsx`](webview-ui/src/components/common/DismissibleUpsell.tsx:83)                     |
| Upsell Clicked        | `UPSELL_CLICKED`                        | [`DismissibleUpsell.tsx`](webview-ui/src/components/common/DismissibleUpsell.tsx:146)                    |
| Error Boundary        | `error_boundary_caught_error`           | [`ErrorBoundary.tsx`](webview-ui/src/components/ErrorBoundary.tsx:41)                                    |
| UI Settings           | `ui_settings_collapse_thinking_changed` | [`UISettings.tsx`](webview-ui/src/components/settings/UISettings.tsx:36)                                 |
| UI Settings           | `ui_settings_enter_behavior_changed`    | [`UISettings.tsx`](webview-ui/src/components/settings/UISettings.tsx:46)                                 |

---

## Telemetry Flow & Initialization

### Extension Activation Sequence

1. **Extension activates** → `extension.ts:activate()` (startup)
2. **Network proxy** initialized (debug mode only) → `extension.ts` (startup)
3. **Settings migrated** → `extension.ts` (startup)
4. **TelemetryService created** as singleton → `extension.ts` (startup)
5. **PostHogTelemetryClient registered** → `extension.ts` (startup)
6. **ShoferProvider created** → registered as properties provider via `TelemetryService.instance.setProvider(this)` → [`ShoferProvider.ts:268`](src/core/webview/ShoferProvider.ts:268)
7. **User telemetry preference** sent from webview → `updateTelemetryState(isOptedIn)` called → [`webviewMessageHandler.ts:2462`](src/core/webview/webviewMessageHandler.ts:2462)

### Event Flow

```
Caller (e.g., Task.ts, Provider code)
  │
  ├── TelemetryService.instance.captureEvent(name, props)
  │     ├── PostHogTelemetryClient.capture()
  │     │     ├── isTelemetryEnabled()? → check VSCode telemetry level + user opt-in
  │     │     ├── isEventCapturable(event)? → check exclusion list
  │     │     ├── getEventProperties() → enrich with provider properties
  │     │     └── posthog.capture(distinctId, event, properties)
  └── TelemetryService.instance.captureException(error, props)
        └── PostHogTelemetryClient.captureException()
              ├── isTelemetryEnabled()?
              ├── shouldReportApiErrorToTelemetry()? → filter 402/429
              ├── Auto-extract properties from ApiProviderError or ConsecutiveMistakeError
              └── posthog.captureException(error, distinctId, properties)
```

---

## Event Catalog

### Task Lifecycle Events

| Event                       | Where Emitted               | Properties                                                                              |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `TASK_CREATED`              | Task constructor            | `taskId`                                                                                |
| `TASK_RESTARTED`            | Task resumption             | `taskId`                                                                                |
| `TASK_COMPLETED`            | Task completion             | `taskId`                                                                                |
| `TASK_CONVERSATION_MESSAGE` | Each user/assistant message | `taskId`, `source` (`"user"` \| `"assistant"`)                                          |
| `LLM_COMPLETION`            | After each API call         | `taskId`, `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `cost?` |

### Tool & Mode Events

| Event                          | Where Emitted            | Properties                   |
| ------------------------------ | ------------------------ | ---------------------------- |
| `MODE_SWITCH`                  | Mode change              | `taskId`, `newMode`          |
| `TOOL_USED`                    | Each tool execution      | `taskId`, `tool` (tool name) |
| `CUSTOM_MODE_CREATED`          | Mode editor save         | `modeSlug`, `modeName`       |
| `MODE_SETTINGS_CHANGED`        | Mode settings panel      | `settingName`                |
| `CODE_ACTION_USED`             | Code lens / context menu | `actionType`                 |
| `PROMPT_ENHANCED`              | Enhance prompt button    | `taskId?`                    |
| `READ_FILE_LEGACY_FORMAT_USED` | Native tool call parser  | Legacy format indicator      |

### Context & Performance Events

| Event                       | Where Emitted             | Properties                                                          |
| --------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `CONTEXT_CONDENSED`         | Context condensation      | `taskId`, `isAutomaticTrigger`, `usedCustomPrompt?`                 |
| `SLIDING_WINDOW_TRUNCATION` | Sliding window truncation | `taskId`                                                            |
| `BUDGET_EXCEEDED`           | Cost limit enforcement    | `taskId`, `rootTaskId`, `limitUsd`, `spentUsd`, `action`, `modelId` |
| `CODE_INDEX_SEGMENT_DEDUP`  | Code-index file watcher   | `{fileCount, totalBlocks, reused, embedded, deleted}`               |

### UI & Interaction Events

| Event                                   | Where Emitted           | Properties |
| --------------------------------------- | ----------------------- | ---------- |
| `TAB_SHOWN`                             | Settings tab change     | `tab`      |
| `MODE_SELECTOR_OPENED`                  | Mode dropdown open      | —          |
| `TITLE_BUTTON_CLICKED`                  | Title bar buttons       | `button`   |
| `FEATURED_PROVIDER_CLICKED`             | Provider welcome screen | —          |
| `AUTHENTICATION_INITIATED`              | Auth flow start         | —          |
| `UPSELL_DISMISSED`                      | Upsell banner dismiss   | `upsellId` |
| `UPSELL_CLICKED`                        | Upsell banner click     | `upsellId` |
| `ui_settings_collapse_thinking_changed` | Webview UI setting      | `enabled`  |
| `ui_settings_enter_behavior_changed`    | Webview UI setting      | `behavior` |

### Cloud & Marketplace Events

| Event                                | Where Emitted             | Properties                                                                              |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------- |
| `MARKETPLACE_ITEM_INSTALLED`         | Installation success      | `itemId`, `itemType`, `itemName`, `target`, `hasParameters?`, `installationMethodName?` |
| `MARKETPLACE_ITEM_REMOVED`           | Removal success           | `itemId`, `itemType`, `itemName`, `target`                                              |
| `MARKETPLACE_TAB_VIEWED`             | Tab switch to marketplace | —                                                                                       |
| `MARKETPLACE_INSTALL_BUTTON_CLICKED` | Install button click      | `itemId`, `itemType`, `itemName`                                                        |
| `SHARE_BUTTON_CLICKED`               | Share button              | —                                                                                       |
| `SHARE_ORGANIZATION_CLICKED`         | Share → org               | —                                                                                       |
| `SHARE_PUBLIC_CLICKED`               | Share → public            | —                                                                                       |
| `SHARE_CONNECT_TO_CLOUD_CLICKED`     | Share → connect prompt    | —                                                                                       |
| `ACCOUNT_CONNECT_CLICKED`            | Cloud sign-in button      | —                                                                                       |
| `ACCOUNT_CONNECT_SUCCESS`            | Auth success              | —                                                                                       |
| `ACCOUNT_LOGOUT_CLICKED`             | Sign-out button           | —                                                                                       |
| `ACCOUNT_LOGOUT_SUCCESS`             | Sign-out success          | —                                                                                       |

### Error Events

| Event                         | Where Emitted                  | Properties                                       |
| ----------------------------- | ------------------------------ | ------------------------------------------------ |
| `SCHEMA_VALIDATION_ERROR`     | Zod schema validation          | `schemaName`, `error` (formatted)                |
| `DIFF_APPLICATION_ERROR`      | apply_diff tool                | `taskId`, `consecutiveMistakeCount`              |
| `SHELL_INTEGRATION_ERROR`     | Shell integration              | `taskId`                                         |
| `CONSECUTIVE_MISTAKE_ERROR`   | Mistake limit reached          | `taskId`                                         |
| `CODE_INDEX_ERROR`            | Code indexing service          | `error` (message), plus service-specific context |
| `ASSISTANT_AGENT_ERROR`       | Assistant agent service        | `error` (message), service-specific context      |
| `MODEL_CACHE_EMPTY_RESPONSE`  | Model cache                    | —                                                |
| `error_boundary_caught_error` | React error boundary (webview) | `error` (message), `componentStack`              |

### MCP Async Call Events

| Event                      | Where Emitted                        | Properties                                                            |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `MCP_ASYNC_CALL_STARTED`   | `call_mcp_tool_async` dispatch       | `taskId`, `callId`, `serverName`, `toolName`                          |
| `MCP_ASYNC_CALL_COMPLETED` | Async MCP call finishes              | `taskId`, `callId`, `serverName`, `toolName`, `isError`, `durationMs` |
| `MCP_ASYNC_CALL_CANCELLED` | `cancel_tasks` during async MCP call | `taskId`, `callId`, `serverName`, `toolName`, `durationMs`            |
| `MCP_ASYNC_CALL_TIMED_OUT` | Async MCP call exceeds timeout       | `taskId`, `callId`, `serverName`, `toolName`, `timeoutSec`            |

### Peer Messaging Events (task-to-task)

Emitted when running tasks exchange messages directly (`send_message_to_task`,
async peer delivery, and peer discovery via `list_background_tasks`).

| Event                        | Where Emitted                                 | Properties                   |
| ---------------------------- | --------------------------------------------- | ---------------------------- |
| `TASK_PEER_MESSAGE_SENT`     | `SendMessageToTaskTool.ts` (peer send)        | `taskId`, message metadata   |
| `TASK_PEER_MESSAGE_RECEIVED` | `Task.ts` (async peer-message delivery)       | `taskId`, message metadata   |
| `TASK_PEER_DISCOVERY`        | `ListBackgroundTasksTool.ts` (peer discovery) | `taskId`, discovery metadata |

---

## Privacy & Data Filtering

### What is NEVER collected

- **Code or file contents** — never sent in any telemetry event
- **AI prompts or responses** — excluded from telemetry
- **Personally identifiable information** — not collected
- **Git repository URLs/names/branches** — filtered out by [`PostHogTelemetryClient.isPropertyCapturable()`](packages/telemetry/src/PostHogTelemetryClient.ts:55)

### What IS collected

| Data                | Source                 | Purpose                                |
| ------------------- | ---------------------- | -------------------------------------- |
| VS Code Machine ID  | `vscode.env.machineId` | Anonymous distinct user identification |
| App version         | `package.json`         | Feature adoption tracking              |
| VSCode version      | `vscode.version`       | Compatibility analysis                 |
| Platform            | `os.platform()`        | OS usage distribution                  |
| Language            | User setting           | Localization planning                  |
| Mode                | Current mode slug      | Mode usage patterns                    |
| Provider & Model ID | API configuration      | Provider/model popularity              |
| Tool names          | Tool execution         | Tool usage patterns                    |
| Token counts & cost | API responses          | Usage and cost analysis                |
| Error messages      | Exception capture      | Bug detection and fixing               |
| Task ID             | Task lifecycle         | Session correlation                    |

### Error Message Extraction

For better error grouping in PostHog, the system extracts the most descriptive error message:

1. First checks nested `error.metadata.raw` (upstream provider errors via OpenRouter)
2. Falls back to `error.error.message`
3. Falls back to `error.message`
4. Attempts to parse JSON-embedded messages (e.g., `503 {"error":{"message":"actual error"}}`)

### Expected Errors (Not Reported)

The following error types are **intentionally not reported** to telemetry to avoid noise:

| Error Type                         | Filter                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| HTTP 402 (Payment Required)        | [`EXPECTED_API_ERROR_CODES`](packages/types/src/telemetry.ts:290) |
| HTTP 429 (Rate Limit)              | [`EXPECTED_API_ERROR_CODES`](packages/types/src/telemetry.ts:290) |
| Messages starting with `429`       | Regex pattern `/^429\b/`                                          |
| Messages containing `"rate limit"` | Regex pattern `/rate limit/i`                                     |

---

## Opt-Out Mechanism

### Three-State Model

Telemetry uses a three-state setting:

```
unset ──► enabled  (user clicks "Accept" on telemetry banner)
unset ──► disabled (user explicitly opts out)
enabled ──► disabled (user changes setting)
disabled ──► enabled (user re-enables)
```

### User Controls

1. **Telemetry banner** — shown on first launch when `telemetrySetting === "unset"`. Accepting sets it to `"enabled"`. Dismissing keeps it `"unset"` (treated as disabled).
2. **Settings UI** — accessible through the extension settings panel.
3. **VSCode telemetry level** — respects the global `telemetry.telemetryLevel` setting. If set to anything other than `"all"`, extension telemetry is fully disabled regardless of the extension-specific setting.

### Implementation Detail

When telemetry is **turned OFF**, the `TELEMETRY_SETTINGS_CHANGED` event is fired **before** disabling — capturing the last event. When telemetry is **turned ON**, the event is fired **after** enabling — ensuring it's actually sent.

```typescript
// From webviewMessageHandler.ts:2462-2476
// If turning telemetry OFF, fire event BEFORE disabling
if (wasPreviouslyOptedIn && !isOptedIn) {
	TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, telemetrySetting)
}
await updateGlobalState("telemetrySetting", telemetrySetting)
TelemetryService.instance.updateTelemetryState(isOptedIn)
// If turning telemetry ON, fire event AFTER enabling
if (!wasPreviouslyOptedIn && isOptedIn) {
	TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, telemetrySetting)
}
```

---

## Integration Points

### Extension Host (`src/`)

| File                                                                                                         | Integration                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [`extension.ts`](src/extension.ts)                                                                           | Initializes `TelemetryService` and registers `PostHogTelemetryClient`                                                             |
| [`core/webview/ShoferProvider.ts`](src/core/webview/ShoferProvider.ts)                                       | Implements `TelemetryPropertiesProvider.getTelemetryProperties()`; registers as provider; CSP allows `*.posthog.com`              |
| [`core/webview/webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts)                         | Handles `telemetrySetting` message from webview; calls `updateTelemetryState`                                                     |
| [`core/task/Task.ts`](src/core/task/Task.ts)                                                                 | Emits task lifecycle events, tool usage, LLM completions, budget exceeded, consecutive mistakes, tool result ID validation errors |
| [`core/condense/index.ts`](src/core/condense/index.ts)                                                       | Emits `CONTEXT_CONDENSED` with automatic trigger and custom prompt flags                                                          |
| [`core/context-management/index.ts`](src/core/context-management/index.ts)                                   | Emits `SLIDING_WINDOW_TRUNCATION`                                                                                                 |
| [`core/checkpoints/index.ts`](src/core/checkpoints/index.ts)                                                 | Emits `CHECKPOINT_CREATED`, `CHECKPOINT_DIFFED`, `CHECKPOINT_RESTORED`                                                            |
| [`core/config/importExport.ts`](src/core/config/importExport.ts)                                             | Emits telemetry for settings export/import                                                                                        |
| [`core/config/ProviderSettingsManager.ts`](src/core/config/ProviderSettingsManager.ts)                       | Tracks provider settings changes                                                                                                  |
| [`core/webview/messageEnhancer.ts`](src/core/webview/messageEnhancer.ts)                                     | Emits `PROMPT_ENHANCED`                                                                                                           |
| [`core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts) | Emits `CONSECUTIVE_MISTAKE_ERROR` for tool repetition                                                                             |
| [`core/assistant-message/NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)       | Emits `READ_FILE_LEGACY_FORMAT_USED` for legacy read_file format                                                                  |
| [`core/tools/AttemptCompletionTool.ts`](src/core/tools/AttemptCompletionTool.ts)                             | Emits `TASK_COMPLETED`                                                                                                            |
| [`core/tools/ApplyDiffTool.ts`](src/core/tools/ApplyDiffTool.ts)                                             | Emits `DIFF_APPLICATION_ERROR`                                                                                                    |
| [`core/tools/ExecuteCommandTool.ts`](src/core/tools/ExecuteCommandTool.ts)                                   | Emits `SHELL_INTEGRATION_ERROR`                                                                                                   |

### Code Indexing Service

The entire code indexing subsystem (`services/code-index/`) uses telemetry for error tracking via `CODE_INDEX_ERROR`:

| File                                                                                                                       | Context                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`services/code-index/orchestrator.ts`](src/services/code-index/orchestrator.ts)                                           | Index startup errors, cleanup errors       |
| [`services/code-index/cache-manager.ts`](src/services/code-index/cache-manager.ts)                                         | Cache read/write/clear errors              |
| [`services/code-index/manager.ts`](src/services/code-index/manager.ts)                                                     | `.gitignore` loading, service recreation   |
| [`services/code-index/search-service.ts`](src/services/code-index/search-service.ts)                                       | Search errors                              |
| [`services/code-index/service-factory.ts`](src/services/code-index/service-factory.ts)                                     | Service creation errors                    |
| [`services/code-index/processors/scanner.ts`](src/services/code-index/processors/scanner.ts)                               | File scanning errors                       |
| [`services/code-index/processors/file-watcher.ts`](src/services/code-index/processors/file-watcher.ts)                     | File deletion, batch upsert errors         |
| [`services/code-index/processors/parser.ts`](src/services/code-index/processors/parser.ts)                                 | Parser loading and file reading errors     |
| All embedders (`bedrock`, `gemini`, `mistral`, `ollama`, `openai`, `openai-compatible`, `openrouter`, `vercel-ai-gateway`) | Embedding generation and validation errors |

### AI Providers

Provider implementations capture errors via `TelemetryService.instance.captureException()`:

| Provider                    | Error Capture Points                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `anthropic.ts`              | API errors with `ApiProviderError` wrapping                             |
| `bedrock.ts`                | `createMessage` and `completePrompt` errors                             |
| `gemini.ts`                 | `createMessage` and `completePrompt` errors                             |
| `mistral.ts`                | API errors                                                              |
| `openai-codex.ts`           | API errors                                                              |
| `openai-native.ts`          | `createMessage`, stream processing, and `completePrompt` errors         |
| `openrouter.ts`             | Stream error responses, SDK exceptions (with upstream error extraction) |
| `poe.ts`                    | API errors                                                              |
| `xai.ts`                    | API errors                                                              |
| `fetchers/modelCache.ts`    | `MODEL_CACHE_EMPTY_RESPONSE` for empty API responses                    |
| `fetchers/error-handler.ts` | Consistent error formatting for telemetry                               |

### Webview UI

| File                                                                                                  | Integration                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`App.tsx`](webview-ui/src/App.tsx)                                                                   | Initializes `telemetryClient` on state hydration |
| [`ModeSelector.tsx`](webview-ui/src/components/chat/ModeSelector.tsx)                                 | `MODE_SELECTOR_OPENED`                           |
| [`useCloudUpsell.ts`](webview-ui/src/hooks/useCloudUpsell.ts)                                         | `ACCOUNT_CONNECT_SUCCESS`                        |
| [`DismissibleUpsell.tsx`](webview-ui/src/components/common/DismissibleUpsell.tsx)                     | Upsell interaction events                        |
| [`MarketplaceItemCard.tsx`](webview-ui/src/components/marketplace/components/MarketplaceItemCard.tsx) | Marketplace install events                       |
| [`UISettings.tsx`](webview-ui/src/components/settings/UISettings.tsx)                                 | UI preference changes                            |
| [`ErrorBoundary.tsx`](webview-ui/src/components/ErrorBoundary.tsx)                                    | React error boundary catches                     |

---

## Testing

### Backend (Extension Host)

Tests for the telemetry package are in:

- [`packages/telemetry/src/__tests__/PostHogTelemetryClient.test.ts`](packages/telemetry/src/__tests__/PostHogTelemetryClient.test.ts) — covers event capture, exception filtering, property merging, git property filtering, telemetry state management, and error filtering (402/429)
- [`packages/types/src/__tests__/telemetry.test.ts`](packages/types/src/__tests__/telemetry.test.ts) — covers all error utility functions, `ApiProviderError`, `ConsecutiveMistakeError`

Throughout the extension host test suite, `@shofer/telemetry` is mocked with a consistent pattern:

```typescript
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureEvent: vi.fn(),
			captureException: vi.fn(),
			// ... other methods as needed
		},
		hasInstance: () => true,
	},
	PostHogTelemetryClient: vi.fn(),
}))
```

### Webview

Tests for the webview telemetry client:

- [`webview-ui/src/utils/__tests__/TelemetryClient.spec.ts`](webview-ui/src/utils/__tests__/TelemetryClient.spec.ts) — covers state management, PostHog init, event capture

### Running Tests

```bash
# Test the telemetry package
pnpm --filter @shofer/telemetry test

# Test telemetry types
pnpm --filter @shofer/types test -- src/__tests__/telemetry.test.ts

# Test webview telemetry
pnpm --filter webview-ui test -- src/utils/__tests__/TelemetryClient.spec.ts
```

---

## Gaps & Areas for Improvement

This section identifies known gaps, drift risks, and areas where the telemetry system or its documentation could be improved. These were discovered during a doc-to-code verification pass.

### Documentation Drift Risks

- **Line numbers are fragile.** The telemetry source files shift frequently as methods are added or refactored. All line numbers in this document are valid only at the time of the last audit (see `verify-telemetry-doc` task). Every convenience method added, removed, or reordered in [`TelemetryService.ts`](packages/telemetry/src/TelemetryService.ts) will drift line references in the Key Methods and Convenience Methods tables. Consider documenting method contract (signature + behavior) without tying it to a specific line number, or adding a CI step that validates line-number anchors.

- **`ShoferProvider.ts` line numbers are unstable.** The provider's `getTelemetryProperties()` and `setProvider` call site have moved between versions. The anchor is currently [`ShoferProvider.ts:268`](src/core/webview/ShoferProvider.ts).

- **`webviewMessageHandler.ts` opt-out/opt-in block moves.** The `telemetrySetting` handler (`captureTelemetrySettingsChanged` before vs. after `updateTelemetryState`) is sensitive to reordering. The current location is around line 2462.

### Missing Codebase Components

- **`packages/cloud/` does not exist.** The Cloud Telemetry Client section was removed from this document because `packages/cloud/src/TelemetryClient.ts` and `packages/cloud/src/retry-queue/` are not present in this version of the codebase. If cloud-side telemetry is planned, a new package must be created and this document updated.

- **`webview-ui/src/components/cloud/CloudView.tsx` does not exist.** The `cloud/` components directory under the webview is empty.

- **Eight enum events are defined but never emitted (dead entries).** A codebase-wide grep for emission sites (both `captureEvent(TelemetryEventName.X)` and the `capture*()` convenience methods) finds **no emitter anywhere** for: `ACCOUNT_CONNECT_CLICKED`, `ACCOUNT_CONNECT_SUCCESS`, `ACCOUNT_LOGOUT_CLICKED`, `ACCOUNT_LOGOUT_SUCCESS`, `AUTHENTICATION_INITIATED`, `FEATURED_PROVIDER_CLICKED`, `UPSELL_DISMISSED`, and `UPSELL_CLICKED`. Note the tables above (Webview UI Events / Cloud & Marketplace Events) cite source files for `ACCOUNT_CONNECT_SUCCESS`, `UPSELL_DISMISSED`, and `UPSELL_CLICKED` (e.g. `useCloudUpsell.ts:28`, `DismissibleUpsell.tsx`) — **those citations are aspirational; the events do not actually fire from those files.** Either wire up emission or remove the dead enum entries (and correct/annotate those table rows).

### Missing from Documentation

- **`captureException(error)` mutates `error.message`.** In [`PostHogTelemetryClient.captureException()`](packages/telemetry/src/PostHogTelemetryClient.ts:85), line 128 overwrites `error.message` with the most-descriptive error message extracted by `getErrorMessage()`. This is a side-effect callers should be aware of if they retain a reference to the error after calling `captureException`.

- **`TELEMETRY_ENABLED` env var gating.** All telemetry is gated behind `TELEMETRY_ENABLED=true`. Without it, `TelemetryService` never initializes, `PostHog` clients are never instantiated, and all `capture*` calls are no-ops. This is the primary kill-switch and should be documented prominently.

- **`TelemetryService` constructor is public, not fully private.** The singleton pattern is enforced by `createInstance()` (which throws if `_instance` already exists), but the constructor itself is `public`. A direct `new TelemetryService(...)` call would bypass the singleton guard.

### Structural Observations

- **No `captureException` for non-PostHog clients.** `TelemetryService` delegates `captureException` to all registered clients, but only `PostHogTelemetryClient` implements meaningful exception capture. If a second client is registered, it must also implement `captureException`.

- **The `shoferTelemetryEventSchema` union does NOT enforce enum parity (correctness gap).** A previous version of this doc claimed the `shoferTelemetryEventSchema` discriminated union ([`telemetry.ts:178`](packages/types/src/telemetry.ts:178)) "exhaustively lists members" so that adding an enum value without updating the schema "will cause type errors at compile time." **This is false.** `captureEvent(eventName: TelemetryEventName, properties?: Record<string, any>)` ([`TelemetryService.ts:75`](packages/telemetry/src/TelemetryService.ts:75)) takes a raw enum value plus an untyped property bag and **never validates against the union**, so there is no compile-time safety net. In fact three emitted events — `ASSISTANT_AGENT_ERROR` (enum line 74), `BUDGET_EXCEEDED` (line 78), and `CODE_INDEX_SEGMENT_DEDUP` (line 79) — are **absent from the union** and emit unvalidated today. If schema parity is desired it must be enforced explicitly (e.g. validate in `captureEvent`, or a test asserting every `TelemetryEventName` appears in the union).

### Coverage Gaps (features without telemetry)

These flagship features currently emit **no** telemetry, leaving notable
product/operational blind spots. Listed for awareness; wiring them is tracked
separately.

| Feature                         | Source (no emitter)                   | Proposed signal                                                        |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| Subtask / orchestrator spawning | `core/tools/NewTaskTool.ts`           | `SUBTASK_SPAWNED { parentTaskId, mode, isBackground }`                 |
| Task cancellation / abort       | `core/tools/CancelTasksTool.ts`       | `TASK_CANCELLED { taskId, reason }`                                    |
| User tool rejection             | per-tool `!didApprove` in `Task.ts`   | `TOOL_REJECTED { tool }`                                               |
| RAG / `codebase_search` usage   | `core/tools/RagSearchTool.ts`         | `RAG_SEARCH_PERFORMED { resultCount, latencyMs }`                      |
| Skill load                      | `core/tools/SkillsTool.ts`            | `SKILL_LOADED { skillName }`                                           |
| Image generation                | `core/tools/GenerateImageTool.ts`     | `IMAGE_GENERATED { model, success }`                                   |
| assistantAgent success/usage    | `services/assistant-agent/manager.ts` | `ASSISTANT_AGENT_INVOKED { success, turnCount }` (error already emits) |

Additionally, **only 9 of ~36 provider implementations call `captureException`**
(the AI Providers table above lists them). The remaining providers — including
`deepseek`, `openai`, `openai-compatible`, `vertex`, `anthropic-vertex`,
`vscode-lm`, `native-ollama`, `requesty`, `unbound`, `lite-llm`,
`vercel-ai-gateway`, `baseten`, `sambanova`, `moonshot`, `minimax`, `zai`,
`qwen-code`, `lm-studio`, `fireworks`, `shofer` — swallow API errors with no
telemetry. Provider error coverage is partial, not complete.
