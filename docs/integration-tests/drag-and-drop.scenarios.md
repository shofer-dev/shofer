# Integration Tests: Drag & Drop Context Files

> Feature docs: [`docs/drag_n_drop.md`](../docs/drag_n_drop.md),
> [`docs/user-manual/drag-and-drop.md`](../docs/user-manual/drag-and-drop.md)
> Implementation: [`ContextDropZoneProvider.ts`](../src/core/webview/ContextDropZoneProvider.ts),
> [`ChatView.tsx`](../webview-ui/src/components/chat/ChatView.tsx),
> [`ChatTextArea.tsx`](../webview-ui/src/components/chat/ChatTextArea.tsx),
> [`droppedContextFiles.ts`](../webview-ui/src/utils/droppedContextFiles.ts),
> [`vscode-extension-host.ts`](../packages/types/src/vscode-extension-host.ts)

## Scenarios

### 1. Drag a single file from Explorer to the native drop zone

**Given** the Shofer sidebar is open and the "Drop Files for Context" view is visible
**When** the user drags a single file from the Explorer onto the drop zone
**Then** `ContextDropZoneProvider.handleDrop` receives a `text/uri-list` payload
**And** `addUrisToContext` converts the URI to a workspace-relative path
**And** a `postMessageToWebview({ type: "addContextFiles", contextFiles: [{ path, isFile: true }] })` is sent
**And** the status bar shows "Added 1 file to chat context" for 2 seconds

**Verification**: Assert the `addContextFiles` message reaches the webview.
Assert `contextFiles[0].path` is a valid relative POSIX path starting with `/`.

### 2. Drag multiple files at once

**Given** the drop zone is visible
**When** the user selects 3 files in the Explorer and drags them together
**Then** `addUrisToContext` processes all 3 URIs
**And** the `addContextFiles` message carries 3 entries
**And** the status bar shows "Added 3 files to chat context"

**Verification**: Assert `contextFiles.length === 3`. Assert each entry has
a unique `path`.

### 3. Drag a folder

**Given** the drop zone is visible
**When** the user drags a folder from the Explorer
**Then** `addUrisToContext` calls `vscode.workspace.fs.stat(uri)` to determine file type
**And** the resulting entry has `isFile: false`
**And** the tag renders with a folder icon

**Verification**: Assert the generated `DroppedContextFile` has
`isFile === false` and `path` ends with the folder name (no trailing slash).

### 4. Drop zone handles empty payloads gracefully

**Given** the drop zone is active
**When** the user drops something that is not a file (e.g., text from a browser)
**Then** `dataTransfer.get("text/uri-list")` returns `undefined`
**And** `handleDrop` returns without calling `addUrisToContext`

**Verification**: Assert no `addContextFiles` message is posted to the webview.
Assert no status-bar message appears.

### 5. ChatView merges dropped files into tags and deduplicates

**Given** `droppedContextFiles` state already contains `[{ path: "/src/a.ts", isFile: true }]`
**When** an `addContextFiles` message arrives with `[{ path: "/src/a.ts", isFile: true }, { path: "/src/b.ts", isFile: true }]`
**Then** `setDroppedContextFiles` merges by path, skipping the duplicate `/src/a.ts`
**And** the resulting state is `[{ path: "/src/a.ts", isFile: true }, { path: "/src/b.ts", isFile: true }]`

**Verification**: Assert `droppedContextFiles.length === 2`. Assert the
original entry for `a.ts` is preserved (not replaced by the new one).

### 6. Remove a single file tag

**Given** `droppedContextFiles` has 3 entries
**When** the user clicks the (×) button on the second tag
**Then** that entry is removed from `droppedContextFiles`
**And** the remaining 2 tags re-render

**Verification**: Assert `droppedContextFiles.length === 2`. Assert the
removed path is absent from the array.

### 7. "Clear all" removes all tags

**Given** `droppedContextFiles` has 3 entries
**When** the user clicks "Clear all"
**Then** `droppedContextFiles` is set to `[]`

**Verification**: Assert `droppedContextFiles.length === 0`.

### 8. Tags are converted to @mentions on Send

**Given** `droppedContextFiles` is `[{ path: "/src/a.ts", isFile: true }, { path: "/src/utils", isFile: false }]`
**When** the user clicks Send
**Then** `getDroppedMentions()` produces `@/src/a.ts @/src/utils`
**And** this is prepended to the user's message text
**And** `droppedContextFiles` is cleared to `[]`

**Verification**: Assert the sent message text starts with the @mention string.
Assert `droppedContextFiles` is empty after send.

### 9. Tags are scoped per task (no leakage)

**Given** Task A has `droppedContextFiles` with 2 entries
**When** the user switches to Task B (which has 0 entries)
**Then** `droppedContextFiles` state is restored from `taskScopedState[taskB_id]` → `[]`
**And** Task A's entries are saved into `taskScopedState[taskA_id]`
**When** the user switches back to Task A
**Then** `droppedContextFiles` is restored to Task A's 2 entries

**Verification**: Assert `droppedContextFiles` reflects the correct task
after each switch. Assert no cross-contamination between tasks.

### 10. Right-click "Add to Shofer Context" has same effect as drag

**Given** the user selects 2 files in the Explorer and right-clicks → "Add to Shofer Context"
**Then** `shofer.addFilesToContext` command fires
**And** `addUrisToContext` processes the selected URIs
**And** the same `addContextFiles` message is posted to the webview
**And** the status bar shows "Added 2 files to chat context"

**Verification**: Assert the webview receives `addContextFiles` with the
same payload shape as a native TreeView drop. Assert the resulting
`droppedContextFiles` state is identical to the drag path.

### 11. ChatTextArea drop handler forwards to ChatView

**Given** the ChatTextArea input is visible
**When** the user drops a file from the OS file manager onto the textarea
**And** the drop carries a `text/uri-list` payload
**Then** `handleDrop` extracts the payload via `extractUriPayload`
**And** calls `parseDroppedUris(payload, cwd, [])` to resolve workspace-relative paths
**And** calls `onContextFilesDropped(newFiles)` to forward to ChatView

**Verification**: Assert `onContextFilesDropped` is called with the parsed
entries. Assert the `droppedContextFiles` state in ChatView is updated.

### 12. ChatTextArea ignores non-URI drops

**Given** the ChatTextArea input is visible
**When** the user drops a file that is an image (PNG/JPEG/WebP)
**Then** `extractUriPayload` returns `null` (image files carry a `files` list, not a URI payload)
**And** `handleDrop` falls through to the image handling path
**And** `onContextFilesDropped` is NOT called

**Verification**: Assert `onContextFilesDropped` was not invoked. Assert
`selectedImages` was updated if the model supports images.

### 13. ChatView root drop handler is present but effectively dead on Desktop

**Given** the ChatView webview is loaded
**When** running on VSCode Desktop
**Then** `handleWebviewDrop` is registered on the webview root element
**And** the cross-origin webview overlay blocks drag events from reaching it
**And** `handleWebviewDrop` receives no events

**Verification**: Assert that on Desktop, file drops produce no `[drop:root]`
log entries in the webview output channel. Assert that drops still work via
the ChatTextArea path (scenario 11) or the native TreeView path (scenario 1).

### 14. Wired but unused: ShoferIgnoreController integration

**Given** a `.shoferignore` file exists excluding `**/*.generated.ts`
**When** the user drops `src/models.generated.ts` onto the drop zone
**Then** the file is accepted unconditionally (the `ShoferIgnoreController`
is defined but not wired into the drop path)

**Verification**: Documenting the current behavior. If/when the controller
is wired, this scenario should be updated to expect the file to be rejected.

### 15. Files dropped while no task is active

**Given** no task is currently running (showing WelcomeView)
**When** the user drops a file onto the drop zone
**Then** `addUrisToContext` posts `addContextFiles` to the webview
**And** the webview receives the message but `droppedContextFiles` state
update is a no-op since ChatView is not mounted

**Verification**: Assert no error is thrown. Assert the `ShoferProvider`
still has a webview to post to (sidebar is always alive).
