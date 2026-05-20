# Working with Images in Shofer

Shofer lets you attach images to your messages so that vision-capable AI
models can see and analyze them. You can paste screenshots directly, drag
image files onto the chat, or pick files from a dialog.

Images are encoded as base64 data URLs and sent to the AI provider as part
of your message — no file uploads to a third-party image host.

---

## Attaching Images

There are three ways to add images to your message:

### 1. Paste from Clipboard

Copy an image to your clipboard (screenshot, copied from a browser, etc.)
and press **Ctrl+V** (Windows/Linux) or **⌘+V** (macOS) while your cursor
is in the chat input box.

Shofer detects the image data on the clipboard and attaches it automatically.
Supported formats: PNG, JPEG, WebP.

XXX: Screenshot of a user pressing Ctrl+V in the chat input, with an image
appearing as a small thumbnail above the input bar. Annotation: "Image
attached via clipboard paste — appears as thumbnail."

### 2. Drag & Drop

Drag an image file from your file manager (Explorer, Finder, etc.) and
drop it onto the chat text area.

You can also drag files from VS Code's Explorer panel or editor tabs,
which are resolved as file `@`-mentions rather than images.

XXX: Screenshot of a user dragging a PNG file from the OS file manager
onto the chat input area. Annotation showing the drop target highlight
and the resulting thumbnail.

### 3. File Picker

Click the 🖼️ button in the bottom-right corner of the chat input box. This
opens your operating system's file picker dialog where you can select one
or more image files.

The 🖼️ button only appears when the selected AI model supports vision
(see [Model-Aware Gating](#model-aware-gating)).

XXX: Screenshot of the chat input bar with the 🖼️ button highlighted.
Inset: the OS file picker dialog showing PNG/JPEG files being selected.

---

## Viewing and Removing Images

### Thumbnails

Each attached image appears as a small thumbnail above the mode and
API configuration selectors.

- **Click** a thumbnail to open the image full-size in VS Code's built-in
  image viewer.
- **Hover** over a thumbnail and click the red **×** to remove it.

Images persist across mode changes, API configuration switches, and even
task switches — they stay in the input until you remove them or send the
message.

XXX: Screenshot showing the thumbnail strip with 3 images attached.
Highlight the red × button on hover and the click-to-open behavior.

### Image Generation Results

When you use the `generate_image` tool, generated images appear in a
dedicated viewer that supports **zoom**, **copy to clipboard**,
**save to file**, and Mermaid-style action buttons.

XXX: Screenshot of a generated image displayed in the ImageViewer modal,
with the zoom/save/copy buttons annotated.

---

## Supported Formats

| Format   | Notes                                                     |
| -------- | --------------------------------------------------------- |
| **PNG**  | Lossless. Best for screenshots, diagrams, and UI mockups. |
| **JPEG** | Lossy. Best for photographs and natural images.           |
| **WebP** | Modern format with good compression for both types.       |

There is no built-in format conversion — send images in their native format.

---

## Model-Aware Gating

Image features are automatically enabled or disabled based on the AI model
you have selected:

| Your model supports…                       | What you see                                           |
| ------------------------------------------ | ------------------------------------------------------ |
| Vision (e.g., Claude Sonnet, GPT-4o)       | 🖼️ button visible, paste and drag-drop work            |
| No vision (e.g., older models, o1-preview) | 🖼️ button hidden, paste and drag-drop silently ignored |

When images are disabled because the model doesn't support them, the chat
placeholder text also omits instructions about attaching images.

If you switch from a vision model to a non-vision model mid-conversation,
previously sent images in the conversation history are replaced with
`[Referenced image in conversation]` placeholders so the API call doesn't
fail.

XXX: Side-by-side screenshots: (left) ChatTextArea with a vision-capable
model selected — 🖼️ button visible, placeholder mentions images. (right)
Same area with a non-vision model — 🖼️ button hidden, no image mentions.

---

## Sending Messages with Images

You can send a message with images even if you haven't typed any text —
the Send button is visible whenever text or images are present.

When you click Send, images are included alongside your text in the message
payload sent to the AI provider. The AI receives the images as part of the
conversation and can analyze their contents.

XXX: Screenshot of a conversation where the user sent an image with the
question "What does this diagram show?". The AI responds with a detailed
analysis of the diagram contents.

---

## Editing Messages with Images

When you edit a message that had images attached, the existing images are
preserved in the edit view. You can:

- **Keep** the original images — they'll be re-sent with your edited text.
- **Add more** images via paste, drag-drop, or the file picker.
- **Remove** images by hovering and clicking ×.

XXX: Screenshot of the edit message view showing preserved thumbnails
from the original message, with the text input editable above them.

---

## Image Size Limits

- **Per message**: up to **20 images** (matching the Anthropic API limit).
- **Per file** (for `read_file` tool): configurable in **Settings →
  Advanced → Max Image File Size** (default 5 MB per image).
- **Total per operation** (for `read_file` tool): configurable in
  **Settings → Advanced → Max Total Image Size** (default 20 MB).

---

## Tips

- **Screenshots work best as PNG** — the lossless format preserves text
  clarity for the model to read.
- **Keep images focused** — crop to the relevant area. Extraneous UI
  chrome or desktop backgrounds waste context window space.
- **Combine with text** — a brief question like "What does this error
  mean?" alongside a screenshot of the error dialog gets better results
  than an image alone.
