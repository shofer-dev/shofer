# Image Support in Roo Code

Roo Code supports pasting images directly into the chat input for vision-capable models. Images are converted to base64 data URLs and included in the message payload sent to the AI provider.

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

For the `vscode-lm` provider this flag is **not** hardcoded — it is sourced from llm-router via the `arkware.llm.getModelCapabilities` side-channel command (since VS Code's `LanguageModelChatProviderCapabilities` only carries `imageInput` and `toolCalling`). See [`vscode-lm.ts`](../../src/api/providers/vscode-lm.ts) `refreshArkwareCapabilities()` and [`useSelectedModel.ts`](../webview-ui/src/components/ui/hooks/useSelectedModel.ts) (`dynamicModel.arkwareCapabilities.imageInput`).

When `shouldDisableImages` is `true`:

- Pasting images is silently ignored
- Drag-dropping images is ignored
- The image button is hidden
- The placeholder text omits image instructions

The full chain:

1. Model catalog (fetcher) sets `supportsImages` per model
2. The API handler exposes `getModel().info.supportsImages`
3. The provider checks this before constructing the system prompt
4. The webview receives `shouldDisableImages` as a prop
5. [`ChatTextArea`](../webview-ui/src/components/chat/ChatTextArea.tsx) uses it to gate paste/drop/button

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

Internally, Roo Code uses Anthropic's content block format as the canonical representation. Images are represented as:

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

Roo Code converts the internal Anthropic-format image blocks to each provider's expected format:

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
- **Per-file size**: [`maxReadFileImageSize`](https://docs.roocode.com/) setting controls maximum image size for `read_file` tool

## Multi-Turn Image Handling

Images from previous user turns are preserved in the conversation history (`apiConversationHistory`). When a model supports images, past user images are included in subsequent API requests as part of the message history. When a model does NOT support images (e.g., after switching from a vision model to a non-vision model), image blocks are converted to `[Referenced image in conversation]` placeholders via [`maybeRemoveImageBlocks`](../../src/api/transform/image-cleaning.ts).

## Image Generation

Roo Code also supports **image generation** via a separate `generate_image` tool. This is documented separately in the [image generation section of the tool access docs](tool_access.md#image-generation).

Image generation uses provider-specific endpoints (not the chat completions API) and returns images that are displayed in the chat using the [`ImageViewer`](../webview-ui/src/components/common/ImageViewer.tsx) component, which supports zoom, copy, save, and Mermaid-style action buttons.

## Related Files

| File                                                                                                                 | Purpose                                                  |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [`ChatTextArea.tsx`](../webview-ui/src/components/chat/ChatTextArea.tsx)                                             | Paste, drop, and image button handlers                   |
| [`Thumbnails.tsx`](../webview-ui/src/components/common/Thumbnails.tsx)                                               | Image thumbnail display with delete                      |
| [`ImageViewer.tsx`](../webview-ui/src/components/common/ImageViewer.tsx)                                             | Full-size image viewer (generated images)                |
| [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx)                                                     | Image state management, `MAX_IMAGES_PER_MESSAGE`         |
| [`resolveImageMentions.ts`](../../src/core/mentions/resolveImageMentions.ts)                                         | Image mention resolution                                 |
| [`image-cleaning.ts`](../../src/api/transform/image-cleaning.ts)                                                     | Removal/conversion of image blocks for non-vision models |
| [`openai-format.ts`](../../src/api/transform/openai-format.ts)                                                       | Image block → OpenAI `image_url` conversion              |
| [`responses-api-input.ts`](../../src/api/transform/responses-api-input.ts)                                           | Image block → Responses API `input_image` conversion     |
| [`ChatView.preserve-images.spec.tsx`](../webview-ui/src/components/chat/__tests__/ChatView.preserve-images.spec.tsx) | Test suite for image preservation behavior               |
| [`ChatTextArea.spec.tsx`](../webview-ui/src/components/chat/__tests__/ChatTextArea.spec.tsx)                         | Test suite for textarea image behavior                   |

## Changelog History

- **v3.54.34** — VS Code LM provider: forward user-message images as `LanguageModelDataPart` (paired with llm-provider 0.6.6 which translates them to OpenAI-style `image_url` parts on the wire). Replaces the previous text-placeholder behaviour that caused models to reply 'I see an image was shared, but it's not supported by VSCode LM API'.
- **v3.52.0** — Poe provider support (new vision-capable provider)
- **v3.51.0** — CLI stdin stream image support (PR #11831)
- **v3.39.0** — Image file `@`-mention support (PR #10189)
- **v3.28.15** — Fix: show send button when only images are selected (#1140)
- **v3.28.3** — Fix: Reposition "Add Image" button inside `ChatTextArea` (#1263)
- **v3.27.0** — User message editing with image preservation
