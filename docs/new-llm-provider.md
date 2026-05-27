# Adding a New LLM/Model Provider

This document describes the full set of changes needed to add a new upstream LLM provider to Shofer. Use the existing DeepSeek provider as a reference implementation throughout.

---

## Architecture Overview

```
User → Settings UI (webview) → ProviderSettings (Zod schema)
     → buildApiHandler() dispatch → Handler class (src/api/providers/)
     → llm-router (Go proxy) → upstream API
```

Providers that talk directly to the upstream API (no proxy) skip the llm-router layer. Providers that go through llm-router require additional model registration in the Go backend.

---

## Layer 1: Model Definitions (`packages/types/src/providers/`)

### 1.1 Create the models file

Create `packages/types/src/providers/<name>.ts` with:

```typescript
// packages/types/src/providers/deepseek.ts (reference)

export type DeepSeekModelId = keyof typeof deepSeekModels

export const deepSeekDefaultModelId: DeepSeekModelId = "deepseek-chat"

export const deepSeekModels = {
	"deepseek-chat": {
		maxTokens: 8192,
		contextWindow: 131_072,
		supportsReasoning: false,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.27,
		outputPrice: 1.1,
		cacheReadsPrice: 0.028,
		description: "DeepSeek-V3.2 (Non-thinking Mode)...",
	},
	// ... more models
} as const satisfies Record<string, ModelInfo>

export const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.3
```

**Required fields per model:**

- `maxTokens` — max output tokens
- `contextWindow` — total context window size
- `supportsPromptCache` — whether the provider supports Anthropic-style prompt caching
- `inputPrice`, `outputPrice` — per-million-token pricing in USD (set to 0 if free)
- `description` — user-facing description for the model selector

**Optional fields:** `supportsReasoning`, `supportsImages`, `cacheReadsPrice`, `cacheWritesPrice`, `maxImageCount`, `inputAudio`, `inputVideo`, `reasoningEffort`

### 1.2 Re-export from the barrel file

Add to [`packages/types/src/providers/index.ts`](extensions/shofer/packages/types/src/providers/index.ts):

```typescript
export * from "./<name>.js"
import { <name>DefaultModelId } from "./<name>.js"

// In the getDefaultModelIdValue switch:
case "<name>":
    return <name>DefaultModelId
```

---

## Layer 2: Provider Schema & Registration (`packages/types/src/provider-settings.ts`)

### 2.1 Add the provider to the name list

Add `"<name>"` to the `providerNames` array (~line 100):

```typescript
export const providerNames = [
	// ...
	"<name>",
] as const
```

### 2.2 Import the models

Add the models import at the top:

```typescript
import { <name>Models } from "./providers/index.js"
```

### 2.3 Create the Zod schema

Add a Zod schema for this provider's settings:

```typescript
const <name>Schema = apiModelIdProviderModelSchema.extend({
    <name>BaseUrl: z.string().optional(),
    <name>ApiKey: z.string().optional(),
})
```

**Patterns:**

- Providers with API keys: extend `apiModelIdProviderModelSchema`
- Providers with base URLs + keys: extend the schema with `{name}BaseUrl` and `{name}ApiKey`
- Proxy-based providers (OpenRouter, LiteLLM, etc.): extend a base schema with `openAiBaseUrl`, `openAiApiKey`

### 2.4 Add to the Zod discriminated union

Add to the `apiProviderSchema` array (~line 440):

```typescript
<name>Schema.merge(z.object({ apiProvider: z.literal("<name>") })),
```

### 2.5 Add to ApiHandlerOptions spread

Add to the type spread (~line 450):

```typescript
...<name>Schema.shape,
```

### 2.6 Add model selection field mapping

Add to the `providerModelIdFields` map (~line 530):

```typescript
<name>: "apiModelId",
```

### 2.7 Add model info entry

Add to the `providerModelsMap` object (~line 590):

```typescript
<name>: {
    id: "<name>",
    label: "Provider Display Name",
    models: Object.keys(<name>Models),
},
```

---

## Layer 3: API Handler (`src/api/providers/`)

### 3.1 Create the handler class

Create `src/api/providers/<name>.ts`. Choose the appropriate base class:

| If your provider...           | Extend               |
| ----------------------------- | -------------------- |
| Uses OpenAI-compatible API    | `OpenAiHandler`      |
| Uses Anthropic-compatible API | `AnthropicHandler`   |
| Uses OpenAI Responses API     | `OpenAiCodexHandler` |
| Is completely custom          | `BaseProvider`       |

**Example — OpenAI-compatible (DeepSeek):**

```typescript
import { <Name>Models, <name>DefaultModelId, <NAME>_DEFAULT_TEMPERATURE } from "@shofer/types"
import { ApiStream } from "../transform/stream"
import { OpenAiHandler } from "./openai"

export class <Name>Handler extends OpenAiHandler {
    constructor(options: ApiHandlerOptions) {
        super({
            ...options,
            openAiApiKey: options.<name>ApiKey ?? "not-provided",
            openAiModelId: options.apiModelId ?? <name>DefaultModelId,
            openAiBaseUrl: options.<name>BaseUrl || "https://api.<name>.com",
            openAiStreamingEnabled: true,
            includeMaxTokens: true,
        })
    }

    override getModel() {
        const id = this.options.apiModelId ?? <name>DefaultModelId
        const info = <Name>Models[id as keyof typeof <Name>Models] || <Name>Models[<name>DefaultModelId]
        // ...
        return { id, info, ...params }
    }

    override async *createMessage(systemPrompt, messages, metadata) {
        // Override if custom request/response handling is needed
    }
}
```

### 3.2 Register in the providers barrel

Add to [`src/api/providers/index.ts`](extensions/shofer/src/api/providers/index.ts):

```typescript
export { <Name>Handler } from "./<name>"
```

### 3.3 Add to the dispatch switch

In [`src/api/index.ts`](extensions/shofer/src/api/index.ts):

1. Import the handler:

```typescript
import { <Name>Handler } from "./providers"
```

2. Add case to `buildApiHandler()`:

```typescript
case "<name>":
    return new <Name>Handler(options)
```

---

## Layer 4: Webview UI (`webview-ui/src/components/settings/`)

### 4.1 Create the provider settings form

Create `webview-ui/src/components/settings/providers/<Name>.tsx`:

```typescript
import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import type { ProviderSettings } from "@shofer/types"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { inputEventTransform } from "../transforms"

export const <Name> = ({ apiConfiguration, setApiConfigurationField }: <Name>Props) => {
    const { t } = useAppTranslation()

    const handleInputChange = useCallback(
        <K extends keyof ProviderSettings, E>(
            field: K,
            transform: (event: E) => ProviderSettings[K] = inputEventTransform,
        ) => (event: E | Event) => {
            setApiConfigurationField(field, transform(event as E))
        },
        [setApiConfigurationField],
    )

    return (
        <>
            <VSCodeTextField
                value={apiConfiguration?.<name>ApiKey || ""}
                type="password"
                onInput={handleInputChange("<name>ApiKey")}
                placeholder={t("settings:placeholders.apiKey")}
                className="w-full">
                <label className="block font-medium mb-1">{t("settings:providers.<name>ApiKey")}</label>
            </VSCodeTextField>
            <div className="text-sm text-vscode-descriptionForeground -mt-2">
                {t("settings:providers.apiKeyStorageNotice")}
            </div>
            {!apiConfiguration?.<name>ApiKey && (
                <VSCodeButtonLink href="https://platform.<name>.com/" appearance="secondary">
                    {t("settings:providers.get<Name>ApiKey")}
                </VSCodeButtonLink>
            )}
        </>
    )
}
```

### 4.2 Export from providers barrel

Add to [`webview-ui/src/components/settings/providers/index.ts`](extensions/shofer/webview-ui/src/components/settings/providers/index.ts):

```typescript
export { <Name> } from "./<Name>"
```

### 4.3 Wire into ApiOptions

In [`webview-ui/src/components/settings/ApiOptions.tsx`](extensions/shofer/webview-ui/src/components/settings/ApiOptions.tsx):

1. Import the component and default model ID
2. Add to `defaultModels` map:

```typescript
<name>: { field: "apiModelId", default: <name>DefaultModelId },
```

3. Add conditional rendering:

```typescript
{selectedProvider === "<name>" && (
    <<Name>
        apiConfiguration={apiConfiguration}
        setApiConfigurationField={setApiConfigurationField}
        simplifySettings={simplifySettings}
    />
)}
```

### 4.4 Add to provider constants

In [`webview-ui/src/components/settings/constants.ts`](extensions/shofer/webview-ui/src/components/settings/constants.ts):

1. Import models:

```typescript
import { <name>Models } from "@shofer/types"
```

2. Add to `MODELS_BY_PROVIDER`:

```typescript
<name>: <name>Models,
```

### 4.5 Add to provider dropdown list

In [`webview-ui/src/components/settings/constants.ts`](extensions/shofer/webview-ui/src/components/settings/constants.ts) provider list (~line 50):

```typescript
{ value: "<name>", label: "Provider Display Name", proxy: false },
```

Set `proxy: true` if the provider is a routing proxy (like OpenRouter, LiteLLM).

---

## Layer 5: i18n Strings

### 5.1 Add to English locale

In [`webview-ui/src/i18n/locales/en/settings.json`](extensions/shofer/webview-ui/src/i18n/locales/en/settings.json), add to the `providers` block:

```json
"<name>ApiKey": "Provider Name API Key",
"get<Name>ApiKey": "Get Provider Name API Key"
```

### 5.2 Add to all other locales

Copy the new keys to all locale files under `webview-ui/src/i18n/locales/*/settings.json`. Translate the values appropriately.

---

## Layer 6: llm-router (Go Backend)

If the provider goes through llm-router (the backend proxy), additional steps are needed in the Go codebase under [`llm-router/`](llm-router/). See [`llm-router/docs/INTERFACE.md`](llm-router/docs/INTERFACE.md) for the protocol.

**For providers that talk directly to the upstream API (most common case), skip this layer entirely.**

---

## Checklist

- [ ] Models file in `packages/types/src/providers/<name>.ts`
- [ ] Export from `packages/types/src/providers/index.ts` + `getDefaultModelIdValue` case
- [ ] Add to `providerNames` array in `packages/types/src/provider-settings.ts`
- [ ] Create Zod schema in `packages/types/src/provider-settings.ts`
- [ ] Add to discriminated union, type spread, model fields map, and model info map
- [ ] Create handler class in `src/api/providers/<name>.ts`
- [ ] Export handler from `src/api/providers/index.ts`
- [ ] Import and add case to `buildApiHandler()` in `src/api/index.ts`
- [ ] Create provider form component in `webview-ui/src/components/settings/providers/<Name>.tsx`
- [ ] Export from providers barrel and wire into `ApiOptions.tsx`
- [ ] Add to `MODELS_BY_PROVIDER` and provider dropdown in `webview-ui/.../constants.ts`
- [ ] Add i18n keys to all 18 locale `settings.json` files
- [ ] (If proxied) Register in llm-router Go backend
- [ ] Run `pnpm check-types` and `pnpm test` to verify
