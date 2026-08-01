---
description: Reset the Live Memory for this workspace — drop the in-flight context window like clear-context AND re-read the configured preload globs (verbatim reference docs) fresh from disk.
---

Reset the **Live Memory** memory agent for this workspace. This drops the current
history trail — the working conversation and loaded file contexts — exactly like
`/live-memory:clear-context`, and additionally **re-reads the `preloadGlobs`
config** (e.g. `docs/*.md`) fresh from disk, so the verbatim reference documents
the memory starts out knowing come back current. The accumulated observation/Q&A
log is kept.

Use this when the preloaded docs have changed substantially on disk, or the
accumulated working context has gone stale but you want the memory to keep its
configured reference material rather than start truly empty.

Trigger it from the **Reset** control in the Live Memory chat panel (it sends a
`reset` message on the plugin's scoped UI channel). Related: `/live-memory:clear-context`
(same wipe, no re-preload) and `/live-memory:empty` (wipe everything including the
observation/Q&A log).
