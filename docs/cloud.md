# Shofer Cloud Architecture & Features

This document provides a comprehensive overview of all cloud-related features in the Shofer extension, covering the cloud service architecture, authentication, settings synchronization, telemetry, task sharing, bridge connectivity, the Shofer Router provider, cloud profile management, image generation, MDM enforcement, and the web UI components.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Cloud Service (`CloudService`)](#cloud-service-cloudservice)
3. [Authentication](#authentication)
    - [WebAuthService (User-Facing)](#webauthservice-user-facing)
    - [StaticTokenAuthService (Cloud Agent)](#statictokenauthservice-cloud-agent)
    - [Auth States](#auth-states)
4. [Settings Service](#settings-service)
    - [CloudSettingsService](#cloudsettingsservice)
    - [StaticSettingsService](#staticsettingsservice)
    - [Organization Settings](#organization-settings)
    - [User Settings](#user-settings)
5. [Telemetry](#telemetry)
    - [CloudTelemetryClient](#cloudtelemetryclient)
    - [Retry Queue](#retry-queue)
    - [Message Backfill](#message-backfill)
6. [Task Sharing](#task-sharing)
    - [CloudShareService](#cloudshareservice)
    - [Sharing Visibility](#sharing-visibility)
7. [Task Sync (Cloud Message Recording)](#task-sync-cloud-message-recording)
8. [Cloud API (`CloudAPI`)](#cloud-api-cloudapi)
    - [Endpoints](#endpoints)
    - [Credit Balance](#credit-balance)
9. [Shofer Router Provider](#shofer-router-provider)
    - [RooHandler](#roohandler)
    - [Model Loading](#model-loading)
    - [Image Generation via Cloud](#image-generation-via-cloud)
10. [Cloud Profile Sync](#cloud-profile-sync)
11. [Bridge Connectivity](#bridge-connectivity)
    - [Socket Bridge](#socket-bridge)
    - [Task Bridge Events & Commands](#task-bridge-events--commands)
12. [MDM (Mobile Device Management) Enforcement](#mdm-mobile-device-management-enforcement)
13. [Web UI Components](#web-ui-components)
    - [CloudView](#cloudview)
    - [CloudAccountSwitcher](#cloudaccountswitcher)
    - [CloudUpsellDialog](#cloudupselldialog)
    - [OrganizationSwitcher](#organizationswitcher)
    - [ShoferBalanceDisplay](#shoferbalancedisplay)
14. [Marketplace Integration](#marketplace-integration)
15. [Web App Pages (shofer.dev)](#web-app-pages-shofercom)
16. [Configuration & Environment Variables](#configuration--environment-variables)
17. [Error Handling](#error-handling)

---

## Architecture Overview

The cloud layer lives primarily in three locations:

| Location                                                               | Purpose                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`packages/cloud/src/`](packages/cloud/src/)                           | Core cloud service library — auth, settings, API, telemetry, retry queue |
| [`src/api/providers/shofer.ts`](src/api/providers/shofer.ts)           | Shofer Router provider (AI model proxy)                                  |
| [`webview-ui/src/components/cloud/`](webview-ui/src/components/cloud/) | React UI components for the Cloud tab                                    |

The [`CloudService`](packages/cloud/src/CloudService.ts) is the central orchestrator, instantiated as a singleton during extension activation in [`src/extension.ts`](src/extension.ts). It composes all cloud subsystems and emits typed events for auth state changes, user info updates, and settings changes.

```
┌─────────────────────────────────────────────────────┐
│                   CloudService                       │
│  (singleton, EventEmitter<CloudServiceEvents>)       │
├─────────────────────────────────────────────────────┤
│  authService       → WebAuthService | StaticToken   │
│  settingsService   → CloudSettingsService | Static  │
│  telemetryClient   → CloudTelemetryClient           │
│  shareService      → CloudShareService              │
│  cloudAPI          → CloudAPI                       │
│  retryQueue        → RetryQueue                     │
└─────────────────────────────────────────────────────┘
```

---

## Cloud Service (`CloudService`)

**File:** [`packages/cloud/src/CloudService.ts`](packages/cloud/src/CloudService.ts)

The [`CloudService`](packages/cloud/src/CloudService.ts:34) is the central facade. It:

- Is a singleton (`CloudService.instance` / `CloudService.createInstance()`)
- Implements `Disposable` for proper cleanup
- Determines auth mode via the `SHOFER_CLOUD_TOKEN` environment variable:
    - If set → [`StaticTokenAuthService`](packages/cloud/src/StaticTokenAuthService.ts) (cloud agent mode)
    - Otherwise → [`WebAuthService`](packages/cloud/src/WebAuthService.ts) (normal user mode)
- Determines settings mode via the `SHOFER_CLOUD_ORG_SETTINGS` environment variable:
    - If set → [`StaticSettingsService`](packages/cloud/src/StaticSettingsService.ts) (base64-encoded JSON)
    - Otherwise → [`CloudSettingsService`](packages/cloud/src/CloudSettingsService.ts) (API-fetched)
- Initializes all sub-services in order: auth → settings → cloudAPI → retryQueue → telemetry → share
- Delegates auth state changes to the retry queue lifecycle (pause/resume/clear)

Key public methods:

- `login()`, `logout()`, `handleAuthCallback()` — authentication flow
- `getUserInfo()`, `getOrganizationId()`, `getOrganizationMemberships()` — user/org data
- `getAllowList()`, `getOrganizationSettings()`, `getUserSettings()` — settings
- `captureEvent()` — telemetry
- `shareTask()` — task sharing
- `switchOrganization()` — organization context switching
- `updateUserSettings()` — user settings persistence
- `isTaskSyncEnabled()` — task sync check

---

## Authentication

### WebAuthService (User-Facing)

**File:** [`packages/cloud/src/WebAuthService.ts`](packages/cloud/src/WebAuthService.ts)

The [`WebAuthService`](packages/cloud/src/WebAuthService.ts:89) handles Clerk-based OAuth authentication for VS Code extension users.

**Flow:**

1. `login()` generates a CSRF state token, stores it in `globalState`, and opens the browser to `{SHOFER_API_URL}/extension/sign-in` (or `/extension/provider-sign-up` for the provider signup flow). Landing page slugs can route to `/l/{slug}`.
2. The browser redirects back to the extension via a `vscode://` URI.
3. `handleCallback()` validates the CSRF state, calls Clerk's `/v1/client/sign_ins` with the ticket, extracts the client token and session ID, and stores credentials in VS Code's `secrets` storage.
4. A [`RefreshTimer`](packages/cloud/src/RefreshTimer.ts) (50s interval, exponential backoff up to 5 min) periodically calls `refreshSession()`, which exchanges the client token for a JWT session token via Clerk's `/v1/client/sessions/{id}/tokens`.
5. After the first successful refresh, `fetchUserInfo()` calls Clerk's `/v1/me` and `/v1/me/organization_memberships` to populate [`CloudUserInfo`](packages/types/src/cloud.ts:35) including organization context.

**Credential Storage:**

- Credentials (`clientToken`, `sessionId`, `organizationId`) stored in VS Code `secrets` under key `clerk-auth-credentials` (or namespaced by Clerk base URL for non-production environments).
- Session token held in memory only (never persisted).

**Organization Context:**

- Users can belong to multiple organizations.
- `switchOrganization()` updates stored credentials with a new `organizationId` (null = personal account).
- `getOrganizationMemberships()` returns all orgs the user belongs to.

### StaticTokenAuthService (Cloud Agent)

**File:** [`packages/cloud/src/StaticTokenAuthService.ts`](packages/cloud/src/StaticTokenAuthService.ts)

Used when `SHOFER_CLOUD_TOKEN` is set (cloud agent / headless environments). The JWT is decoded to extract `userId` and `organizationId`. All interactive auth methods throw errors — this service is read-only and always reports `active-session`.

### Auth States

**Defined in:** [`packages/types/src/cloud.ts:237`](packages/types/src/cloud.ts:237)

```
"initializing" → "logged-out" | "attempting-session"
"attempting-session" → "active-session" | "inactive-session"
"active-session" → "inactive-session" | "logged-out"
"inactive-session" → "active-session" | "logged-out"
```

The [`CloudService`](packages/cloud/src/CloudService.ts) wires auth state transitions to retry queue behavior:

- `active-session` → resume queue (clear if user changed)
- `logged-out` → clear and pause queue
- `initializing` / `attempting-session` / `inactive-session` → pause queue

---

## Settings Service

### CloudSettingsService

**File:** [`packages/cloud/src/CloudSettingsService.ts`](packages/cloud/src/CloudSettingsService.ts)

Fetches organization and user settings from `{SHOFER_API_URL}/api/extension-settings` using the session token. Features:

- **Polling:** Uses [`RefreshTimer`](packages/cloud/src/RefreshTimer.ts) with a **1-hour success interval** (3,600,000ms) and exponential backoff (1s → 1h max).
- **Caching:** Settings are cached in VS Code `globalState` under `organization-settings` and `user-settings` keys.
- **Version-based change detection:** Each settings blob has a `version` number; changes are detected by comparing versions.
- **Event emission:** Emits `settings-updated` when org or user settings change.
- **Auth-state aware:** Starts polling on `active-session`, stops on logout, clears cache on logout.
- **Optimistic locking for user settings:** `updateUserSettings()` sends the current version with PATCH requests; HTTP 409 indicates a conflict.

### StaticSettingsService

**File:** [`packages/cloud/src/StaticSettingsService.ts`](packages/cloud/src/StaticSettingsService.ts)

Used when `SHOFER_CLOUD_ORG_SETTINGS` is set. Parses a base64-encoded JSON string into [`OrganizationSettings`](packages/types/src/cloud.ts:165). Always enables task sync.

### Organization Settings

**Defined in:** [`packages/types/src/cloud.ts:153-165`](packages/types/src/cloud.ts:153)

The [`organizationSettingsSchema`](packages/types/src/cloud.ts:153) includes:

| Field                 | Type                                     | Description                               |
| --------------------- | ---------------------------------------- | ----------------------------------------- |
| `version`             | `number`                                 | Monotonic version for change detection    |
| `cloudSettings`       | `OrganizationCloudSettings`              | Cloud feature flags                       |
| `defaultSettings`     | `OrganizationDefaultSettings`            | Enforced default settings for org members |
| `allowList`           | `OrganizationAllowList`                  | Provider/model allow/deny lists           |
| `features`            | `OrganizationFeatures`                   | Organization feature flags                |
| `hiddenMcps`          | `string[]`                               | MCP servers hidden from members           |
| `hideMarketplaceMcps` | `boolean`                                | Hide marketplace MCPs                     |
| `mcps`                | `MCPMarketplaceItem[]`                   | Organization-provided MCP servers         |
| `providerProfiles`    | `Record<string, ProviderSettingsWithId>` | Cloud-managed provider profiles           |

**Cloud Settings (`OrganizationCloudSettings`):**

| Field                        | Type                      | Description                                 |
| ---------------------------- | ------------------------- | ------------------------------------------- |
| `recordTaskMessages`         | `boolean?`                | Org-level task sync toggle (overrides user) |
| `enableTaskSharing`          | `boolean?`                | Enable task sharing feature                 |
| `allowPublicTaskSharing`     | `boolean?`                | Allow public (link-accessible) sharing      |
| `taskShareExpirationDays`    | `number?`                 | Days before shared task links expire        |
| `allowMembersViewAllTasks`   | `boolean?`                | Members can see all org tasks               |
| `workspaceTaskVisibility`    | `WorkspaceTaskVisibility` | Task visibility policy                      |
| `llmEnhancedFeaturesEnabled` | `boolean?`                | LLM enhancement features                    |

**Allow List (`OrganizationAllowList`):**

```typescript
{
	allowAll: boolean
	providers: Record<string, { allowAll: boolean; models?: string[] }>
}
```

Used in the provider selection UI to restrict which providers and models organization members can use.

### User Settings

**Defined in:** [`packages/types/src/cloud.ts:175-188`](packages/types/src/cloud.ts:175)

| Field                        | Type       | Description                                    |
| ---------------------------- | ---------- | ---------------------------------------------- |
| `taskSyncEnabled`            | `boolean?` | User-level task sync (default `true` if unset) |
| `llmEnhancedFeaturesEnabled` | `boolean?` | LLM enhancement features (user-level)          |

Settings precedence: **Organization settings override user settings** for `recordTaskMessages`/`taskSyncEnabled`. User settings default to `true` when unspecified.

---

## Telemetry

### CloudTelemetryClient

**File:** [`packages/cloud/src/TelemetryClient.ts`](packages/cloud/src/TelemetryClient.ts)

The [`CloudTelemetryClient`](packages/cloud/src/TelemetryClient.ts:87) extends [`BaseTelemetryClient`](packages/cloud/src/TelemetryClient.ts:16) and sends telemetry events to `{SHOFER_API_URL}/api/events`.

**Key behaviors:**

- **Event subscription:** Excludes `TASK_CONVERSATION_MESSAGE` by default (only sends aggregate `TASK_MESSAGE` events).
- **Task message gating:** Only sends `TASK_MESSAGE` events when `isTaskSyncEnabled()` returns true.
- **Authentication check:** Events are only sent when the user is authenticated with a valid session token.
- **Retry on failure:** Server errors (5xx) and rate limits (429) are automatically queued to the [`RetryQueue`](packages/cloud/src/retry-queue/RetryQueue.ts).
- **Can be disabled** via `SHOFER_DISABLE_TELEMETRY=1` environment variable.

### Retry Queue

**File:** [`packages/cloud/src/retry-queue/RetryQueue.ts`](packages/cloud/src/retry-queue/RetryQueue.ts)

The [`RetryQueue`](packages/cloud/src/retry-queue/RetryQueue.ts:7) provides resilient delivery for telemetry events:

- **Persistence:** Queue is persisted to VS Code `workspaceState` and restored on initialization.
- **Configurable:** `maxRetries` (default 0 = unlimited), `retryDelay` (60s), `maxQueueSize` (100), `requestTimeout` (30s).
- **Rate limit handling:** Respects `Retry-After` headers (seconds or HTTP-date), pauses entire queue.
- **Auth-aware:** Pauses on logout, resumes on re-authentication, clears on user change.
- **FIFO processing:** Requests processed in order of enqueue timestamp.
- **Auth header refresh:** Fetches fresh auth tokens before each retry attempt.
- **Client errors not retried:** 4xx errors (except 429) are removed immediately.

### Message Backfill

The [`CloudTelemetryClient.backfillMessages()`](packages/cloud/src/TelemetryClient.ts:196) method uploads full conversation history as a JSON file to `{SHOFER_API_URL}/api/events/backfill`. This is used when sharing a task that hasn't had its messages synced yet.

---

## Task Sharing

### CloudShareService

**File:** [`packages/cloud/src/CloudShareService.ts`](packages/cloud/src/CloudShareService.ts)

Enables sharing task conversations via the Shofer Cloud web app:

1. `shareTask(taskId, visibility)` calls [`CloudAPI.shareTask()`](packages/cloud/src/CloudAPI.ts:111) (POST `/api/extension/share`).
2. On success, the returned `shareUrl` is automatically copied to the clipboard.
3. If the task wasn't synced (throws `TaskNotFoundError`), messages are backfilled via [`TelemetryClient.backfillMessages()`](packages/cloud/src/TelemetryClient.ts:196) and the share is retried.

**Permissions are controlled by org settings:**

- `canShareTask()` → requires `cloudSettings.enableTaskSharing`
- `canSharePublicly()` → requires both `enableTaskSharing` AND `allowPublicTaskSharing !== false`

### Sharing Visibility

**Defined in:** [`packages/types/src/cloud.ts:217`](packages/types/src/cloud.ts:217)

```typescript
type ShareVisibility = "organization" | "public"
```

- `"organization"`: Only members of the same org can view.
- `"public"`: Anyone with the link can view.

---

## Task Sync (Cloud Message Recording)

Task sync is the mechanism that records conversation messages to the Shofer Cloud for later viewing, sharing, and history. It is implemented in [`Task.ts`](src/core/task/Task.ts).

**How it works:**

1. Each non-partial assistant message added to the conversation triggers a check: [`CloudService.isEnabled()`](packages/cloud/src/CloudService.ts:424).
2. If enabled, [`CloudService.instance.captureEvent()`](packages/cloud/src/CloudService.ts:308) is called with a `TASK_MESSAGE` telemetry event containing the message and task metadata.
3. A [`cloudSyncedMessageTimestamps`](src/core/task/Task.ts:547) Set prevents duplicate syncing.
4. On task resume, the Set is repopulated from existing messages to avoid re-syncing.

**Toggles:**

- **Organization level:** `cloudSettings.recordTaskMessages` (org setting)
- **User level:** `taskSyncEnabled` (user setting, defaults to true)
- Org setting takes precedence over user setting.

---

## Cloud API (`CloudAPI`)

**File:** [`packages/cloud/src/CloudAPI.ts`](packages/cloud/src/CloudAPI.ts)

The [`CloudAPI`](packages/cloud/src/CloudAPI.ts:14) class is a typed HTTP client for Shofer Cloud backend APIs. All requests require a Bearer token session.

### Endpoints

| Method  | Endpoint                        | Purpose                                                             |
| ------- | ------------------------------- | ------------------------------------------------------------------- |
| `POST`  | `/api/extension/share`          | Share a task, returns `ShareResponse`                               |
| `GET`   | `/api/extension/bridge/config`  | Get socket bridge configuration                                     |
| `GET`   | `/api/extension/credit-balance` | Get user's credit balance                                           |
| `GET`   | `/api/extension-settings`       | Fetch organization + user settings (used by `CloudSettingsService`) |
| `PATCH` | `/api/user-settings`            | Update user settings with optimistic locking                        |
| `POST`  | `/api/events`                   | Submit telemetry events                                             |
| `POST`  | `/api/events/backfill`          | Backfill task messages                                              |

### Credit Balance

The `creditBalance()` method (GET `/api/extension/credit-balance`) returns a number representing the user's credit balance in dollars. This is displayed in the [`ShoferBalanceDisplay`](webview-ui/src/components/settings/providers/ShoferBalanceDisplay.tsx) component next to the Shofer Router provider selector.

---

## Shofer Router Provider

**File:** [`src/api/providers/shofer.ts`](src/api/providers/shofer.ts)

The [`RooHandler`](src/api/providers/shofer.ts:40) is the AI model provider that routes requests through Shofer Cloud's proxy API at `https://api.shofer.dev/proxy/v1`. It extends [`BaseOpenAiCompatibleProvider`](src/api/providers/base-openai-compatible-provider.ts).

### Key Features

- **Automatic authentication:** Uses the Cloud session token as the API key via [`getSessionToken()`](src/api/providers/shofer.ts:35).
- **Dynamic model loading:** Fetches available models from the proxy on initialization.
- **Reasoning support:** Handles `reasoning_details` array format (used by Gemini 3, Claude, OpenAI o-series) and `reasoning_content` (used by DeepSeek, MiMo), preserving them across multi-turn conversations.
- **Usage tracking:** Reports token usage (input, output, cache reads/writes), normalizing for protocol differences (OpenAI expects total input tokens; Anthropic expects non-cached).
- **Free model detection:** Zero-cost display for free models.
- **App version header:** Sends `X-Shofer-App-Version` with every request.
- **Task ID header:** Sends `X-Shofer-Task-ID` for session tracking.

### Model Loading

Models are loaded dynamically from the Shofer proxy API and cached via the shared [`modelCache`](src/api/providers/fetchers/modelCache.ts). The model cache is refreshed when auth state changes (e.g., login/logout), ensuring authenticated model lists are always available.

### Image Generation via Cloud

The [`RooHandler.generateImage()`](src/api/providers/shofer.ts:416) method supports two API methods:

- **Chat completions** (default): Uses the standard chat API with image-capable models.
- **Images API**: Uses a dedicated `/v1/images/generations` endpoint when `apiMethod === "images_api"`.

Image generation is integrated in the [`GenerateImageTool`](src/core/tools/GenerateImageTool.ts) which supports both OpenRouter and Shofer Cloud as providers.

---

## Cloud Profile Sync

**File:** [`src/core/config/ProviderSettingsManager.ts:699`](src/core/config/ProviderSettingsManager.ts)

When organization settings include `providerProfiles`, the extension syncs them to the local provider profiles:

1. Profiles are identified by unique IDs (`cloudProfileIds`).
2. **Add:** New cloud profiles are added (secret keys stripped).
3. **Update:** Existing profiles are merged — cloud-provided fields overwrite local, but secret keys (API keys) are preserved.
4. **Delete:** Profiles with IDs in the old `cloudProfileIds` but missing from new cloud profiles are removed.
5. **Name conflicts:** If a cloud profile name conflicts with a local non-cloud profile, the local profile is renamed.
6. **Active profile handling:** If the active profile is deleted or modified, the UI updates accordingly.

This allows organizations to centrally manage API provider configurations and push them to all members.

---

## Bridge Connectivity

### Socket Bridge

The [`CloudAPI.bridgeConfig()`](packages/cloud/src/CloudAPI.ts:124) method retrieves WebSocket connection details from `GET /api/extension/bridge/config`:

```typescript
{
	userId: string
	socketBridgeUrl: string
	token: string
}
```

This enables real-time connectivity between the VS Code extension and the Shofer Cloud platform, supporting features like:

- Remote task control from the web app
- Real-time message streaming
- Cloud agent orchestration

### Task Bridge Events & Commands

**Defined in:** [`packages/types/src/cloud.ts:427-533`](packages/types/src/cloud.ts:427)

The bridge supports bidirectional communication:

**Events (Extension → Cloud):**

- `Message` — Conversation messages
- `TaskModeSwitched` — Mode change notifications
- `TaskInteractive` — Task waiting for user input

**Commands (Cloud → Extension):**

- `Message` — Send text/images to a running task
- `ApproveAsk` — Approve a pending ask (with optional text/images)
- `DenyAsk` — Deny a pending ask (with optional text/images)

The extension registers itself via `ExtensionSocketEvents.REGISTER` and sends periodic heartbeats (`HEARTBEAT_INTERVAL_MS = 20,000`). Instances have a TTL of `INSTANCE_TTL_SECONDS = 60`.

---

## MDM (Mobile Device Management) Enforcement

**File:** [`src/services/mdm/MdmService.ts`](src/services/mdm/MdmService.ts)

The [`MdmService`](src/services/mdm/MdmService.ts:20) enables enterprise IT administrators to enforce cloud authentication policies:

**Configuration file** (JSON):

```json
{
	"requireCloudAuth": true,
	"organizationId": "org_xxx" // optional
}
```

**Platform-specific paths:**

- **Windows:** `%ProgramData%\Shofer\mdm.json` (or `mdm.dev.json` for non-production)
- **macOS:** `/Library/Application Support/Shofer/mdm.json`
- **Linux:** `/etc/shofer-code/mdm.json`

**Enforcement:**

- When `requireCloudAuth` is true, the user MUST be authenticated to Shofer Cloud.
- If `organizationId` is set, the user MUST be authenticated with that specific organization.
- Non-compliant users see the Cloud tab but cannot switch to other tabs.

---

## Web UI Components

### CloudView

**File:** [`webview-ui/src/components/cloud/CloudView.tsx`](webview-ui/src/components/cloud/CloudView.tsx)

The main Cloud tab in the extension. Two states:

**Authenticated:**

- Profile display (picture, name, email)
- Organization switcher
- Task sync toggle (disabled if managed by organization)
- Usage metrics notice
- "Visit Shofer Cloud" and "Log out" buttons

**Unauthenticated:**

- Benefits list (models, cloud agents, triggers, walkaway, metrics, history)
- "Get started" button → initiates OAuth flow
- Manual callback URL entry for troubleshooting
- "Having trouble?" → paste callback URL directly

### CloudAccountSwitcher

**File:** [`webview-ui/src/components/cloud/CloudAccountSwitcher.tsx`](webview-ui/src/components/cloud/CloudAccountSwitcher.tsx)

A compact dropdown in the chat text area showing the current account context. Supports switching between personal account and organization accounts. Shows user avatar or initials.

### CloudUpsellDialog

**File:** [`webview-ui/src/components/cloud/CloudUpsellDialog.tsx`](webview-ui/src/components/cloud/CloudUpsellDialog.tsx)

Modal dialog promoting Shofer Cloud with six key benefits: provider access, cloud agents, triggers/integrations, walkaway control, usage metrics, and task history. Shown in the chat view after 6+ tasks for unauthenticated users, and accessible from the Share button.

### OrganizationSwitcher

**File:** [`webview-ui/src/components/cloud/OrganizationSwitcher.tsx`](webview-ui/src/components/cloud/OrganizationSwitcher.tsx)

A more detailed organization switcher used in the CloudView. Displays all organizations with their avatars, roles, and a "Create Team Account" option linking to the billing page.

### ShoferBalanceDisplay

**File:** [`webview-ui/src/components/settings/providers/ShoferBalanceDisplay.tsx`](webview-ui/src/components/settings/providers/ShoferBalanceDisplay.tsx)

Shows the user's credit balance next to the Shofer Router provider in settings. Uses the [`useShoferCreditBalance`](webview-ui/src/components/ui/hooks/useShoferCreditBalance.ts) hook to fetch balance from the cloud API.

---

## Marketplace Integration

The marketplace loads remote configurations from Shofer Cloud:

- [`RemoteConfigLoader`](src/services/marketplace/RemoteConfigLoader.ts) fetches marketplace listings from `{SHOFER_API_URL}/api/...`.
- Organization settings can specify `hiddenMcps` and `hideMarketplaceMcps` to control visibility.
- Organization-provided MCPs are displayed under the organization name in the marketplace UI.

---

## Web App Pages (shofer.dev)

The Next.js app at [`apps/web-shofer/`](apps/web-shofer/) hosts marketing and product pages:

| Route         | Description                                                   |
| ------------- | ------------------------------------------------------------- |
| `/cloud`      | Cloud product page — autonomous agents, task history, sharing |
| `/cloud/team` | Team plan — billing, secrets management, provider profiles    |
| `/pricing`    | Pricing page — Free, Team, Enterprise tiers                   |
| `/enterprise` | Enterprise plan — control plane, SAML, audit logs             |
| `/provider`   | Provider info page describing the Shofer Router               |
| `/slack`      | Slack integration setup guide                                 |
| `/linear`     | Linear integration setup guide                                |
| `/reviewer`   | PR Reviewer cloud agent feature page                          |
| `/pr-fixer`   | PR Fixer cloud agent feature page                             |
| `/blog`       | Blog with CTAs promoting Cloud sign-up                        |

---

## Configuration & Environment Variables

| Variable                                        | Default                        | Description                                 |
| ----------------------------------------------- | ------------------------------ | ------------------------------------------- |
| `CLERK_BASE_URL`                                | `https://clerk.shofer.dev`     | Clerk authentication server URL             |
| `ROO_CODE_API_URL` / `SHOFER_API_URL`           | `https://app.shofer.dev`       | Shofer Cloud API base URL                   |
| `ROO_CODE_PROVIDER_URL` / `SHOFER_PROVIDER_URL` | `https://api.shofer.dev/proxy` | Shofer Router proxy base URL                |
| `SHOFER_CLOUD_TOKEN`                            | _(empty)_                      | Static JWT for cloud agent auth             |
| `SHOFER_CLOUD_ORG_SETTINGS`                     | _(empty)_                      | Base64-encoded org settings for static mode |
| `SHOFER_DISABLE_TELEMETRY`                      | `0`                            | Set to `1` to disable cloud telemetry       |

**Defined in:** [`packages/cloud/src/config.ts`](packages/cloud/src/config.ts) and referenced in `.env.sample`.

---

## Error Handling

**File:** [`packages/cloud/src/errors.ts`](packages/cloud/src/errors.ts)

Custom error classes for cloud operations:

| Error Class               | HTTP Status | Description                                                    |
| ------------------------- | ----------- | -------------------------------------------------------------- |
| `CloudAPIError`           | Varies      | Base error with optional `statusCode` and `responseBody`       |
| `AuthenticationError`     | 401         | Missing or invalid session token                               |
| `TaskNotFoundError`       | 404         | Task not found when sharing (triggers backfill)                |
| `NetworkError`            | —           | Network connectivity failure                                   |
| `InvalidClientTokenError` | —           | Expired/invalid Clerk client token (triggers credential clear) |

The [`CloudAPI.request()`](packages/cloud/src/CloudAPI.ts:25) method uses `AbortSignal.timeout()` (30s default) and distinguishes between network errors, timeouts, and HTTP error responses.

---

## Lifecycle

The cloud service lifecycle is managed in [`src/extension.ts`](src/extension.ts):

1. **Activation:** `CloudService.createInstance()` is called, which initializes all sub-services.
2. **Runtime:** Event handlers respond to auth state changes (refresh models, clear cache, apply provider profiles).
3. **Deactivation:** `CloudService.instance.dispose()` is called, which cleans up timers, listeners, and the retry queue.

---

## Summary of Key Files

| File                                                                                                                                             | Purpose                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| [`packages/cloud/src/CloudService.ts`](packages/cloud/src/CloudService.ts)                                                                       | Central orchestrator          |
| [`packages/cloud/src/WebAuthService.ts`](packages/cloud/src/WebAuthService.ts)                                                                   | Clerk OAuth authentication    |
| [`packages/cloud/src/StaticTokenAuthService.ts`](packages/cloud/src/StaticTokenAuthService.ts)                                                   | Cloud agent static token auth |
| [`packages/cloud/src/CloudSettingsService.ts`](packages/cloud/src/CloudSettingsService.ts)                                                       | API-fetched org/user settings |
| [`packages/cloud/src/StaticSettingsService.ts`](packages/cloud/src/StaticSettingsService.ts)                                                     | Static org settings           |
| [`packages/cloud/src/CloudAPI.ts`](packages/cloud/src/CloudAPI.ts)                                                                               | HTTP client for cloud APIs    |
| [`packages/cloud/src/CloudShareService.ts`](packages/cloud/src/CloudShareService.ts)                                                             | Task sharing logic            |
| [`packages/cloud/src/TelemetryClient.ts`](packages/cloud/src/TelemetryClient.ts)                                                                 | Cloud telemetry client        |
| [`packages/cloud/src/retry-queue/RetryQueue.ts`](packages/cloud/src/retry-queue/RetryQueue.ts)                                                   | Resilient request retry       |
| [`packages/cloud/src/RefreshTimer.ts`](packages/cloud/src/RefreshTimer.ts)                                                                       | Exponential backoff timer     |
| [`packages/cloud/src/config.ts`](packages/cloud/src/config.ts)                                                                                   | Environment configuration     |
| [`packages/cloud/src/errors.ts`](packages/cloud/src/errors.ts)                                                                                   | Error classes                 |
| [`packages/types/src/cloud.ts`](packages/types/src/cloud.ts)                                                                                     | TypeScript type definitions   |
| [`src/api/providers/shofer.ts`](src/api/providers/shofer.ts)                                                                                     | Shofer Router AI provider     |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                                                 | Task sync integration         |
| [`src/services/mdm/MdmService.ts`](src/services/mdm/MdmService.ts)                                                                               | MDM policy enforcement        |
| [`src/core/config/ProviderSettingsManager.ts`](src/core/config/ProviderSettingsManager.ts)                                                       | Cloud profile sync            |
| [`webview-ui/src/components/cloud/CloudView.tsx`](webview-ui/src/components/cloud/CloudView.tsx)                                                 | Cloud tab UI                  |
| [`webview-ui/src/components/cloud/CloudAccountSwitcher.tsx`](webview-ui/src/components/cloud/CloudAccountSwitcher.tsx)                           | Account switcher              |
| [`webview-ui/src/components/cloud/CloudUpsellDialog.tsx`](webview-ui/src/components/cloud/CloudUpsellDialog.tsx)                                 | Cloud upsell modal            |
| [`webview-ui/src/components/settings/providers/ShoferBalanceDisplay.tsx`](webview-ui/src/components/settings/providers/ShoferBalanceDisplay.tsx) | Credit balance display        |
