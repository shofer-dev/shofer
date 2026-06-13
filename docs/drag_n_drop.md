# Drag & Drop Context Files

## Overview

Shofer allows users to attach files and folders from the Explorer panel to
the chat as `@mentions`. Dropped files appear as removable tags above the
chat input and are prepended to the message text on Send.

## Why a native TreeView?

The webview's HTML5 `drop` events are unreliable on Desktop. VSCode Desktop
renders the webview as a **cross-origin `<iframe>` inside an Electron
`<webview>`**, and Electron's security model breaks DOM drag & drop there in
two ways:

1. **`dataTransfer.getData()` is sanitized to empty** for cross-origin frames.
   The `dragover` / `drop` events still fire and `dataTransfer.types` may even
   be populated, but every `getData()` call returns `""` — so the payload can
   never be read inside the webview.
2. **`File.path` was removed** from webview `File` objects (recent Electron),
   so even when `dataTransfer.files` is populated (OS-file drags), only the
   file _name_ is available, not the absolute path needed to build an
   `@mention`. Only image content survives (read via `FileReader`).

> **code-server / VSCode Web behave differently.** Both breakages above are
> **Electron-specific**, not generically "cross-origin." code-server runs in a
> real browser, where the HTML drag-data store _is_ readable during the `drop`
> event (the spec's "protected mode" only blocks `getData()` during
> `dragenter`/`dragover`, not `drop`). So on code-server the **webview-root
> handler** ([`ChatView.handleWebviewDrop`](../webview-ui/src/components/chat/ChatView.tsx:876))
> fires on the **main chat window** — you can drop directly onto it, not just
> onto the TreeView. The code's own comments confirm this: the root handler
> "works on code-server / VSCode Web," while the overlay that swallows
> root-level events is described as Desktop-only. (Caveat: the `cwd` bug in
> "Known issues" #3 still applies, so paths come out absolute; and OS-file
> drags into the browser still yield no usable path — only VSCode-internal
> drags carry `text/uri-list`.)
>
> Because of this, the TreeView is **not registered in web**: `extension.ts`
> only calls `createTreeView` when `vscode.env.uiKind === vscode.UIKind.Desktop`,
> and the view contribution carries `"when": "!isWeb"` so it is hidden in
> code-server / VSCode Web. The chat webview's drop handler covers web there.

To work around the **Desktop** limitation, we register a **native VSCode
TreeView** as the drop target. TreeViews use VSCode's `TreeDragAndDropController` API, whose
`handleDrop` runs in the **extension host** (outside the webview sandbox) and
reads the payload via `dataTransfer.get("text/uri-list").asString()` — not
subject to the sanitization above. It is therefore the only reliable in-app
drop target on Desktop.

> **Important caveat:** a `TreeDragAndDropController` only receives drags that
> **originate inside VSCode** (the Explorer or an editor tab). Files dragged
> from the **OS file manager** (Finder / Windows Explorer / desktop) are _not_
> delivered to a custom tree's `handleDrop` at all. The only native target
> that accepts OS-file drops is VSCode's own Explorer — drop there first, then
> use the Explorer right-click command (below) or drag from the Explorer into
> the drop zone.

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

## Shared URI parsers

All three drop paths (native TreeView, ChatView root, ChatTextArea
container) share the same URI parsing logic via
[`webview-ui/src/utils/droppedContextFiles.ts`](../webview-ui/src/utils/droppedContextFiles.ts):

| Export               | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `DroppedContextFile` | Type: `{ path: string, isFile: boolean }`                          |
| `extractUriPayload`  | Extracts a URI-list string from a `DataTransfer` object, probing   |
|                      | `text/uri-list`, `text/plain`, and `application/vnd.code.uri-list` |
|                      | MIME types in that order.                                          |
| `parseDroppedUris`   | Parses newline-separated URI strings into `DroppedContextFile[]`,  |
|                      | resolving workspace-relative paths and deduplicating.              |

The native TreeView uses its own `addUrisToContext` helper (in
`ContextDropZoneProvider.ts`) which duplicates the URI-parsing logic
but also adds the `stat()` best-effort `isFile` detection and the
status-bar message.

## Per-task scoped state

`droppedContextFiles` is scoped per task. When the user switches
tasks, `ChatView` saves the current task's state into a
`taskScopedState` map (keyed by `taskId`) and restores the
incoming task's state — including `droppedContextFiles`. This
prevents file tags from one task leaking into another, and
preserves tags per task across task switches.

## Troubleshooting: "drag & drop doesn't work on Desktop"

The three drop paths behave very differently on Desktop. This table reflects a
full trace of the live code (2026-06-13):

| Path                                                       | Runs in        | Fires on Desktop?                            | Recovers correct path?              | Logging    |
| ---------------------------------------------------------- | -------------- | -------------------------------------------- | ----------------------------------- | ---------- |
| **Native TreeView** (`ContextDropZoneProvider.handleDrop`) | extension host | ✅ for VSCode-internal drags only            | ✅ via `provider.cwd`               | ❌ none    |
| **Textarea** (`ChatTextArea.handleDrop`)                   | webview        | ⚠️ event fires, `getData()` usually stripped | ⚠️ no — `cwd` never passed (see #3) | ✅ verbose |
| **Webview root** (`ChatView.handleWebviewDrop`)            | webview        | ❌ swallowed by the overlay                  | ❌ no — `window.CWD` unset (see #3) | ✅ verbose |

### Diagnosis steps

1. **Identify the drag source.** OS file manager → only VSCode's Explorer can
   accept it (see the caveat under "Why a native TreeView?"). VSCode Explorer
   or an editor tab → the native TreeView should accept it.
2. **Enable webview logging.** Drop logs are emitted at **info** level under
   the **"webview"** category (`webviewLog` is handled in
   [`webviewMessageHandler.ts:565`](../src/core/webview/webviewMessageHandler.ts:565)).
   If Settings → Logging is at `warn`/`error`, or the webview category is off,
   these logs are invisible — set it to `info`/`debug` first.
3. **Drop on the chat input box** and look for `[drop:textarea] fired … types=[…] payloads={…}`.
   If `types` is non-empty but `payloads` is `{}`, that confirms the Electron
   `getData()` sanitization — the webview path **cannot** work on Desktop, and
   the native TreeView (or the Explorer command) is the only option.
4. **Fall back to the Explorer command.** Right-click in the Explorer →
   _Add to Shofer Context_ (`shofer.addFilesToContext`,
   [`extension.ts:303`](../src/extension.ts:303)) bypasses drag entirely and
   uses the correct-`cwd` code path. This is the most reliable route on Desktop.

## Known issues (confirmed)

These are concrete defects found tracing the code, in rough priority order for
fixing the Desktop experience:

1. **The drop zone is physically un-hittable.** The TreeView is registered with
   `"initialSize": 1` ([`src/package.json`](../src/package.json), the
   `shofer.contextDropZone` view) — a ~1px sliver beneath the chat webview. A
   `TreeDragAndDropController` only fires `handleDrop` when the drop lands on the
   tree's rows, and there is effectively no row to hit. This alone can make every
   attempt silently miss. **Fix idea:** give it a usable `initialSize`, or make
   the view expand/highlight while a drag is in progress.

2. **The native path has zero logging.**
   [`ContextDropZoneProvider.handleDrop`](../src/core/webview/ContextDropZoneProvider.ts:124)
   emits nothing, so the one path expected to work on Desktop is completely
   unobservable. **Fix idea:** enumerate the dropped `dataTransfer` MIME types
   and the parsed URI count via `webviewLog`, mirroring the webview handlers.

3. **`cwd` is never wired into either webview drop path**, so even a _successful_
   webview drop emits **absolute** paths instead of workspace-relative
   `@/path` mentions (the `if (cwd && …)` branch in
   [`parseDroppedUris`](../webview-ui/src/utils/droppedContextFiles.ts:79) is
   skipped):

    - `ChatTextArea` is rendered **without a `cwd` prop**
      ([`ChatView.tsx:2375`](../webview-ui/src/components/chat/ChatView.tsx:2375));
      inside, `cwd` is `undefined`.
    - `handleWebviewDrop` reads `(window as any).CWD`
      ([`ChatView.tsx:888`](../webview-ui/src/components/chat/ChatView.tsx:888)),
      but **`window.CWD` is never assigned anywhere** in the codebase.

    Only the native TreeView path (`addUrisToContext`, using `provider.cwd`,
    [`ContextDropZoneProvider.ts:35`](../src/core/webview/ContextDropZoneProvider.ts:35))
    produces correct relative paths.

4. **`dropMimeTypes` advertises only `text/uri-list`.** The native controller
   declares `dropMimeTypes = ["text/uri-list"]`
   ([`ContextDropZoneProvider.ts:104`](../src/core/webview/ContextDropZoneProvider.ts:104)).
   `handleDrop` is only invoked when an advertised type is present; some VSCode
   builds deliver internal drags under additional MIME types
   (`application/vnd.code.tree.*`, `resourceurls`). The webview-side
   [`extractUriPayload`](../webview-ui/src/utils/droppedContextFiles.ts:23)
   already probes seven candidate types, but the native controller does not.
   **Fix idea:** advertise the extra types so `handleDrop` fires and can at
   least log the payload for diagnosis.

## Documentation gaps (lower priority)

- **Architecture diagram is incomplete**: it shows only the native TreeView →
  ChatView path. The ChatTextArea and webview-root handlers, and the shared
  `droppedContextFiles.ts` module, are not represented.

- **No test coverage for the native path**: the `ChatTextArea` handler has tests in
  [`ChatTextArea.spec.tsx`](../webview-ui/src/components/chat/__tests__/ChatTextArea.spec.tsx)
  (path drops, empty lines, image drops, long paths, special characters,
  outside-workspace paths), but the native `ContextDropZoneProvider` and the
  `droppedContextFiles.ts` parser have no dedicated tests.

- **`ShoferIgnoreController` interaction unstated**: dropped files are added to
  context without filtering against `.shofer/shoferignore`. (Note:
  `ShoferIgnoreController` is now widely wired across the codebase — see
  `settings_overlay.md` — so this is a genuine missing integration in the drop
  path, not merely a doc omission.)

- **No light/dark theme screenshot** of the drop zone in the sidebar.
