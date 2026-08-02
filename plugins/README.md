# plugins — the plugins bundled with Shofer

Every plugin in this directory ships **inside** the Shofer extension: it is public, it is
built with the extension, and it is available to anyone who installs Shofer without
installing anything else.

| Plugin                              | What it does                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| [`basics`](basics/)                 | Shofer's workspace basics in one plugin, each feature independently switchable         |
| [`builtin-config`](builtin-config/) | Shofer's built-in configuration: the default modes, and the rest of the shipped config |
| [`live-memory`](live-memory/)       | Persistent, LLM-backed codebase memory that observes Shofer's own file activity        |
| [`rag-indexing`](rag-indexing/)     | Semantic search over the codebase and its git history                                  |
| [`second-brain`](second-brain/)     | A cheap background model that watches each task and, rarely, advises                   |

Authoring a plugin: [`../PLUGINS.md`](../PLUGINS.md) (manifest fields, build invocations,
walkthroughs). The design and the seams: [`../docs/plugin_system.md`](../docs/plugin_system.md).

## This directory is public — and that is a constraint, not a detail

Shofer is FOSS with a public remote, and it is also consumed as a **submodule of private
integrator repositories**. That gives two homes for a plugin, and the split is by
**visibility**, not by size or quality:

- **Here** — public plugins, bundled with the extension, cloned by everyone.
- **In the integrator's own tree** — that integrator's private plugins, which no Shofer
  user can see. They are built and installed separately into a node's global plugin scope
  (`~/.shofer/plugins`), where the loader discovers them like any other plugin.

The rule that follows, because it has already produced a wrong fix:

> **Nothing in this repository may link to a plugin that is not in this repository.**

Not by a relative climb out of the tree, and not by a "corrected" path either — there is no
correct path. A doc here once referenced a Temporal worker plugin as
`../plugins/temporal-worker/DESIGN.md`, which never resolved, because that plugin is private
and lives in an integrator's tree. The reference itself was the defect, so it was removed
rather than repaired; the plugin is now named in prose with no link.

Naming an external plugin as an **example** is fine. Making a doc here **depend** on one — a
link, or an explanation that only makes sense to a reader who has it — breaks the Core
Self-Sufficiency Rule (see [`../AGENTS.md`](../AGENTS.md)), which is what keeps Shofer
runnable and comprehensible standalone.

The same boundary governs credentials: a secret must never be committed to this repository.
