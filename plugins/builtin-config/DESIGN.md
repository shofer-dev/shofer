# Builtin Config — Design

One plugin carrying Shofer's built-in **configuration as data**: the six default modes
and the two shipped multi-agent workflows. It has no code — `plugin.json` declares
everything — and each half's own design lives under [`docs/`](docs/):

- [`docs/modes.md`](docs/modes.md) — the six built-in modes, and the core-side
  resolution chain they feed
- [`docs/workflows.md`](docs/workflows.md) — the shipped `.slang` workflows, and the
  discovery/precedence/launch machinery

## Why one plugin

Modes and workflows are the same kind of thing: platform defaults shipped as
overridable data. Both are pure `contributes` entries with no runtime half, both sit at
the built-in precedence tier under a user's or project's own definitions, and both are
what an organization means when it says "remove the built-ins and ship ours instead" —
a config bundle replaces them as a unit. Two plugins meant two manifests and two
entries in every governance list for one concept.

## What the manifest declares

| Block                      | Content                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contributes.modes`        | Code, Architect, Debug, Code Search, Web Search, Reviewer — each a role definition plus a tool-group allow-list                                                                                                        |
| `contributes.workflows`    | `debug` and `implement-feature`, declared here with their `.slang` sources under [`workflows/`](workflows/)                                                                                                            |
| `permissions`              | `modes: true`, `workflows: true`                                                                                                                                                                                       |
| `defaultEnabled`           | on out of the box — these are the platform's defaults, not an opt-in add-on                                                                                                                                            |
| `unqualifiedContributions` | the mode slugs are a public contract (`code`, `architect`, … in every setting, mode link and `switch_mode` call), so they keep their canonical names instead of `builtin-config:code`. Honored only for bundled scope. |

Overriding stays per item: a user or project mode with the same slug replaces a
built-in mode in place, and a user or project workflow with the same flow name shadows
a built-in workflow — merging the plugins changed nothing about item-level precedence.

## Governance

An organization suppresses the built-ins by disabling the plugin:
`SHOFER_DISABLED_PLUGINS=builtin-config` (consumed by core's `governance.ts` →
`PluginManager.forceDisabledPlugins`). A suppressed plugin contributes nothing, so the
modes never reach any list and the workflows never appear in the launcher — only
bundle/user/project definitions remain. Suppression is all-or-nothing at the plugin
level, which matches how it is used: a deployment that replaces the defaults replaces
the whole set (arkware's resource-manager ships org mode/workflow sets in the config
bundle and suppresses this plugin on every workspace pod).
