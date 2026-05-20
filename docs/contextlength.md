# Shofer Context Window Data Flow

## Question

Does `ContextLength` in `llm-router/internal/types/model_registry.go` actually get taken into consideration by Shofer UI when showing/calculating the context window utilization?

## Answer

**Yes.** `ContextLength` in [`model_registry.go`](llm-router/internal/types/model_registry.go:8) flows through the entire pipeline and determines the context window number displayed in Shofer's UI progress bar. The pipeline was **fixed** (2026-05-01) — previously the webview used a static map that caused a fallback to 128K.

## Path A: Shofer Router provider

| Step    | File                                                                                                      | Field                                            |
| ------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Source  | [`model_registry.go:8`](llm-router/internal/types/model_registry.go:8)                                    | `ContextLength int`                              |
| API     | [`models.go:226`](llm-router/internal/handlers/models.go:226)                                             | JSON `context_length`                            |
| Proxy   | Shofer Router (hosted)                                                                                    | remaps → `context_window`                        |
| Fetcher | [`useSelectedModel.ts:354`](extensions/shofer/webview-ui/src/components/ui/hooks/useSelectedModel.ts:354) | `info.contextWindow` (via `routerModels.shofer`) |
| Schema  | [`shofer.ts:35`](extensions/shofer/packages/types/src/providers/shofer.ts:35)                             | `context_window: z.number()`                     |
| UI      | [`TaskHeader.tsx:106`](extensions/shofer/webview-ui/src/components/chat/TaskHeader.tsx:106)               | `model?.contextWindow`                           |

## Path B: llm-provider → VSCode LM API → vscode-lm handler

| Step            | File                                                                                                      | Field                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Source          | [`model_registry.go:218`](llm-router/internal/types/model_registry.go:218)                                | `ContextLength: 1000000`                                                                          |
| API             | [`models.go:226`](llm-router/internal/handlers/models.go:226)                                             | JSON `context_length: 1000000`                                                                    |
| llm-provider    | [`llm-client.ts:651`](extensions/llm-provider/src/llm-client.ts:651)                                      | `contextLength: model.context_length`                                                             |
| VSCode info     | [`language-model-provider.ts:976`](extensions/llm-provider/src/language-model-provider.ts:976)            | `maxInputTokens: contextLength`                                                                   |
| VSCode LM       | `vscode.lm.selectChatModels()`                                                                            | `LanguageModelChat.maxInputTokens`                                                                |
| Runtime handler | [`vscode-lm.ts`](extensions/shofer/src/api/providers/vscode-lm.ts) `getModel()`                           | `contextWindow: this.client.maxInputTokens` (no 128K fallback)                                    |
| IPC message     | [`webviewMessageHandler.ts:1238-1241`](extensions/shofer/src/core/webview/webviewMessageHandler.ts:1238)  | `{ type: "vsCodeLmModels" }` (now `VsCodeLmChatInfo[]` with `shoferCapabilities`/`shoferPricing`) |
| Context         | [`ExtensionStateContext.tsx:327`](extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx:327) | `vsCodeLmModels` state                                                                            |
| Hook            | [`useSelectedModel.ts`](extensions/shofer/webview-ui/src/components/ui/hooks/useSelectedModel.ts)         | dynamic lookup from context                                                                       |
| UI              | [`TaskHeader.tsx:106`](extensions/shofer/webview-ui/src/components/chat/TaskHeader.tsx:106)               | `model?.contextWindow`                                                                            |

## Root Cause of the 128K Bug (FIXED)

The webview's [`useSelectedModel`](extensions/shofer/webview-ui/src/components/ui/hooks/useSelectedModel.ts:312) hook for `vscode-lm` used a static [`vscodeLlmModels`](extensions/shofer/packages/types/src/providers/vscode-llm.ts:65) map. Unknown models (from provider extensions like llm-provider) fell through to [`openAiModelInfoSaneDefaults`](extensions/shofer/packages/types/src/providers/openai.ts:595) which has `contextWindow: 128_000`.

The backend `vscode-lm` handler's [`getModel()`](extensions/shofer/src/api/providers/vscode-lm.ts:851) correctly returned 1M from `this.client.maxInputTokens`, but the webview never used it — it used its own static lookup.

### Fix applied

1. **[`vscode-llm.ts`](extensions/shofer/packages/types/src/providers/vscode-llm.ts)** — emptied static map, kept type compatibility; later extended `VsCodeLmChatInfo` with `capabilities`, `shoferCapabilities`, and `shoferPricing` fields populated from the side channel.
2. **[`ExtensionStateContext.tsx`](extensions/shofer/webview-ui/src/context/ExtensionStateContext.tsx)** — added `vsCodeLmModels` state + `vsCodeLmModels` IPC message handler.
3. **[`useSelectedModel.ts`](extensions/shofer/webview-ui/src/components/ui/hooks/useSelectedModel.ts)** — vscode-lm case looks up the dynamic `vsCodeLmModels` from context, derives `contextWindow` from `maxInputTokens`, and reads `supportsImages`/`supportsPromptCache`/pricing from `shoferCapabilities`/`shoferPricing` instead of hardcoded defaults.
4. **[`VSCodeLM.tsx`](extensions/shofer/webview-ui/src/components/settings/providers/VSCodeLM.tsx)** — reads models from `useExtensionState()`, uses `maxInputTokens` for `contextWindow`.
5. **[`vscode-lm.ts`](extensions/shofer/src/api/providers/vscode-lm.ts)** — runtime handler removed the `openAiModelInfoSaneDefaults.contextWindow` (128K) fallback and the hardcoded `supportsImages: false` / `supportsPromptCache: true` flags; all three now come from `this.client.maxInputTokens` and `shoferCapabilities` (fetched via `shofer.llm.getModelCapabilities`).
6. **[`llm-router`](llm-router/internal/handlers/models.go)** + **[`llm-provider`](extensions/llm-provider/src/language-model-provider.ts)** — added `prompt_cache` capability to `/v1/models` (derived from `ContextCacheRead > 0`) and the `shofer.llm.getModelCapabilities` side-channel command in llm-provider, since VS Code's `LanguageModelChatProviderCapabilities` only exposes `imageInput` and `toolCalling`.

## Verification

```bash
$ curl -s http://localhost:30081/v1/models | jq '.data[] | select(.id | test("deepseek")) | {id, context_length}'
deepseek/deepseek-v4-pro: context_length=1000000  ✅
deepseek/deepseek-v4-flash: context_length=1000000 ✅
```

Diagnostic logs prefixed `[CONTEXT-DIAG]` (in `Task.attemptApiRequest`, `context-management/index.ts`, and `condense/index.ts`) confirm `maxInputTokens=1000000` at every pipeline stage and trace condensation triggers/bails.

## What `ContextLength` Drives

1. **Context window progress bar** — the "N / M tokens" display and three-segment utilization bar
2. **Context condensation thresholds** — condensation triggers at percentage of `contextWindow`
3. **`getModelMaxOutputTokens()` clamping** — `maxTokens` clamped to 20% of `contextWindow` for Anthropic models
4. **Context truncation** — sliding window removal uses `contextWindow` as the upper bound
5. **Model picker display** — `VSCodeLM.tsx` uses `maxInputTokens` as `contextWindow` in the settings UI
