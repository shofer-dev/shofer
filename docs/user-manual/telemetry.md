# Privacy & Telemetry

Shofer collects **anonymous usage data** to help us understand how you use the extension — which features are popular, where errors happen, and how to improve performance. **We never collect your code, prompts, or personally identifiable information.**

## What We Collect

Telemetry captures **anonymous product signals** only:

| Data                | Example                                 | Purpose                   |
| ------------------- | --------------------------------------- | ------------------------- |
| Machine ID          | `vscode.env.machineId`                  | Anonymous user counting   |
| App version         | `1.2.3`                                 | Feature adoption tracking |
| VS Code version     | `1.95.0`                                | Compatibility analysis    |
| Platform            | `linux`, `darwin`                       | OS usage distribution     |
| Language            | `en`, `ko`                              | Localization planning     |
| Mode                | `code`, `architect`                     | Mode usage patterns       |
| Provider & model    | `openrouter/claude-sonnet-4-5`          | Provider popularity       |
| Tool names          | `read_file`, `apply_diff`               | Tool usage patterns       |
| Token counts & cost | `input: 4200, output: 850, cost: $0.03` | Usage and cost analysis   |
| Error messages      | (sanitized)                             | Bug detection             |
| Task ID             | (opaque UUID)                           | Session correlation       |

## What We NEVER Collect

- **Code or file contents** — never sent
- **AI prompts or responses** — excluded
- **Repository URLs, names, or branch names** — filtered out
- **Personally identifiable information** — not collected
- **Your shell command output** — never included

## Opting In or Out

### First Launch

When you first open Shofer, a **telemetry banner** appears at the top of the chat area:

<!-- XXX: Screenshot — Telemetry banner at the top of ChatView showing the privacy message with "Accept" and "Dismiss" buttons. -->

- **Accept** — telemetry is enabled. You can change your mind later.
- **Dismiss** — telemetry stays disabled. You can enable it later in Settings.

If you dismiss without choosing, telemetry remains **disabled** until you explicitly turn it on.

### Changing Your Choice Later

Open **Settings** (gear icon in the Shofer title bar) and go to the **Notifications** section:

<!-- XXX: Screenshot — SettingsView scrolled to the Notification Settings section showing the "Telemetry" toggle with label "Share anonymous usage data to help improve Shofer". -->

Toggle **"Share anonymous usage data"** on or off. Changes take effect immediately — no restart needed.

### VS Code Global Telemetry Level

Shofer also respects the **VS Code global telemetry level** (`telemetry.telemetryLevel` in VS Code settings). If you set this to anything other than `"all"`, Shofer telemetry is **fully disabled** regardless of the Shofer-specific toggle.

## How It Works

Shofer uses **PostHog** (`posthog-node` in the extension host, `posthog-js` in the webview) as its analytics backend. Events are sent to `https://ph.shofer.dev`.

<!-- XXX: Screenshot — Architecture diagram showing Extension Host (TelemetryService → PostHogTelemetryClient → ph.shofer.dev) and Webview (TelemetryClient → posthog-js → ph.shofer.dev) with a privacy-filter overlay on the extension host path. -->

### The Kill Switch

A `TELEMETRY_ENABLED` environment variable acts as a **global kill switch**. When set to anything other than `true`, the entire telemetry subsystem is disabled at startup — no client is initialized, no data is collected, no network calls are made.

## What Events Are Tracked

We track a focused set of product events. Each event carries only the data described above — no code, no prompts, no file contents.

| Category            | Examples                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| **Task lifecycle**  | Task created, task completed                                                                            |
| **LLM usage**       | API completions (token counts, cost, provider/model)                                                    |
| **Tool usage**      | `read_file`, `execute_command`, `apply_diff`, etc.                                                      |
| **Mode changes**    | Switching between Code, Architect, Debug, etc.                                                          |
| **UI interactions** | Tab switches, title bar button clicks, marketplace installs                                             |
| **Errors**          | Schema validation errors, diff application errors, rate limits (402/429 are **not** reported as errors) |

## Errors & Crash Reporting

When things go wrong, Shofer captures **error type and context** only — never your code or prompts:

- **API errors**: provider name, model ID, HTTP status code, sanitized error message
- **Tool errors**: which tool failed and why (e.g., diff application error with mistake count)
- **Webview errors**: React error boundary catches with component stack traces (UI code only)

The following errors are **intentionally excluded** because they're normal:

- Payment/billing errors (HTTP 402)
- Rate limit errors (HTTP 429)
- Any error message containing "rate limit"

## Data Retention

Telemetry events are retained for product analytics purposes and are not shared with third parties. Telemetry is **off by default** and requires explicit opt-in.
