# Builtin Config — Design

One plugin carrying Shofer's built-in **configuration as data**: the six default
modes. It has no code — `plugin.json` declares everything — and the design lives
under [`docs/`](docs/):

- [`docs/modes.md`](docs/modes.md) — the six built-in modes, and the core-side
  resolution chain they feed

## Why a plugin

The built-in modes are platform defaults shipped as overridable data: a pure
`contributes` block with no runtime half, sitting at the built-in precedence tier
under a user's or project's own definitions, and exactly what an organization means
when it says "remove the built-ins and ship ours instead" — a config bundle replaces
them as a unit.

## What the manifest declares

| Block                      | Content                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contributes.modes`        | Code, Architect, Debug, Code Search, Web Search, Reviewer — each a role definition plus a tool-group allow-list                                                                                                        |
| `permissions`              | `modes: true`                                                                                                                                                                                                          |
| `defaultEnabled`           | on out of the box — these are the platform's defaults, not an opt-in add-on                                                                                                                                            |
| `unqualifiedContributions` | the mode slugs are a public contract (`code`, `architect`, … in every setting, mode link and `switch_mode` call), so they keep their canonical names instead of `builtin-config:code`. Honored only for bundled scope. |

Overriding stays per item: a user or project mode with the same slug replaces a
built-in mode in place.

## Governance

An organization suppresses the built-ins by disabling the plugin:
`SHOFER_DISABLED_PLUGINS=builtin-config` (consumed by core's `governance.ts` →
`PluginManager.forceDisabledPlugins`). A suppressed plugin contributes nothing, so the
modes never reach any list — only bundle/user/project definitions remain. Suppression
is all-or-nothing at the plugin level, which matches how it is used: a deployment that
replaces the defaults replaces the whole set (arkware's resource-manager ships org mode
sets in the config bundle and suppresses this plugin on every workspace pod).
