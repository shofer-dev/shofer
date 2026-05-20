# Attaching Files to Chat via Drag & Drop

Shofer lets you attach files and folders to your chat by dragging them from the
Explorer panel or using the right-click context menu. Attached files become
`@mentions` in your message — the AI sees them as part of your request.

## Two ways to attach files

### 1. Drag from the Explorer

At the bottom of the Shofer sidebar, you'll find a row labeled **"Drop Files for
Context."** Drag any file or folder from the VSCode Explorer onto this row.

<!-- XXX Screenshot: The Shofer sidebar with the Explorer visible on the left.
An arrow overlay should show files being dragged from the Explorer tree onto the
"Drop Files for Context" row at the bottom of the Shofer sidebar. The row should
be highlighted/active to show it's a valid drop target. -->

- **You don't need to expand the view first** — dropping directly onto the title
  bar works.
- Dragging the **same file twice** is harmless — duplicates are automatically
  ignored.
- Both files and folders are accepted.

After a successful drop, the status bar briefly shows "Added N files to chat
context."

### 2. Right-click in the Explorer (no drag)

Select one or more files or folders in the Explorer, right-click, and choose
**"Add to Shofer Context."**

<!-- XXX Screenshot: VS Code Explorer with several files selected, the
right-click context menu open, and "Add to Shofer Context" highlighted in
the menu. -->

This has the same effect as dragging — the files appear as tags above the
chat input.

## File tags

Once files are attached, they appear as **removable tags** above the chat
input.

<!-- XXX Screenshot: The ChatView input area with 3-4 file tags shown above the
text input. Each tag should show a file/folder icon, the relative path, and
a small (×) remove button. A "Clear all" link/button should be visible to
the right of the tags. -->

Each tag shows:

- A file or folder icon (folders have a distinct icon).
- The **workspace-relative path** (e.g., `src/utils/auth.ts`).
- A **remove button** (×) to remove that specific file.

To the right of the tags, a **"Clear all"** button removes every file at once.

## What happens when you send

When you press Send, Shofer automatically prepends the files as `@mentions` to
your message. For example:

```
@/src/utils/auth.ts @/src/middleware/session.ts

Can you review these files for security issues?
```

<!-- XXX Screenshot: ChatView showing a sent message with @mentions prepended
above the user's typed text. The file tags above the input should be cleared
(no longer visible). The @mentions in the chat bubble should be styled as
clickable links. -->

The file tags are cleared from the chat input once the message is sent.

## Per-task file tags

Each task remembers which files you attached to it. If you switch to a
different task, that task's files are restored when you switch back. Files
attached to one task never leak into another.

## Tips

- **Drop onto the busy indicator**: Even while Shofer is processing, you can
  still drop files to attach them to the current task.
- **Use the context menu for precision**: The right-click method is useful
  when the Explorer and Shofer sidebar are far apart or on different monitors.
- **Folders**: Dropping a folder includes its path as a mention — the AI uses
  it as a directory reference.
- **Status bar confirmation**: After each drop, the status bar briefly confirms
  how many files were added. No confirmation means the drop didn't register
  (try again or use the right-click method).
