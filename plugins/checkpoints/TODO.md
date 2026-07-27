# Checkpoints — TODO

What is knowingly not done, and what was traded away when checkpoints moved out of core.

## Reduced fidelity vs the built-in

- **No init-progress UI.** The built-in posted a `checkpointInitWarning` to the webview,
  which rendered a "checkpoints are taking a while…" caption after 5 s and an explicit
  timeout notice. The plugin surfaces a warning toast + log line instead: a plugin
  cannot render into the chat body, only into its own marker rows, and the first row
  only exists once a checkpoint has been taken. Fixing this properly means a generic
  "plugin status banner" region, not a checkpoint-specific message type.
- **No nested-repository diagnostic.** The built-in ran a ripgrep scan for `**/.git/HEAD`
  and logged what it found. It was log-only — `GIT_DIR` is what actually makes nested
  repos work — and ripgrep is not on the plugin's surface, so the scan was dropped
  rather than reimplemented.

## Known gaps

- **A turn whose hook exceeds `hookTimeoutMs` has no checkpoint.** It warns, but the
  user only finds out when they look for a checkpoint that isn't there. A "checkpoints
  fell behind" indicator would be better than a transient warning.
- **Restore does not move submodule pointers** (inherited from the built-in — see
  DESIGN.md "Deliberate limits").
- **A version-skewed executor without this plugin loses remote checkpoints.** The
  controller's request fails with "not registered", which is at least explicit, but
  there is no capability negotiation that would let the UI hide the affordance instead.
- **Shadow repos from the built-in era are orphaned.** The built-in stored them under
  `<globalStorage>/tasks/<taskId>/checkpoints`; the plugin uses its own storage dir.
  Old task directories still get deleted with their task, so this leaks nothing new —
  but pre-existing tasks lose their history, which is the accepted cost of the move
  (the project takes no backward-compatibility work).

## Testing gaps

- The **UI bundle is untested**. `ui/row.tsx` is not typechecked by the extension build
  and has no component test; a webview-side harness for plugin bundles doesn't exist yet.
- No test covers the **remote/executor** path end-to-end (it needs a controller + a
  `shofer serve` executor); the routing conventions it relies on are unit-tested on the
  host side only.
