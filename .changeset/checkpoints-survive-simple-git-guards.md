---
"@shofer/core": patch
---

Checkpoints work again under simple-git's unsafe guards, and plugin bundles
rebuild when any source file changes. The vendored simple-git upgrade
(2026-08-02) made `git.env()` refuse a `GIT_EDITOR`-carrying environment and
`init --template=""` an opt-in argument — both silently disabled checkpoints
("Checkpoints disabled for this task") on hosts where `GIT_EDITOR` is set,
which includes VS Code terminals and CI. The sanitized shadow-git env now
strips the whole unsafe-env class (editor/pager/askpass/ssh/proxy/config
injection), and the deliberate empty `--template` is allowed explicitly. The
regression went unseen because the plugin bundle cache was keyed on the entry
file's mtime alone, so the vendored upgrade never invalidated it; the cache
key now covers the plugin's whole source tree.
