# Telemetry Integration Test Scenarios

## Setup / Bootstrap

1. **TELEMETRY_ENABLED kill switch**

    - Start extension without `TELEMETRY_ENABLED=true` → `TelemetryService.isGloballyEnabled()` returns `false`, `TelemetryService.hasInstance()` returns `false`, no `PostHog` client is instantiated.
    - Start extension with `TELEMETRY_ENABLED=true` → `TelemetryService` singleton is created, `PostHogTelemetryClient` is registered.

2. **Singleton lifecycle**
    - Call `TelemetryService.createInstance()` twice → second call throws `"TelemetryService instance already created"`.
    - Access `TelemetryService.instance` before `createInstance()` → throws `"TelemetryService not initialized"`.
    - `hasInstance()` returns `false` before `createInstance()`, `true` after.

## User Opt-In / Opt-Out

3. **Three-state setting model**

    - Default state is `"unset"` → telemetry is disabled (treated as disabled).
    - Set `telemetrySetting` to `"enabled"` → telemetry becomes active (subject to VSCode global check).
    - Set `telemetrySetting` to `"disabled"` → telemetry is disabled.

4. **TELEMETRY_SETTINGS_CHANGED ordering**

    - Turn telemetry OFF (`"enabled"` → `"disabled"`): verify `captureTelemetrySettingsChanged` is called BEFORE `updateTelemetryState(false)`.
    - Turn telemetry ON (`"disabled"` → `"enabled"`): verify `captureTelemetrySettingsChanged` is called AFTER `updateTelemetryState(true)`.
    - Toggle `"unset"` → `"enabled"` (first opt-in): event fires after enabling.
    - Toggle `"unset"` → `"disabled"`: no event fires (was never enabled).

5. **VSCode global telemetry gating**
    - Set `telemetry.telemetryLevel` to `"off"`, `telemetrySetting` to `"enabled"` → `PostHogTelemetryClient.isTelemetryEnabled()` returns `false`, no events are sent.
    - Set `telemetry.telemetryLevel` to `"all"`, `telemetrySetting` to `"enabled"` → telemetry is active.
    - Set `telemetry.telemetryLevel` to `"crash"` or `"error"` → telemetry is disabled regardless of user opt-in.

## Event Capture — Extension Host

6. **Typed convenience methods**

    - Call every `capture*` method on `TelemetryService` (`captureTaskCreated`, `captureTaskCompleted`, `captureLlmCompletion`, `captureModeSwitch`, `captureToolUsage`, `captureBudgetExceeded`, `captureContextCondensed`, `captureMcpAsyncCallStarted`, `captureCodeIndexSegmentDedup`, etc.) with valid parameters.
    - Verify each fans out to all registered clients (mock `TelemetryClient.capture` and assert it receives the correct `event` name and properties).

7. **Event exclusion list (PostHog)**

    - Emit `TASK_MESSAGE` → verify `PostHogTelemetryClient` does NOT forward it.
    - Emit `LLM_COMPLETION` → verify `PostHogTelemetryClient` does NOT forward it.
    - Emit any other event (e.g., `TOOL_USED`) → verify it IS forwarded.

8. **Property enrichment**
    - Register a `TelemetryPropertiesProvider` mock returning `{ appName: "Shofer", appVersion: "1.0.0", mode: "code" }`.
    - Capture an event with `{ taskId: "abc" }` → verify merged properties include both provider props AND event props, with event props taking precedence on conflict.

## Exception Capture

9. **Expected error filtering**

    - Capture `ApiProviderError` with `errorCode: 402` → verify `captureException` does NOT reach PostHog (`shouldReportApiErrorToTelemetry` returns `false`).
    - Capture `ApiProviderError` with `errorCode: 429` → same, filtered out.
    - Capture an error with message starting with `"429"` (`/^429\b/`) → filtered out.
    - Capture an error with message containing `"rate limit"` (case-insensitive) → filtered out.
    - Capture an error with `errorCode: 500` → NOT filtered, should reach PostHog.

10. **Structured error property extraction**

    - Throw `new ApiProviderError("msg", "openrouter", "claude-sonnet-4-5", "createMessage", 500)` → verify extracted properties include `{ provider: "openrouter", modelId: "claude-sonnet-4-5", operation: "createMessage", errorCode: 500 }`.
    - Throw `new ConsecutiveMistakeError("msg", "task-123", 3, 3, "tool_repetition", "anthropic", "claude-sonnet-4-5")` → verify extracted properties include `{ taskId: "task-123", consecutiveMistakeCount: 3, consecutiveMistakeLimit: 3, reason: "tool_repetition", provider: "anthropic", modelId: "claude-sonnet-4-5" }`.

11. **Error message mutation**

    - Capture an `ApiProviderError` whose nested `error.metadata.raw` contains a more descriptive upstream error → verify `error.message` is overwritten with the extracted message after `captureException` returns.

12. **OpenAI SDK error extraction**
    - Create a mock error matching `OpenAISdkError` shape with `status: 503`, `error.metadata.raw: "upstream timeout"` → verify `getErrorMessage(error)` returns `"upstream timeout"`.
    - Create a mock error matching `OpenAISdkError` shape with `status: 400`, no nested metadata → verify `getErrorMessage(error)` returns the top-level `error.message`.

## Privacy Filtering

13. **Git property filtering**
    - Emit any event with `{ repositoryUrl: "https://github.com/org/repo", repositoryName: "repo", defaultBranch: "main" }` → verify `PostHogTelemetryClient` strips these three properties.
    - Emit an event with `{ taskId: "abc", appName: "Shofer" }` → verify these non-git properties are preserved.

## Webview-Side Telemetry

14. **Browser client initialization**

    - Load webview with `telemetrySetting: "enabled"` → verify `TelemetryClient.updateTelemetryState(enabled, apiKey, machineId)` is called from `App.tsx` on state hydration.
    - Load webview with `telemetrySetting: "unset"` → verify telemetry client is initialized but disabled.

15. **UI interaction events**

    - Open ModeSelector dropdown → verify `MODE_SELECTOR_OPENED` is captured.
    - Click Share → Organization → verify `SHARE_ORGANIZATION_CLICKED` is captured.
    - Click Share → Public → verify `SHARE_PUBLIC_CLICKED` is captured.
    - Install a marketplace item → verify `MARKETPLACE_ITEM_INSTALLED` is captured.
    - Switch settings tab → verify `TAB_SHOWN` is captured with the correct `tab` value.
    - Dismiss an upsell banner → verify `UPSELL_DISMISSED` is captured with `upsellId`.

16. **Error boundary**
    - Trigger a React render error inside ErrorBoundary → verify `error_boundary_caught_error` is captured with error message and component stack.

## Shutdown & Cleanup

17. **Graceful shutdown**
    - Call `TelemetryService.instance.shutdown()` → verify `PostHogTelemetryClient.shutdown()` is called (which calls `posthog.shutdown()`).
    - After shutdown, attempting to capture events is a no-op (telemetry state does not change).

## Edge Cases

18. **Telemetry disabled at build time**

    - Set `TELEMETRY_ENABLED=false` → verify all `capture*` calls on `TelemetryService` are no-ops, `register()` is a no-op, `setProvider()` is a no-op.

19. **No registered clients**

    - Create `TelemetryService` with empty client array → verify `isReady` is `false`, all `capture*` calls are no-ops.

20. **Concurrent event capture**
    - Fire multiple `captureEvent` calls rapidly from different tasks → verify no race conditions, all events reach the client in order.
