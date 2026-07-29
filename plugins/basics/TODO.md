# Basics — TODO

What is knowingly not done: the gaps the merge itself introduced, then each feature's
own gaps (carried over from the pre-merge plugins).

## From the merge

- **The worktree slash commands cannot be feature-gated.** `contributes.commands` is
  manifest-level, so disabling the worktrees feature leaves `/merge-worktree` & friends
  registered. They are plain prompts operating on git, so they still work — but a
  deployment that replaces the worktrees feature (arkware-basics) may ship its own
  versions and end up with the built-in tier duplicated. Feature-gating a declarative
  contribution needs a core seam that does not exist yet.
- **The settings-tab region stays mounted when worktrees is off.** The panel renders
  `null`, but the plugin's tab entry in Settings → Plugins still exists (the host knows
  plugins, not features).
- **Feature switches need a reload to reach the UI.** The UI bundles ask
  `local:features` once per mount; flipping a feature boolean re-initializes the
  extension half immediately but an already-mounted panel only notices on its next
  mount.

## Checkpoints

- **No init-progress UI.** The pre-plugin built-in rendered a "checkpoints are taking a
  while…" caption in chat. The plugin surfaces a warning toast + log line instead: a
  plugin cannot render into the chat body, only into its own marker rows. Fixing this
  properly means a generic "plugin status banner" region.
- **A turn whose hook exceeds `hookTimeoutMs` has no checkpoint.** It warns, but the
  user only finds out when they look for a checkpoint that isn't there.
- **Restore does not move submodule pointers** (see
  [`docs/checkpoints.md`](docs/checkpoints.md) "Deliberate limits").
- **A version-skewed executor without this plugin loses remote checkpoints.** The
  controller's request fails with "not registered" — explicit, but there is no
  capability negotiation that would let the UI hide the affordance instead.
- **Shadow repos from earlier eras are orphaned.** The core-built-in stored them under
  `<globalStorage>/tasks/<taskId>/checkpoints`, the standalone plugin under its own
  storage dir, and this plugin under `<storage>/checkpoints/`. Old task directories
  still get deleted with their task, so nothing leaks — but pre-existing tasks lose
  their history, the accepted cost of each move (no backward-compatibility work).

## File Changes

- **The history `+`/`−` badge updates on completion, not live** (core's `"task-stats"`
  broadcast fires when the task completes; a plugin cannot write history).
- **Diffs open in the multi-file diff viewer** — a single file opens as a one-entry
  multi-diff, slightly heavier than the old two-pane view.
- **A remote task's panel refreshes on conversation activity, not on its edits**
  (throttled re-read on message-count change; the executor's push lands on its own
  webview).
- **`get_changed_files` is available in every mode.** Plugin-contributed tools are not
  mode-filtered yet; as a native tool it was in the `read` group.
- **No Redo.** The produced state is kept, but nothing re-applies it.
- **No binary support.** Content is read and written as UTF-8; a binary file is listed
  but has no baseline and no diff.
- **No size limit.** Copies are verbatim and kept for the life of the task in history.
- **Accept is not atomic.** Between reading the disk content and promoting it to the
  baseline, the file can change again.
- **A checkpoint restore leaves the baselines stale.** Restoring rewinds the workspace
  without telling this feature; it could take `onTimelineRewind` and clear its copies
  for that task — now even easier from inside one plugin — but does not yet.
- Not planned: tracking files the **user** edited. The panel answers "what did the
  agent do".

## Worktrees

- **The Settings panel lives under Settings → Plugins**, not its own top-level tab.
- **No polling.** The panel refreshes when it mounts and after each of its own
  operations; a worktree created outside Shofer shows up on the next open.
- **`.shofer/worktreeinclude` is intersection-only.** A path is copied only if it
  matches BOTH `worktreeinclude` and `.gitignore` — deliberate (a tracked file copied
  into a second checkout surfaces as a merge conflict), but a file that is neither
  tracked nor ignored cannot be copied at all.
- **Submodule init is `--depth 1`, always.**
- **No sync of `worktreeinclude` into existing worktrees.** The copy happens at
  creation.
- **No public API.** Everything is reachable from the UI, the slash commands, and
  core's placement question.
- **Headless has no chrome.** On `shofer serve` there is no branch chip and no
  Settings panel; placement, creation, seeding and the slash commands all run there.
- **The legacy `.shofer/worktrees/` prefix is still recognised** — by core's
  `isEmbeddedWorktreeTask()` and this feature's `list`/`delete` — so worktrees created
  before the move to `<workspace>/.worktrees/` stay confined and manageable. Nothing
  creates them there. Remove the legacy branch (here, in
  `packages/types/src/worktrees.ts`, in `worktreePathGuard.ts`, in `FindFilesTool` and
  in the checkpoints exclusion) in a later release.

## Testing gaps

- The **UI bundles are untested**: not typechecked by the extension build, no component
  tests — a webview-side harness for plugin bundles doesn't exist yet.
- No test covers the **remote/executor** path end-to-end; the routing conventions it
  relies on are unit-tested on the host side only.
