# Image Support in Shofer

Shofer supports pasting images directly into the chat input for vision-capable models. Images are converted to base64 data URLs and included in the message payload sent to the AI provider.

## Adding Images to a Message

There are three ways to attach images:

### 1. Clipboard Paste (Ctrl+V / ⌘+V)

Paste an image from the clipboard directly into the chat textarea. The [`handlePaste`](../webview-ui/src/components/chat/ChatTextArea.tsx) function intercepts the paste event and:

1. Checks if the clipboard contains image data (`image/png`, `image/jpeg`, `image/webp`)
2. Reads each image as a data URL using the [`FileReader`](https://developer.mozilla.org/en-US/docs/Web/API/FileReader) API
3. Appends the image to the `selectedImages` list (capped at [`MAX_IMAGES_PER_MESSAGE`](../webview-ui/src/components/chat/ChatView.tsx))

If the clipboard has no images (or the model doesn't support them), the paste falls through to the browser's default text paste behavior.

### 2. Drag & Drop

Drag image files from the OS file manager onto the chat textarea. The [`handleDrop`](../webview-ui/src/components/chat/ChatTextArea.tsx) handler processes:

- **Image file drops** (PNG, JPEG, WebP): Read as data URLs and added to `selectedImages`
- **Path-style drops** (Explorer files, editor tabs): Forwarded via `onContextFilesDropped` for `@`-mention resolution

> **Note on Desktop vs Web**: VS Code Desktop's cross-origin webview overlay swallows drag events at the iframe root. The textarea container is the only reliable drop target on Desktop. The webview-root drop handler (for the drag overlay) only fires in browser/web environments.

### 3. File Picker Button

Click the image icon (🖼️) in the bottom-right corner of the textarea. This triggers `onSelectImages`, which opens a native OS file picker dialog.

The button is hidden (opacity 0) when:

- No input is present (text or images)
- The model doesn't support images ([`shouldDisableImages`](#model-aware-gating) is `true`)

## Supported Image Formats

| Format | MIME Type    | Notes                                            |
| ------ | ------------ | ------------------------------------------------ |
| PNG    | `image/png`  | Lossless; preferred for screenshots and diagrams |
| JPEG   | `image/jpeg` | Lossy; good for photographs                      |
| WebP   | `image/webp` | Modern format with good compression              |

## Model-Aware Gating

Images are automatically disabled when the selected model doesn't support vision input. This is controlled by the [`supportsImages`](../../src/api/providers/fetchers/vercel-ai-gateway.ts) property on each model's metadata.

For the `vscode-lm` provider this flag is **not** hardcoded — it is sourced from the active provider extension via the `shofer.router.getModelCapabilities` side-channel command (since VS Code's `LanguageModelChatProviderCapabilities` only carries `imageInput` and `toolCalling`). The command is registered by the `shofer-router` extension ([`shofer-router/src/main.ts`](../../shofer-router/src/main.ts)), which resolves per-model `imageInput` from its model registry. See [`refreshShoferCapabilities()`](../../src/api/providers/vscode-lm.ts:245) (which invokes the command at [`vscode-lm.ts:255`](../../src/api/providers/vscode-lm.ts:255)) and [`useSelectedModel.ts`](../webview-ui/src/components/ui/hooks/useSelectedModel.ts) (`dynamicModel.shoferCapabilities.imageInput`).

The lookup is **fail-closed**: if the side-channel command is unavailable (provider extension not installed, not activated, or it throws), `shoferCapabilities` is left untouched and [`supportsImages` resolves to `false`](../../src/api/providers/vscode-lm.ts:939) (`this.shoferCapabilities?.imageInput ?? false`). A vision-capable model therefore has its images stripped whenever the capability lookup cannot complete, rather than risking an API error by sending image blocks to a model whose support is unknown.

When `shouldDisableImages` is `true`:

- Pasting images is silently ignored
- Drag-dropping images is ignored
- The image button is hidden
- The placeholder text omits image instructions

The full chain:

1. Model catalog (fetcher) sets `supportsImages` per model
2. The API handler exposes `getModel().info.supportsImages`
3. The provider checks this before constructing the system prompt
4. The webview derives `shouldDisableImages` in [`ChatView.tsx:1248`](../webview-ui/src/components/chat/ChatView.tsx:1248) as `!model?.supportsImages || selectedImages.length >= MAX_IMAGES_PER_MESSAGE` — so images are gated off both when the model lacks vision support **and** once the per-message image cap is reached
5. [`ChatTextArea`](../webview-ui/src/components/chat/ChatTextArea.tsx) receives `shouldDisableImages` as a prop and uses it to gate paste/drop/button

## Image Display in the Chat

### Thumbnails

Selected images appear as small thumbnails (34×34px) above the mode/API selector, using the [`Thumbnails`](../webview-ui/src/components/common/Thumbnails.tsx) component:

- **Click**: Opens the image in VS Code's built-in image viewer via `openImage` message
- **Hover + Delete**: A red "×" button appears to remove individual images
- **Layout**: Flex-wrap with 5px gap; images persist across mode and API config changes

### Send Behavior

The send button is visible when there are images even if the text input is empty ([test reference](../webview-ui/src/components/chat/__tests__/ChatTextArea.spec.tsx)). The [`hasInputContent`](../webview-ui/src/components/chat/ChatTextArea.tsx) computation includes both text and images:

```typescript
const hasInputContent = useMemo(() => {
	return inputValue.trim().length > 0 || selectedImages.length > 0
}, [inputValue, selectedImages])
```

### Editing Messages

When editing a message with images, the [`ChatRow`](../webview-ui/src/components/chat/ChatRow.tsx) component passes existing images into a separate `ChatTextArea` instance, preserving them during the edit flow.

### Preserving Images During Chat Activity

Images in the chat box are preserved across conversation activity — they don't get cleared when the model responds or when switching tasks. See the [`ChatView.preserve-images.spec.tsx`](../webview-ui/src/components/chat/__tests__/ChatView.preserve-images.spec.tsx) test suite for the full behavior specification.

## Internal Representation

### In the Webview

Images are stored as **base64 data URLs** in the `selectedImages` state (a `string[]`). The format is:

```
data:image/png;base64,iVBORw0KGgo...
```

### In Messages

Images are sent from the webview to the extension host as part of the `images` field on messages like:

```typescript
{
    type: "sendMessage",
    text: "What is in this image?",
    images: ["data:image/png;base64,..."]
}
```

### In API Payloads (anthropic format)

Internally, Shofer uses Anthropic's content block format as the canonical representation. Images are represented as:

```typescript
{
    type: "image",
    source: {
        type: "base64",
        media_type: "image/png",
        data: "iVBORw0KGgo..."
    }
}
```

## Provider-Specific Transformations

Shofer converts the internal Anthropic-format image blocks to each provider's expected format:

| Provider                 | Image Format                                                                                                                                                                      | Transform Location                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Anthropic**            | `image` content block (native)                                                                                                                                                    | No transformation needed                                                   |
| **OpenAI**               | `image_url` with `data:image/...;base64,...` URL                                                                                                                                  | [`openai-format.ts`](../../src/api/transform/openai-format.ts)             |
| **OpenAI Responses API** | `input_image` with `image_url` + `detail: "auto"`                                                                                                                                 | [`responses-api-input.ts`](../../src/api/transform/responses-api-input.ts) |
| **AI SDK**               | `image` with `data:...` URL + `mimeType`                                                                                                                                          | [`ai-sdk.ts`](../../src/api/transform/ai-sdk.ts)                           |
| **VS Code LM**           | `vscode.LanguageModelDataPart.image(bytes, mime)` for user messages; text placeholder fallback when the API surface is unavailable or for image blocks nested inside tool results | [`vscode-lm-format.ts`](../../src/api/transform/vscode-lm-format.ts)       |
| **Gemini**               | Native multimodal support via Google AI SDK                                                                                                                                       | [`gemini-format.ts`](../../src/api/transform/gemini-format.ts)             |
| **Bedrock**              | Native Converse API image blocks                                                                                                                                                  | [`bedrock.ts`](../../src/api/providers/bedrock.ts)                         |

### Non-Vision Models

When the model does NOT support images, the [`image-cleaning.ts`](../../src/api/transform/image-cleaning.ts) module converts image blocks to text placeholders before sending to the provider:

```
[Referenced image in conversation]
```

This prevents API errors while preserving the conversational context that images were discussed.

## Image Support in Mode Prompts

When the model supports images, the system prompt includes guidance about image handling in tool descriptions:

- [`read_file` tool prompt](../../src/core/prompts/tools/native-tools/read_file.ts) includes `supportsImages` parameter
- Native tools accept a `supportsImages` option in their constructor
- The tool prompt dynamically adapts to show/hide image-related capabilities

## Image Sending Flow

```
User pastes/drops/picks image
        │
        ▼
ChatTextArea.handlePaste / handleDrop
  - Filters by MIME type (png/jpeg/webp)
  - Checks shouldDisableImages
  - FileReader.readAsDataURL()
        │
        ▼
setSelectedImages(dataUrls)
  - Capped at MAX_IMAGES_PER_MESSAGE
  - Thumbnails render below textarea
        │
        ▼
User clicks Send
        │
        ▼
handleSendMessage(text, selectedImages)
  - Images array sent via vscode.postMessage
        │
        ▼
Extension host: processUserContentMentions
  - Images included in message content blocks
  - Image mentions resolved alongside @-mentions
        │
        ▼
Task.addMessage(role: "user", content: [...text, ...image_blocks])
  - Stored in apiConversationHistory
        │
        ▼
Provider API handler
  - Transforms image blocks to provider format
  - maybeRemoveImageBlocks if model lacks vision support
        │
        ▼
Upstream AI provider
```

## Image Size Limits

- **Per-message count**: [`MAX_IMAGES_PER_MESSAGE`](../webview-ui/src/components/chat/ChatView.tsx) controls the maximum number of images per message
- **Per-file size**: [`maxImageFileSize`](../packages/types/src/global-settings.ts:170) setting controls the per-image file size limit (default 5 MB), and [`maxTotalImageSize`](../packages/types/src/global-settings.ts:171) caps the total across all images per operation (default 20 MB)

## Multi-Turn Image Handling

Images from previous user turns are preserved in the conversation history (`apiConversationHistory`). When a model supports images, past user images are included in subsequent API requests as part of the message history. When a model does NOT support images (e.g., after switching from a vision model to a non-vision model), image blocks are converted to `[Referenced image in conversation]` placeholders via [`maybeRemoveImageBlocks`](../../src/api/transform/image-cleaning.ts).

## Image Generation

Shofer also supports **image generation** via a separate `generate_image` tool. This is documented separately in the [Feature-Gated Tools section of the native tools docs](native_tools.md#feature-gated-tools).

Image generation uses provider-specific endpoints (not the chat completions API) and returns images that are displayed in the chat using the [`ImageViewer`](../webview-ui/src/components/common/ImageViewer.tsx) component, which supports zoom, copy, save, and Mermaid-style action buttons.

## `view_image` Tool (Model-Initiated Image Reading)

While the sections above describe the **user → model** image flow (user pastes/drops/picks an image), the [`view_image`](../../src/core/tools/ViewImageTool.ts) native tool handles the **model → disk** direction: the AI reads an image file from the workspace to include it in its own content for visual analysis.

### What It Does

The model calls `view_image` with a `filePath` relative to the workspace. Shofer reads the file from disk, base64-encodes it, and returns it as an [`Anthropic.ImageBlockParam`](https://docs.anthropic.com/en/docs/build-with-claude/vision#image-source) content block. The model (Claude, GPT, Gemini) then visually inspects the image in the next API request.

**Shofer itself performs no image parsing, decoding, resizing, or pixel inspection.** The tool is a thin read-and-re-encode pass-through — the downstream LLM does all visual analysis.

### Supported Formats

| Format | MIME Type    | Returned As                     |
| ------ | ------------ | ------------------------------- |
| PNG    | `image/png`  | Anthropic `ImageBlockParam`     |
| JPEG   | `image/jpeg` | Anthropic `ImageBlockParam`     |
| GIF    | `image/gif`  | Anthropic `ImageBlockParam`     |
| WebP   | `image/webp` | Anthropic `ImageBlockParam`     |
| SVG    | —            | Text-only `data:` URI (no MIME) |
| BMP    | —            | Text-only `data:` URI (no MIME) |

SVG and BMP lack standard Anthropic image MIME types, so the tool falls back to a text result containing a `data:image/svg+xml;base64,…` or `data:image/bmp;base64,…` URI string. The model receives the raw bytes but cannot visually inspect them as inline image blocks.

### Execution Flow

```
Model calls view_image(filePath)
        │
        ▼
ViewImageTool.execute(params, task, callbacks)
  - Guard: filePath missing → sayAndCreateMissingParamError
  - Guard: unsupported extension → error string
  - path.resolve(task.cwd, filePath)
  - isPathOutsideWorkspace check
        │
        ▼
askApproval("tool", completeMessage)
  - Gated by alwaysAllowReadOnly auto-approval toggle
  - Renders file path in chat as a tool row
        │
        ▼
fs.readFile(absolutePath) → Buffer
imageBuffer.toString("base64")
getImageMimeType(ext)
        │
        ▼
┌─ MIME type known (png/jpg/gif/webp):
│  pushToolResult([textBlock, imageBlock])
│  ImageBlockParam { type: "image", source: { type: "base64", media_type, data } }
│
└─ MIME type unknown (svg/bmp):
   pushToolResult("Image file: <path>\nBase64 data: data:image/<ext>;base64,<data>")
        │
        ▼
Image block enters apiConversationHistory
        │
        ▼
Next API request: provider transform converts Anthropic image block
to provider-specific format (same transformations as user images, §Provider-Specific Transformations)
        │
        ▼
Upstream AI provider visually analyzes the image
```

### Streaming (`handlePartial`)

During streaming, the tool uses [`hasPathStabilized(filePath)`](../../src/core/tools/BaseTool.ts) to gate against mid-stream path truncation. Once the path is stable, it posts a partial `"tool"` ask so the user sees a "Viewing image…" placeholder in the chat before the file is read.

### Tool Group & Auto-Approval

`view_image` belongs to [`TOOL_GROUPS.read`](../../packages/types/src/tool.ts) and is gated by the **alwaysAllowReadOnly** auto-approval toggle. It is unconditionally read-only — it never modifies files, runs commands, or accesses the network.

### Assistant Agent Variant

The assistant agent has a separate implementation in [`tool-executor.ts`](../../src/services/assistant-agent/tool-executor.ts) that returns **metadata only** (file path and size). It explicitly notes that the assistant agent cannot render images inline and suggests using context clues instead. This is because the assistant agent's cost-optimized model context does not surface multimodal content blocks.

### Relationship to User Image Input

| Aspect            | User Image Input (Paste/Drop/Pick) | `view_image` Tool              |
| ----------------- | ---------------------------------- | ------------------------------ |
| **Direction**     | User → Model                       | Model → Disk → Model           |
| **Trigger**       | User action in chat textarea       | Model emits a tool call        |
| **Source**        | Clipboard / file manager / picker  | Any file in the workspace      |
| **Approval**      | None (user initiated it)           | `alwaysAllowReadOnly` toggle   |
| **Output format** | Anthropic `ImageBlockParam`        | Same (or text `data:` URI)     |
| **Formats**       | PNG, JPEG, WebP                    | PNG, JPEG, GIF, WebP, SVG, BMP |

## Related Files

| File                                                                                                                 | Purpose                                                  |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [`ChatTextArea.tsx`](../webview-ui/src/components/chat/ChatTextArea.tsx)                                             | Paste, drop, and image button handlers                   |
| [`Thumbnails.tsx`](../webview-ui/src/components/common/Thumbnails.tsx)                                               | Image thumbnail display with delete                      |
| [`ImageViewer.tsx`](../webview-ui/src/components/common/ImageViewer.tsx)                                             | Full-size image viewer (generated images)                |
| [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)                                                     | Image state management, `MAX_IMAGES_PER_MESSAGE`         |
| [`ViewImageTool.ts`](../../src/core/tools/ViewImageTool.ts)                                                          | `view_image` native tool: model reads image files        |
| [`view_image.ts`](../../src/core/prompts/tools/native-tools/view_image.ts)                                           | JSON Schema for `view_image` tool                        |
| [`resolveImageMentions.ts`](../../src/core/mentions/resolveImageMentions.ts)                                         | Image mention resolution                                 |
| [`image-cleaning.ts`](../../src/api/transform/image-cleaning.ts)                                                     | Removal/conversion of image blocks for non-vision models |
| [`openai-format.ts`](../../src/api/transform/openai-format.ts)                                                       | Image block → OpenAI `image_url` conversion              |
| [`responses-api-input.ts`](../../src/api/transform/responses-api-input.ts)                                           | Image block → Responses API `input_image` conversion     |
| [`tool-executor.ts`](../../src/services/assistant-agent/tool-executor.ts)                                            | Assistant agent's metadata-only `_viewImage` variant     |
| [`ChatView.preserve-images.spec.tsx`](../webview-ui/src/components/chat/__tests__/ChatView.preserve-images.spec.tsx) | Test suite for image preservation behavior               |
| [`ChatTextArea.spec.tsx`](../webview-ui/src/components/chat/__tests__/ChatTextArea.spec.tsx)                         | Test suite for textarea image behavior                   |

## Gaps, Issues & Improvement Areas

- **Fixed: Phantom setting name `maxReadFileImageSize`** (line 207) — The actual settings are
  [`maxImageFileSize`](../packages/types/src/global-settings.ts:170) (per-file MB limit, default 5) and
  [`maxTotalImageSize`](../packages/types/src/global-settings.ts:171) (per-operation total MB limit, default 20).
  The `read_file` tool does not reference its own dedicated size constant; it uses the global settings.
  Both names and links are now correct.

- **Fixed: Broken cross-doc anchor `tool_access.md#image-generation`** (line 215) —
  [`tool_access.md`](tool_access.md) contains no `image-generation` section and never mentions
  `generate_image`. The tool is documented under the **Feature-Gated Tools** section of
  [`native_tools.md`](native_tools.md#feature-gated-tools) (line 530). Corrected.

- **Flow diagram simplifications** — The "Image Sending Flow" diagram mentions
  `Task.addMessage(role: "user", content: [...])` and `possiblyRemoveImageBlocks` as
  distinct steps. The actual implementation routes through
  [`messageQueueService.addMessage()`](../src/core/message-queue/MessageQueueService.ts:36)
  and the provider-specific transform modules. The diagram is conceptually correct but uses
  simplified function names that don't correspond to exact source identifiers.

- **Missing coverage** — The doc describes three image input methods (paste, drag-drop, file picker)
  but does not cover image `@`-mention resolution (the `@`-mention flow that resolves file paths
  to image data URLs via [`resolveImageMentions`](../src/core/mentions/resolveImageMentions.ts:60)).
  Changelog references this feature (v3.39.0) but the main body doesn't document how it works.

- **Poe provider** — The changelog entry for v3.52.0 references "Poe provider support" as a
  "new vision-capable provider." Poe may no longer be an active provider; this entry can be
  verified against the current provider catalog.

- **Verified: Thumbnails sizing** — The doc states thumbnails are "34×34px" (line 70).
  Verified against [`Thumbnails.tsx`](../webview-ui/src/components/common/Thumbnails.tsx:60–61):
  `width: 34, height: 34` inline styles — correct.

- **Capability side-channel namespace — diagnostics fixed; architecture wart remains.** The
  `vscode-lm` capability/pricing lookup invokes `shofer.router.*` commands
  ([`vscode-lm.ts`](../src/api/providers/vscode-lm.ts) `executeCommand("shofer.router.getModelCapabilities"…)`),
  registered by the **`shofer-router`** extension ([`shofer-router/src/main.ts:679-680`](../../shofer-router/src/main.ts:679)).
  Previously the doc-comments and all three catch-block warning strings inside `vscode-lm.ts` still named
  `shofer.llm.*` and "Shofer LLM Model Provider extension" (12 occurrences), so a developer debugging
  "images disabled on a vision model" saw a log naming a command the code never calls. **✅ Fixed** — the
  warnings/comments now name `shofer.router.*` / the Shofer Router extension, matching the executed command.
  **Remaining wart (not fixed here):** a **second** extension, `llm-provider`, registers the same logical
  commands under `shofer.llm.*` ([`llm-provider/src/main.ts:467,477`](../../llm-provider/src/main.ts:467)),
  and the gating setting is still named `enableLlmProviderIntegration`. Whether the canonical companion is
  `shofer-router` (what the code calls) or `llm-provider` (what the setting name and registry suggest) is an
  unresolved architectural ambiguity; if a deployment ships only `llm-provider`, the `shofer.router.*`
  lookup fails and images are stripped from vision-capable models. Consolidating the two extensions onto one
  namespace (and renaming the setting) is the proper follow-up.

## Changelog History

- **v3.54.34** — VS Code LM provider: forward user-message images as `LanguageModelDataPart` (paired with llm-provider 0.6.6 which translates them to OpenAI-style `image_url` parts on the wire). Replaces the previous text-placeholder behaviour that caused models to reply 'I see an image was shared, but it's not supported by VSCode LM API'.
- **v3.52.0** — Poe provider support (new vision-capable provider)
- **v3.51.0** — CLI stdin stream image support (PR #11831)
- **v3.39.0** — Image file `@`-mention support (PR #10189)
- **v3.28.15** — Fix: show send button when only images are selected (#1140)
- **v3.28.3** — Fix: Reposition "Add Image" button inside `ChatTextArea` (#1263)
- **v3.27.0** — User message editing with image preservation
