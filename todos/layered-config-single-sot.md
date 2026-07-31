# One config store: the three layered `.shofer/` roots

## The invariant

> **Every piece of configuration except API-key secret _values_ is persisted in the
> three layered `.shofer/` roots and merged at runtime. There are no bespoke config
> files and no second config storage.**

The reason is operational, not tidiness: **resource-manager must be able to inject
arbitrary configuration into a workspace by mounting files into the org-global
`.shofer/` directory.** Any setting whose source of truth is somewhere else —
`globalState`, a `<globalStorage>/settings/` file, the provider-profiles blob, a
`contributes.configuration` entry — is a setting the platform structurally cannot
deliver. The mount is the delivery mechanism; the layered roots are its whole
contract.

This sharpens [`todos/done/config-cleanup.md`](done/config-cleanup.md), whose Parts
A–F built the machinery (merge engine, scope roots, `locked.json`, `plugins.json`,
scope archives) but stopped short of making the files authoritative, and whose
Decision 4 ("provider profiles do not become files") is now superseded: profiles
become files, only the key values stay secret.

**Precedence is unchanged** — `project > user > global` for unlocked keys, global
final for anything the org-global scope's `locked.json` names. (Stated because
"global > user > project" is ambiguous: it is read here as the layer order, base to
most specific. Inverting it would make `locked.json` meaningless and would mean a
project could never override anything.)

## What is actually layered today

Verified against the code, not the docs.

| Config                         | Source of truth today                                                      | Reads org-global? | Injectable by mount?    |
| ------------------------------ | -------------------------------------------------------------------------- | ----------------- | ----------------------- |
| ~108 `globalSettings` keys     | `globalState` (SQLite); `.shofer/settings.json` overlay shadows it on read | yes               | **yes** (read path)     |
| Plugin declarations            | `.shofer/plugins.json`, three scopes                                       | yes               | **yes**                 |
| Worker declarations            | `.shofer/workers.json`, three scopes                                       | yes               | **yes**                 |
| Custom modes                   | `<ws>/.shofer/shofermodes` + `<globalStorage>/settings/custom_modes.yaml`  | **no**            | **no**                  |
| MCP servers                    | `<ws>/.shofer/mcp.json` + `<globalStorage>/settings/mcp_settings.json`     | **no**            | **no**                  |
| Commands / skills / rules      | `~/.shofer/<dir>` + `<ws>/.shofer/<dir>`                                   | **no**            | **no**                  |
| Provider profiles (non-secret) | `SecretStorage` blob `shofer_config_api_config`                            | **no**            | **no**                  |
| API key values                 | same blob                                                                  | n/a               | n/a — **the exception** |
| 7 `shofer.*` VS Code settings  | `contributes.configuration`                                                | **no**            | **no**                  |

Only `resolveScopeRoots()` in
[`layeredSettingsLoader.ts`](../src/core/config/layeredSettingsLoader.ts) ever reads
`SHOFER_GLOBAL_DIR`, and only four files are wired to it: `settings.json`,
`locked.json`, `plugins.json`, `workers.json`. Everything else resolves its "global"
directory as `~/.shofer` (`getGlobalShoferDirectory()`), which is the **user** scope
under the three-scope vocabulary — so those subsystems are two-layer, and the org
layer does not exist for them at all.

### The live defect this creates

`shared/shoferbundle` already materializes an admin's bundle into the org-global
`.shofer/` (`bundle.go`: `modes → shofermodes`, `mcp → mcp.json`, `settings →
settings.json`, `plugins → plugins.json`). Of those, **`shofermodes` and `mcp.json`
are read by nothing.** An admin who puts modes or MCP servers in a config bundle gets
a file written to disk, a successful-looking deploy, and no effect whatsoever. The
`settings`/`plugins` keys work; the other two are silently inert.

That is not a future concern — it is shipping behaviour, and it is exactly the class
of failure the invariant exists to prevent.

## Plan

### Phase 1 — make the mount work (closes the silent-inert bug)

1. **Modes across three scopes.** Read `shofermodes` from global, user, and project
   via the existing per-entity merge (`COLLECTION_SPECS.modes` already maps
   `modes/<slug>` → `customModes`, so `locked.json` starts working for modes the
   moment the global scope is read). **Delete `custom_modes.yaml`**: the user scope
   becomes `~/.shofer/shofermodes`, which is where a per-machine mode always belonged.
   Touches `CustomModesManager`, `SimpleInstaller` (which writes a third spelling,
   `custom-modes.yaml`), `GlobalFileNames`.
2. **MCP across three scopes.** Read `.shofer/mcp.json` from global, user, and
   project; merge per server name; **delete `mcp_settings.json`**. Touches `McpHub`,
   `GlobalFileNames`.
3. **Commands / skills / rules across three scopes.** Add the org-global root ahead of
   `~/.shofer` in `getRooDirectoriesForCwd`, `commands.ts`, `SkillsManager`. These
   merge by filename, so the ordering rule is the same one already in use.

After Phase 1, every key the bundle can carry is a key the mount can deliver.

### Phase 2 — provider configuration becomes a file

4. **New `.shofer/providers.json`**, three scopes, merged per profile name (the
   `providers` namespace already exists in the engine, pointing at the wrong key —
   re-point it). Carries `profiles` (provider, model id, base URL, token limits,
   temperature, …), `currentApiConfigName`, and `modeApiConfigs`. Lockable per profile
   as `providers/<name>`.
5. **`apiKey` may appear in the file and is optional.** Resolution order for the key
   value alone: **the locally-stored secret for that profile wins; the file's value is
   the fallback.** This deliberately inverts the normal layered rule for exactly one
   field — a credential the user typed into this workspace must not be overwritten by
   a mounted default. Every non-secret field follows the ordinary rule.
6. **The blob keeps only key values.** `ProviderSettingsManager`'s
   `shofer_config_api_config` reduces to a profile-name → key map; the profile shape
   itself comes from the merged file.

### Phase 3 — `globalState` stops being a source of truth

7. **Unconditional write-through.** `ContextProxy.setValue` currently mirrors to
   `~/.shofer/settings.json` only when that file already exists (E4 made it opt-in).
   Create it on first write instead, so a fresh install is file-backed from the start.
8. **Demote `globalState` to a cache** rehydrated from the files, per E3's original
   intent.
9. **Port the five non-bootstrap VS Code settings** into `globalSettings`
   (`commandExecutionTimeout`, `commandTimeoutAllowlist`,
   `preventCompletionWithOpenTodos`, `codeIndex.embeddingBatchSize`,
   `workers.loadBalancer`). Only `customStoragePath` and `autoImportSettingsPath` are
   genuine bootstrap — they must be readable before the config layer exists — and they
   stay.
10. **Scope selector in the Settings UI** (the skipped half of E4), so a user can
    target project instead of always writing to user scope.

### Phase 4 — delete the parallel paths

11. Remove the JSON `exportSettings` / `importSettingsFromPath` path in favour of the
    scope archives (E5 left it in place for callers).
12. Subsume `autoImportSettingsPath` into "read the global root" (E6).

## Open decision: secrets in a mounted bundle

Phase 2 lets a bundle carry `apiKey` values, which is what makes org-supplied
credentials possible — but `shared/shoferbundle` materializes into a **ConfigMap**,
which is not a Secret. Anyone who can read ConfigMaps in the workspace namespace would
read the keys.

The repo's [Secrets](../../CLAUDE.md#secrets) rule accepts plaintext credentials in the
kapitan inventory because it stays inside infrastructure we control — a workspace
namespace shared with user-namespace agents is a weaker boundary than that, so the
trade-off does not automatically carry over. Options, in preference order:

- materialize a bundle's `providers.json` into a **k8s Secret** mounted into the same
  `.shofer/` dir, leaving the rest in the ConfigMap;
- accept the ConfigMap and document it;
- keep key values out of bundles entirely (contradicts the "optionally present" ask).

Not resolved here; it needs deciding before Phase 2 ships.
