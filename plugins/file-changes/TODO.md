# File Changes — TODO

What is knowingly not done, and what was traded away when file-change tracking moved out
of core.

## Reduced fidelity vs the built-in

- **The history `+`/`−` badge updates on completion, not live.** Core used to recompute
  the change stats on every edit and write them onto the task's history item, so the badge
  in the task list moved while the task ran. A plugin cannot write history, so the numbers
  are now asked for once, when the task completes (core's broadcast `"task-stats"`
  question). Fixing it properly means a generic "a plugin contributes a fact about this
  task" seam, not a file-changes-shaped one.
- **English-only strings.** The panel's labels and messages are literal English. A plugin
  bundle cannot reach the host's i18n catalogue, and shipping a parallel catalogue inside
  the plugin would drift. Worth solving generically (a `ctx.i18n`, or manifest-declared
  locale files) rather than per plugin — the checkpoints plugin has the same gap.
- **Diffs open in the multi-file diff viewer.** The built-in registered a
  `shofer-original:` document provider and opened a plain two-pane diff. The plugin surface
  offers `showMultiFileDiff`, so a single file opens as a one-entry multi-diff. Same
  content, slightly heavier editor.
- **A remote task's panel refreshes on conversation activity, not on its edits.** For a
  task running on an executor, the controller used to fetch the panel over a dedicated
  control-plane method whenever a remote message arrived. That method is gone (the generic
  plugin request replaced it), so the panel now re-reads when the task's message count
  changes — throttled to once a second — and after every action. The gap is live-refresh
  granularity for an unattended remote task, not correctness.
- **`get_changed_files` is available in every mode.** As a native tool it was in the
  `read` group, so `web-search` mode did not have it. Plugin-contributed tools are not
  mode-filtered yet; when they are, this returns to matching the built-in.

## Known gaps (inherited from the built-in)

- **No Redo.** The produced state is kept — a revert deliberately does not overwrite it —
  but nothing re-applies it. The built-in documented a Redo affordance that its panel never
  actually rendered; the plugin ships without it rather than describing one that is not
  there.
- **No binary support.** Content is read and written as UTF-8, so a binary file (a
  generated image) is listed but has no baseline and no diff. Real support means
  `Buffer`-based copies and hashing throughout the store.
- **No size limit.** Copies are verbatim and kept for the life of the task in history:
  no pruning, no LRU, no cap. A task that rewrites a very large file many times keeps one
  copy of each side, but a task touching thousands of files keeps thousands of copies.
- **Accept is not atomic.** Between reading the disk content and promoting it to the
  baseline, the file can change again; the recorded hash would then describe an
  intermediate state. Re-reading and verifying after promotion would close it.
- **A checkpoint restore leaves the baselines stale.** Restoring a checkpoint rewinds the
  workspace without telling this plugin, so `base/` still describes the pre-restore
  history. The generic fix is available — this plugin could take `onTimelineRewind` and
  clear its copies for that task — and is not implemented yet.

## Not planned

- Tracking files the **user** edited. The panel answers "what did the agent do", and
  `user_edited` events are deliberately not part of the change list.
