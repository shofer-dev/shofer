# Drag & Drop Context Files

## Overview

Roo Code allows users to drag files and folders from the Explorer panel directly into the webview to add them as context. The entire webview acts as a drop zone — dropped files appear as removable tags and are converted to `@mentions` automatically when the message is sent.

## Architecture

The drag & drop feature is implemented directly in the webview using HTML5 drag-and-drop events. The root `ChatView` div listens for `dragover`, `dragleave`, and `drop` events, parsing file URIs and maintaining a list of dropped context files.

### Key Components

| Component  | File                                                                                               | Purpose                                              |
| ---------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ChatView` | [`webview-ui/src/components/chat/ChatView.tsx`](../../webview-ui/src/components/chat/ChatView.tsx) | Root drop zone, file tag display, mention generation |

### Data Flow

```
┌──────────────┐     drop      ┌─────────────────┐
│   Explorer   │──────────────▶│    ChatView      │
│  (files)     │  text/uri-list│  (webview root)  │
└──────────────┘               └────────┬────────┘
                                        │
                              files stored as tags
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  handleSendMessage│
                               │                  │
                               │  Prepend @mentions│
                               │  to message text  │
                               └─────────────────┘
```

1. User drags files from VSCode Explorer anywhere onto the webview
2. `ChatView.handleWebviewDrop()` receives the URI list, converts to workspace-relative paths
3. Dropped files are displayed as removable tags above the text area
4. When the user clicks Send, `handleSendMessage` converts tags to `@path` mentions and prepends them to the message

## UI Elements

### Drag Overlay

When files are being dragged over the webview, a semi-transparent overlay appears with a dashed border and "Drop files to add to context" guidance text.

### File Tags

Dropped files are displayed as stylized tags (chips) above the chat input area:

- Each tag shows a file or folder icon
- Each tag has a remove (×) button
- A "clear all" button removes all tags at once

### Mentions on Send

When the user clicks Send:

1. All dropped file tags are converted to `@/relative/path` mentions
2. Mentions are prepended to the message text
3. Tags are cleared after sending

## Platform Notes

- **code-server / VSCode Web**: Drag-and-drop works natively in the webview without any limitations.
- **VSCode Desktop**: The transparent overlay that VSCode Desktop places over webviews intercepts drag events. **Hold Shift** while dropping files onto the webview to bypass the overlay — this is a platform limitation that cannot be worked around from within the webview. The webview drop-zone handlers have been hardened to work reliably when Shift is held:
    - `handleWebviewDragOver` always accepts the drop (the MIME-type gate was removed because VSCode's cross-origin iframe hides `dataTransfer.types` during `dragover`).
    - `handleWebviewDrop` tries `text/uri-list`, `text/plain`, and `application/vnd.code.uri-list` in order so that Explorer drags, tab drags, and plain-text path drops are all handled.
