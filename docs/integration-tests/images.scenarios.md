# Integration Tests: Image Support

> Feature docs: [`docs/images.md`](../docs/images.md),
> [`docs/user-manual/images.md`](../docs/user-manual/images.md)
> Implementation: [`ChatTextArea.tsx`](../webview-ui/src/components/chat/ChatTextArea.tsx),
> [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx),
> [`Thumbnails.tsx`](../webview-ui/src/components/common/Thumbnails.tsx),
> [`image-cleaning.ts`](../src/api/transform/image-cleaning.ts)

## Scenarios

### 1. Clipboard paste attaches PNG image

**Given** the user has a PNG image on the system clipboard
**When** the user presses Ctrl+V (or ⌘+V) with focus in ChatTextArea
**And** the selected model has `supportsImages: true`
**Then** `handlePaste` reads the clipboard data as an `image/png` MIME type
**And** a `FileReader` converts it to a `data:image/png;base64,...` URL
**And** the data URL is appended to `selectedImages`
**And** `Thumbnails` re-renders showing the new image

**Verification**: Inspect `extensionState.selectedImages`; assert
`length` increased by 1. Assert the new entry starts with `data:image/png;base64,`.

### 2. Clipboard paste is ignored when model lacks vision support

**Given** the user has an image on the system clipboard
**And** the selected model has `supportsImages: false` (or `shouldDisableImages` is `true`)
**When** the user presses Ctrl+V in ChatTextArea
**Then** `handlePaste` detects `shouldDisableImages === true` and returns early
**And** the paste falls through to the browser's default text-paste behavior
**And** `selectedImages` is unchanged

**Verification**: Assert `selectedImages.length` is unchanged after paste.
Assert no `FileReader.readAsDataURL()` was invoked.

### 3. Drag-drop image file attaches as data URL

**Given** the user drags a `.png` file from the OS file manager
**When** the user drops it onto the ChatTextArea
**And** `shouldDisableImages` is `false`
**Then** `handleDrop` detects `image/png` in `e.dataTransfer.types`
**And** the file is read via `FileReader.readAsDataURL()`
**And** the resulting data URL is appended to `selectedImages`

**Verification**: Assert `selectedImages` contains the new data URL.
Assert `onContextFilesDropped` was NOT called (image drops go to selectedImages,
not context files).

### 4. Drag-drop of non-image file (e.g., `.ts` from Explorer) is forwarded as context file

**Given** the user drags a `.ts` file from the VS Code Explorer panel
**When** the user drops it onto the ChatTextArea
**Then** `handleDrop` does not detect image MIME types
**And** the payload is parsed via `extractUriPayload` / `parseDroppedUris`
**And** `onContextFilesDropped` is called with the parsed file entries
**And** `selectedImages` is unchanged

**Verification**: Assert `onContextFilesDropped` was called once.
Assert `selectedImages.length` is unchanged.

### 5. File picker button opens OS dialog and attaches selected images

**Given** `shouldDisableImages` is `false`
**When** the user clicks the 🖼️ button in ChatTextArea
**Then** `onSelectImages` posts `{ type: "selectImages" }` via `vscode.postMessage`
**And** the extension host opens the OS file picker dialog
**And** the selected files' data URLs are posted back via `{ type: "selectedImages", images: [...] }`
**And** `ChatView` appends them to `selectedImages`, capped at `MAX_IMAGES_PER_MESSAGE`

**Verification**: Assert the `postMessage` call with `type: "selectImages"`.
After the round-trip, assert `selectedImages` contains the expected data URLs.

### 6. 🖼️ button hidden when model doesn't support images

**Given** `shouldDisableImages` is `true`
**Then** the 🖼️ button renders with `opacity-0 pointer-events-none`
**And** clicking it is a no-op (the `onClick` handler is `undefined`)

**Verification**: Assert the button element has class `opacity-0` and
`onClick` is `undefined` in the rendered props.

### 7. Thumbnail click opens image in VS Code viewer

**Given** `selectedImages` contains `["data:image/png;base64,..."]`
**And** `Thumbnails` renders the thumbnail
**When** the user clicks the thumbnail
**Then** `handleImageClick` posts `{ type: "openImage", text: "data:image/png;base64,..." }`
**And** the extension host opens the image in VS Code's built-in image viewer

**Verification**: Assert `vscode.postMessage` was called with `type: "openImage"`
and the correct data URL.

### 8. Thumbnail hover shows delete button and click removes image

**Given** `Thumbnails` renders one thumbnail at index 0
**When** the user hovers over the thumbnail
**Then** the red × button appears
**When** the user clicks the × button
**Then** `handleDelete(0)` is called
**And** the image at index 0 is removed from `selectedImages`
**And** `Thumbnails` re-renders without that image

**Verification**: Assert `selectedImages.length` decreased by 1.
Assert the removed image URL is no longer in the array.

### 9. Send button visible when only images are attached (no text)

**Given** `inputValue` is `""` (empty string)
**And** `selectedImages.length > 0`
**Then** `hasInputContent` is `true` (computed via `inputValue.trim().length > 0 || selectedImages.length > 0`)
**And** the Send button is visible and enabled

**Verification**: Assert `hasInputContent === true`. Assert the Send button
does not have `opacity-0` class.

### 10. Images included in sendMessage payload to extension host

**Given** `selectedImages` contains 2 data URLs and `inputValue` is "What are these?"
**When** the user clicks Send
**Then** `handleSendMessage` posts `{ type: "sendMessage", text: "What are these?", images: [...] }`
**And** the extension host's message handler merges images into the user message content blocks

**Verification**: Assert the posted message has `images.length === 2` and the
array contents match `selectedImages`.

### 11. Image cleaning: non-vision model converts images to placeholders

**Given** `apiConversationHistory` contains a user message with an image block
**And** the current model has `supportsImages: false`
**When** the message is sent to the provider
**Then** `maybeRemoveImageBlocks()` replaces the image block with a text block
**And** the text content is `"[Referenced image in conversation]"`

**Verification**: Inspect the transformed `ApiMessage[]` before `createMessage()`.
Assert no `type: "image"` blocks remain. Assert a `type: "text"` block with
`text: "[Referenced image in conversation]"` is present.

### 12. Image preservation across task switches

**Given** Task A has `selectedImages = ["data:image/png;base64,..."]`
**When** the user switches to Task B
**And** then switches back to Task A
**Then** Task A's `selectedImages` are restored from the per-task draft snapshot
**And** the thumbnails re-render with the previously attached image

**Verification**: After switching back to Task A, assert `selectedImages`
matches the snapshot taken before the switch.

### 13. Editing a message preserves existing images

**Given** a sent message has `message.images = ["data:image/png;base64,..."]`
**When** the user clicks Edit on that message
**Then** `ChatRow` enters edit mode with `editImages` initialized from `message.images`
**And** `Thumbnails` renders showing the preserved images
**When** the user clicks Save
**Then** the edited message payload includes both the new text and the original `editImages`

**Verification**: Assert `editImages` matches `message.images` on entering edit mode.
After Save, assert the posted `editMessageConfirm` includes `images: editImages`.

### 14. vscode-lm provider sources `supportsImages` dynamically

**Given** the selected provider is `"vscode-lm"`
**And** the Shofer LLM Model Provider extension is installed and active
**When** model selection changes
**Then** `refreshShoferCapabilities()` calls `shofer.llm.getModelCapabilities`
**And** `supportsImages` is set from `shoferCapabilities.imageInput`
**And** the webview receives `shouldDisableImages` based on this dynamic value

**Verification**: Mock the `vscode.commands.executeCommand` response for
`"shofer.llm.getModelCapabilities"` with `{ imageInput: true }`. Assert
`supportsImages` resolves to `true` in the webview `useSelectedModel` hook.

### 15. MAX_IMAGES_PER_MESSAGE cap enforced during paste

**Given** `selectedImages` already contains 20 images (the `MAX_IMAGES_PER_MESSAGE` cap)
**When** the user pastes another image
**Then** `handlePaste` detects `selectedImages.length >= MAX_IMAGES_PER_MESSAGE`
**And** the new image is silently dropped
**And** `selectedImages` remains at 20

**Verification**: Assert `selectedImages.length` is 20 after paste.
Assert no `FileReader.readAsDataURL()` was invoked for the pasted data.

### 16. Drag & drop not swallowed by VS Code Desktop webview overlay

**Given** the VS Code Desktop webview environment with cross-origin iframe
**When** the user drags an image file over the webview
**Then** the drag event only fires reliably on the ChatTextArea container
**And** the webview-root drop handler (for the drag overlay) respects this limitation

**Verification**: In a Desktop VS Code environment, drag an image file onto
the ChatTextArea. Assert the drop handler fires. Drag the same file onto the
webview outside the textarea — assert no image attachment occurs.
