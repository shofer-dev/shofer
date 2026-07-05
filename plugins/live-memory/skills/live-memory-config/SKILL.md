---
name: live-memory-config
description: View or change the Live Memory plugin's configuration for this workspace — the provider profile the memory LLM uses, retention caps, the external-edit watch glob, the compaction interval, and the context-window budget/threshold. Use when the user asks to point Live Memory at a different model/provider, tune how much it remembers, or change its context budget.
---

# Live Memory — Configuration

The `live-memory` plugin reads its settings from the standard per-plugin config
surface (`ctx.config`, default-merged from the manifest `config` schema). Values
are stored under `pluginConfigs["live-memory"]` and edited in
**Settings → Plugins → Live Memory** (or the Marketplace Plugins tab), the same
place the plugin is enabled and granted its billed-AI consent.

## Keys

| Key                    | Default             | What it controls                                                                                                                     |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `profileRef`           | `""` (host default) | The provider-profile name/id the memory LLM uses (`ctx.ai.buildHandler`). This is the plugin analogue of the built-in `apiConfigId`. |
| `maxObservations`      | `400`               | How many recent file-activity observations to retain per workspace.                                                                  |
| `maxQuestions`         | `50`                | How many recent question/answer pairs to retain.                                                                                     |
| `watchGlob`            | `**/*`              | Glob (under the granted filesystem roots) watched for external edits.                                                                |
| `compactIntervalMs`    | `300000`            | Background compaction interval (ms); `0` disables it.                                                                                |
| `maxContextTokens`     | `128000`            | The memory agent's context-window budget (tokens).                                                                                   |
| `contextFillThreshold` | `0.8`               | Fraction of the budget past which the window is flagged "nearly full".                                                               |

## Notes

- **Enabling the plugin** is the on/off switch — there is no separate start/stop
  command. Disabling it tears down its watchers and background service.
- **Billed AI** requires a second, explicit "uses AI (billed)" consent beyond the
  plugin's `permissions.ai` grant; without it the memory LLM stays a denying stub
  and questions return a clear not-consented error rather than silently billing.
- Changing `profileRef` takes effect on the next `ask_live_memory` question (the
  memory agent builds its handler lazily). `maxContextTokens` /
  `contextFillThreshold` take effect when the agent is next (re)created.
