# AGENTS.md

This file provides guidance to agents when working with code in this repository.

- Settings View Pattern: When working on `SettingsView`, inputs must bind to the local `cachedState`, NOT the live `useExtensionState()`. The `cachedState` acts as a buffer for user edits, isolating them from the `ContextProxy` source-of-truth until the user explicitly clicks "Save". Wiring inputs directly to the live state causes race conditions.

- File Change Tracking Pattern: Any new native tool that modifies workspace files MUST call both `task.fileContextTracker.captureOriginal(relPath, content)` before mutation and `task.fileContextTracker.trackFileContext(relPath, "shofer_edited")` after mutation. Without these, the file won't appear in the FileChangesPanel — no diff, revert, redo, or accept. Tools using `DiffViewProvider` get this automatically; tools doing direct filesystem writes (`insert_edit`, `sed`, `rename_symbol`, `file` for rm/mv, `generate_image`) must do it manually. See [`docs/file-change-tracking.md`](docs/file-change-tracking.md) for the full tracking coverage table.
