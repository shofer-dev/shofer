---
description: "commit in separate commits"
---

Do no "touch" the code-server submodule. Ignore it. Do not update its reference in the main repository.

NEVER push to `remote`. Don't assume that the last commit is yours.

Version bump the components you changed (if not already), unless the change doesn't affect the binary (e.g. documentation). Then commit any changes performed during this session in separate commits (one commit per FR or bug fix), with comprehensive commit messages.

Beacause multiple parallel sessions can run in parallel, avoid reverting or stashing external changes. Just the external changes are on different files than yours, just `git add` yours. If they are on the same just add a note in the commit message. Do not ask/wait for confirmation.

Version bumping: For extensions it is typically `/extensions/*/src/package.json` or `/extensions/*/src/package.json`; for microservices it is `services.json` and `infra/kapitan/inventory/targets/development.yml`.
Notice that Shofer is an extension under `extensions`, and to version bump you need to edit `/extensions/shofer/src/package.json`.

Use Conventional Commits format with breaking changes and scopes (if applicable) for commit messages, and include the relevant issue number in the message if applicable.

IMPORTANT: Do not push to origin after committing. The push will be handled by the human after all commits are done, to ensure all related commits are pushed together.
