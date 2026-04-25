# Drag & Drop Context Files

## Overview

Roo Code provides a native VSCode TreeView drop zone that allows users to drag files and folders from the Explorer panel directly into the chat context. This approach bypasses VSCode Desktop's webview drag overlay limitation, which normally requires holding Shift to drop files into a webview.

## Architecture

The drag & drop feature is implemented as a native TreeView rather than relying on webview HTML5 drag events. This is necessary because VSCode Desktop renders webviews in an iframe with a transparent overlay that intercepts all mouse events, making standard webview drag & drop unreliable.

### Key Components

| Component                 | File                                                                                               | Purpose                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ContextDropZoneProvider` | [`src/core/webview/ContextDropZoneProvider.ts`](../../src/core/webview/ContextDropZoneProvider.ts) | TreeDataProvider + DragAndDropController for the drop zone            |
| `ChatView`                | [`webview-ui/src/components/chat/ChatView.tsx`](../../webview-ui/src/components/chat/ChatView.tsx) | Handles `droppedContextFiles` and `removeContextFileMention` messages |
| Extension manifest        | [`src/package.json`](../../src/package.json)                                                       | View contribution, commands, and menu registrations                   |

### Data Flow

```
┌──────────────┐     drop      ┌─────────────────────────┐
│   Explorer   │──────────────▶│  ContextDropZoneProvider │
│  (files)     │  text/uri-list│  (native TreeView)       │
└──────────────┘               └────────────┬────────────┘
                                            │
                                   postMessage(paths)
                                            │
                                            ▼
                                   ┌─────────────────┐
                                   │    ChatView      │
                                   │  (webview)       │
                                   │                  │
                                   │  setInputValue() │
                                   │  @path1 @path2   │
                                   └─────────────────┘
```

1. User drags files from VSCode Explorer onto the "Drop Files Here" TreeView
2. `ContextDropZoneProvider.handleDrop()` receives the URI list, converts to workspace-relative paths
3. Provider sends `droppedContextFiles` message to webview with the paths
4. `ChatView` appends `@path` mentions to the chat input

## Message Types

Two new message types were added to [`ExtensionMessage`](../../packages/types/src/vscode-extension-host.ts):

### `droppedContextFiles`

Sent from extension to webview when files are dropped into the TreeView.

```typescript
{
  type: "droppedContextFiles",
  paths: string[]  // workspace-relative paths
}
```

### `removeContextFileMention`

Sent from extension to webview when a file is removed from the drop zone (via inline remove button or clear-all).

```typescript
{
  type: "removeContextFileMention",
  paths: string[]  // workspace-relative paths to remove from @mentions
}
```

## UI Elements

### TreeView

- **View ID**: `roo-cline.contextDropZone`
- **Title**: "Drop Files Here" (localized via `views.dropZone.name` in [`package.nls.json`](../../src/package.nls.json))
- **Location**: Activity bar (Roo Code sidebar)

### TreeView Items

- **Hint item**: Shown when no files are dropped; displays an inbox icon with guidance text
- **Dropped files**: Each file/folder shown with appropriate icon (`file` or `folder`), tooltip shows full path

### Commands

| Command   | ID                               | Description                                              |
| --------- | -------------------------------- | -------------------------------------------------------- |
| Remove    | `roo-cline.removeContextFile`    | Inline button to remove a single file from the drop zone |
| Clear All | `roo-cline.clearAllContextFiles` | Title bar button to clear all dropped files              |

## Why Not Webview Drag & Drop?

VSCode Desktop uses a transparent overlay `<div>` on top of webviews to intercept keyboard shortcuts. This overlay also captures drag events, preventing `ondrop` from firing in the webview unless the user holds Shift while dropping. This behavior is:

- **Unreliable**: The overlay behavior varies across VSCode versions
- **Undiscoverable**: Users don't know they need to hold Shift
- **Inconsistent**: Works differently on VSCode Web vs Desktop

The native TreeView approach works identically across all VSCode platforms without requiring modifier keys.

## Related Commits

- `499ac9e` - `feat(drop-zone): Add native TreeView drop zone with file list and remove capability`
- `a579235` - `Revert "fix(chat): add drag & drop handlers to textarea for VSCode webview compatibility"` (removed unreliable textarea handlers in favor of the native drop zone)
