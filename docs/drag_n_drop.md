# Drag & Drop Context Files

## Overview

Shofer allows users to attach files and folders from the Explorer panel to
the chat as `@mentions`. Dropped files appear as removable tags above the
chat input and are prepended to the message text on Send.

## Why a native TreeView?

The webview's HTML5 `drop` events are unreliable: VSCode Desktop's
cross-origin webview overlay swallows `dragstart` / `dragover` / `drop`
events at the iframe root, and the same limitation is inherited by
code-server. Even native form-control descendants do not consistently
receive these events in this runtime.

To work around this, we register a **native VSCode TreeView** as the drop
target. TreeViews use VSCode's `TreeDragAndDropController` API, which
operates outside the webview sandbox and is therefore reliable on both
Desktop and code-server.

The TreeView is registered with `"initialSize": 1` so it appears
as a single thin row at the bottom of the Shofer sidebar — minimal
visual clutter. The user drops files onto its title bar or expands
it to see the hint text.

## Architecture

```
 ┌────────────────────────────────┐
 │   VSCode Explorer (drag)       │
 └──────────────┬─────────────────┘
                │ text/uri-list
                ▼
 ┌────────────────────────────────┐    extension host
 │ ContextDropZoneProvider        │
 │   .handleDrop()                │
 │   • parses URIs                │
 │   • makes paths workspace-rel  │
 │   • posts addContextFiles      │
 └──────────────┬─────────────────┘
                │ postMessageToWebview
                ▼
 ┌────────────────────────────────┐    webview
 │ ChatView                        │
 │   case "addContextFiles":       │
 │     setDroppedContextFiles(...) │
 │   • renders removable tags      │
 │   • prepends @mentions on Send  │
 └────────────────────────────────┘
```

### Components

| Component                 | File                                                                                          | Role                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ContextDropZoneProvider` | [src/core/webview/ContextDropZoneProvider.ts](../src/core/webview/ContextDropZoneProvider.ts) | Native TreeView + `TreeDragAndDropController`. Stateless drop target — forwards files to webview. |
| `ChatView`                | [webview-ui/src/components/chat/ChatView.tsx](../webview-ui/src/components/chat/ChatView.tsx) | Owns the `droppedContextFiles` React state, renders tags, converts to `@mentions` on Send.        |
| `addContextFiles` message | [packages/types/src/vscode-extension-host.ts](../packages/types/src/vscode-extension-host.ts) | Host → webview message carrying `Array<{path, isFile}>`.                                          |
| View contribution         | [src/package.json](../src/package.json) (`shofer.contextDropZone`, `initialSize: 1`)          | Registers the drop-zone TreeView in the Shofer activity-bar container.                            |

## Data flow

1. User drags files from the VSCode Explorer onto the **"Drop Files for
   Context"** view in the Shofer sidebar.
2. `ContextDropZoneProvider.handleDrop` parses the `text/uri-list`
   payload, converts each URI to a workspace-relative path, and posts an
   `addContextFiles` message to the webview.
3. `ChatView` receives the message, dedupes against the existing
   `droppedContextFiles` state, and re-renders the tag list.
4. The user clicks Send; `ChatView` prepends `@/path1 @/path2 ...` to the
   message text and clears the tag list.

## UI

- **Drop Files for Context** — a native VSCode TreeView, registered
  with `"initialSize": 1` in the Shofer sidebar so it appears as
  a minimal row. Contains a single hint row ("Drag files here to add
  to chat context"). Holds no state.
- **File tags** — rendered above the chat input. Each tag has a remove
  (×) button; a "clear all" button removes them all.
- **Status bar** — a brief "Added N files to chat context" message is
  shown for 2 seconds on each successful drop.

## Webview drop handlers

There are two additional drop handlers inside the webview:

- **`ChatView` root** (`handleWebviewDrop`) — a handler on the iframe
  root. VSCode Desktop's cross-origin webview overlay swallows these
  events, so this path effectively never fires on Desktop. It is kept
  as a fallback for runtimes that do deliver root-level drag events.

- **`ChatTextArea` container** (`handleDrop` via `onDrop`) — a handler
  on the native form-control textarea container. This is the only
  webview-side drop path that fires reliably on VSCode Desktop,
  because the overlay does deliver events to form-control descendants.
  It forwards parsed entries to `ChatView`'s `droppedContextFiles` state
  via the `onContextFilesDropped` callback, sharing the same
  `extractUriPayload` / `parseDroppedUris` parser used by the native
  TreeView.

Both handlers delegate to the same `droppedContextFiles` React state,
ensuring consistent behavior regardless of which path processes the drop.
