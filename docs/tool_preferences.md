# Tool Preferences (per-model tool availability, dialect & naming)

This document describes how Shofer decides **which native tools a given model
sees**, and where that decision lives for each of the three ways a model can be
reached. It is the companion to the tool-grouping/mode-filtering machinery in
[`tool_access.md`](./tool_access.md) and the audit in
[`../todos/tool-call-recovery-audit.md`](../todos/tool-call-recovery-audit.md).

## What a "tool preference" is

Two optional fields on a model's `ModelInfo`
([`packages/types/src/model.ts`](../packages/types/src/model.ts)):

- **`includedTools: string[]`** — opt a model into tools that are otherwise
  opt-in (`customTools` in a mode's groups). This is also how **tool dialect /
  naming** is expressed: a model that prefers the `search_replace` editor name
  gets `includedTools: ["search_replace"]`, a Claude-shaped model gets `["edit"]`,
  an OpenAI/Codex model gets `["apply_patch"]`. There is **no separate
  rename/alias field** — choosing the dialect tool _is_ the naming mechanism.
- **`excludedTools: string[]`** — remove specific native tools from a model's
  surface (e.g. drop `apply_diff`/`write_to_file` for a model that should only
  use `apply_patch`).

The default baseline for any model that sets neither is the standard write
surface — `apply_diff` + `write_to_file` (plus the rest of each enabled group).

## Design principle: integrator-owned, never user-overridable

Tool availability, dialect, and naming are **hardcoded by whoever integrates a
model** — in the relevant catalog/source for that path. There is intentionally
**no** user-facing setting to override them. Tool-dialect decisions require
knowing how a specific model behaves; that belongs to the integrator, in code,
not to end users. A model that sets no preferences isn't missing a feature — it
just inherits the safe defaults until someone integrates it.

See the standing note in
[`../todos/tool-call-recovery-audit.md`](../todos/tool-call-recovery-audit.md).

## The three model-access paths

A model reaches Shofer through one of three providers. Each has a different
**source of truth (SoT)** for tool preferences and a different transport that
carries them into `ModelInfo`.

```
                         ModelInfo.includedTools / excludedTools
                                        ▲
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
 (a) shofer provider            (b) direct upstream            (c) vscode-llm provider
   (llm-router /v1/models)     (anthropic/openai/openrouter…)   (VS Code LM API)
        │                               │                               │
   llm-router catalog          curated provider ModelInfo         shofer-router catalog
 internal/types/             packages/types/src/providers/*.ts   src/model-registry.ts
   model_registry.go          + utils/router-tool-preferences.ts   (+ side-channel)
```

### (a) `shofer` provider → `llm-router`

- **In path:** when Shofer is configured with the Shofer cloud/provider. The
  provider (`src/api/providers/shofer.ts`, extends `OpenRouterHandler`) fetches an
  OpenRouter-compatible `/v1/models` from **llm-router**
  (`http://localhost:30081/v1` by default).
- **SoT:** the **llm-router** Go service (in the `arkware.ai` monorepo, not a
  submodule). Catalog: `internal/types/model_registry.go` (`ModelRegistry`
  entries). Per-model `IncludedTools`/`ExcludedTools` can be set per entry;
  otherwise provider-family defaults are applied by `resolveModelToolPrefs`
  (`internal/handlers/models.go`) — e.g. OpenAI → `included:[apply_patch]`,
  `excluded:[apply_diff, write_to_file]`.
- **Transport:** `/v1/models` emits top-level `included_tools` / `excluded_tools`
  on each model (`internal/types/models.go` `Model`).
- **Into ModelInfo:** the OpenRouter fetcher
  ([`src/api/providers/fetchers/openrouter.ts`](../src/api/providers/fetchers/openrouter.ts))
  parses those fields (`modelRouterBaseModelSchema`) and maps them onto
  `ModelInfo.includedTools` / `excludedTools` in `parseOpenRouterModel`. The
  client-side `applyRouterToolPreferences` may then union family defaults on top
  (it unions, never overwrites, so catalog values survive).

### (b) Direct upstream providers

- **In path:** Anthropic, OpenAI, xAI, OpenRouter/Requesty, Ollama, etc., talking
  to the provider's API directly.
- **SoT:** the curated `ModelInfo` literals in
  [`packages/types/src/providers/*.ts`](../packages/types/src/providers) (e.g.
  `minimax.ts → includedTools:["search_and_replace"]`,
  `openai-codex.ts → ["apply_patch"]`, `xai.ts → ["search_replace"]`), plus the
  dynamic-router family rule in
  [`src/api/providers/utils/router-tool-preferences.ts`](../src/api/providers/utils/router-tool-preferences.ts)
  (`applyRouterToolPreferences`, applied for OpenRouter/Requesty/Unbound).
- This is the only path that already carried tool preferences before the
  audit; (a) and (c) were brought up to parity.

### (c) `vscode-llm` provider → `shofer-router`

- **In path:** when Shofer is configured to use the **VS Code LM API**. Models
  are served by the **shofer-router** extension, registered as a
  `LanguageModelChatProvider` (vendor `shofer`).
- **SoT:** the **shofer-router** catalog
  (`extensions/shofer-router/src/model-registry.ts`, `ModelRegistryEntry`).
  Per-entry `includedTools`/`excludedTools`, else provider-family defaults from
  `resolveModelToolPrefs` (`src/llm-client.ts`), mirroring llm-router.
- **Transport:** the VS Code `LanguageModelChatInformation.capabilities` cannot
  carry arbitrary arrays, so preferences ride the **side-channel command**
  `shofer.router.getModelCapabilities`, which returns shofer-router's own
  `ModelCapabilities` (now including `includedTools`/`excludedTools`).
- **Into ModelInfo:** `src/api/providers/vscode-lm.ts` reads the capabilities
  side-channel in `refreshShoferCapabilities`, stores them on
  `this.shoferCapabilities`, and maps them onto `ModelInfo.includedTools` /
  `excludedTools` in `getModel()`.

## How to add a preference (per path)

| Path                             | Where to edit                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) `shofer` / llm-router        | Set `IncludedTools`/`ExcludedTools` on the entry in `llm-router/internal/types/model_registry.go`, or add a provider-family rule in `resolveModelToolPrefs` (`internal/handlers/models.go`). |
| (b) direct upstream              | Set `includedTools`/`excludedTools` on the model's `ModelInfo` in `packages/types/src/providers/<provider>.ts`, or extend `applyRouterToolPreferences`.                                      |
| (c) `vscode-llm` / shofer-router | Set `includedTools`/`excludedTools` on the entry in `extensions/shofer-router/src/model-registry.ts`, or add a rule in `resolveModelToolPrefs` (`src/llm-client.ts`).                        |

All three honor the same convention: explicit per-model values win; otherwise a
provider-family default applies; otherwise the standard defaults stand. None of
them is user-overridable.
