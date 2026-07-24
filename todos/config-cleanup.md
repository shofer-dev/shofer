# Shofer Configuration Cleanup & Consolidation

**Goal:** Collapse Shofer's several configuration source-of-truth (SoT) backends into a
single **file-based** model that always lives under **`.shofer/`**, with **secrets the only
exception**. The payoff:

- **Export = zip `.shofer/`.** Import = unzip into a scope. No bespoke JSON export schema.
- **Injection = unpack a `.shofer/` tree into the global scope.** A host/integration (e.g.
  the SaaS "config-manager") only drops a `.shofer/` directory in the global location — it
  needs to understand nothing about individual keys or storage backends. In a SaaS /
  untrusted-workspace deployment that global location is a **read-only path outside the
  user's `/home`** (e.g. a ConfigMap mounted at `/etc/shofer/`), so the workspace/agent
  **cannot tamper with org policy** — the tamper-proofing is what makes `global`-wins
  enforcement real, not advisory.
- **Global / user / project overlay stays**, merged at runtime with a **per-key
  locked-vs-default** rule. The global layer marks each key — or **named entity** (a mode
  by slug e.g. `Code`, a provider/api-configuration by name e.g. `default`, an MCP server,
  a slash command) — as **locked** or not:
    - **Locked** → the global value is **immutable org policy**; user/project cannot override
      or remove it. ⚠️ For these keys this **inverts** Shofer's current "project overrides
      global".
    - **Unlocked** → the global value is a **default**; user then project override it
      (more-specific wins — Shofer's current direction).
    - A user/project may always **add** entries the global layer does not define.
      So enforcement is top-down only where the org explicitly locks; everything else stays an
      overridable default.

This subsumes the earlier, narrower goal (reduce backends 4→2 with `globalState` as the
settings SoT). That backend reduction is now **Phase 1 pre-work** (Parts A–D below): it
shrinks and unifies the surface into `globalSettingsSchema`, after which **Phase 2 / Part E**
moves that unified surface off `globalState` and onto layered `.shofer/` files —
`globalState` degrades from a source of truth to a runtime cache.

## Current state — the SoTs to consolidate

Verified against [`docs/settings_overlay.md`](../docs/settings_overlay.md) and
[`ContextProxy`](../src/core/config/ContextProxy.ts):

| Config                                       | Today's SoT                                                                                 | Notes                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Global settings** (~96 keys)               | VS Code `globalState` (SQLite `state.vscdb`) via `ContextProxy`                             | flat KV, no overlay                 |
| **VS Code config** (18 keys)                 | `package.json` `contributes.configuration` (`arkware.*`)                                    | mostly dead/dual-written — Part A/C |
| **Provider profiles + API keys**             | `SecretStorage` (profiles blob `shofer_config_api_config` **+** 31 individual keys)         | **SECRET** — Part B                 |
| **Custom modes**                             | `.shofer/shofermodes` (project YAML) > `custom_modes.yaml` (global-storage YAML) > built-in | already partly file-based           |
| **MCP servers**                              | `.shofer/mcp.json` (project) / global mcp settings                                          | already file-based                  |
| **Slash commands / skills / rules / ignore** | `.shofer/commands`, `.shofer/skills`, `.shofer/rules[-mode]`, `.shofer/shoferignore`        | already file-based                  |

The fragmentation is the problem: three storage mechanisms (globalState, SecretStorage,
files) plus two overlay systems (modes have a 4-layer merge; globalSettings have none), so
"what is my effective config and where does it live" has no single answer, and export
(`importExport.ts`) hand-assembles `{ providerProfiles, globalSettings }` from two of them.

## Target — the canonical `.shofer/` layout

Everything non-secret becomes a file under `.shofer/`, at each of three scopes:

```
.shofer/
├── settings.json        # the ~96 globalSettings keys (was globalState)   ← NEW home
├── locked.json          # (global scope only) keys/entities the org locks  ← NEW
├── shofermodes          # custom modes (YAML)                              (exists)
├── mcp.json             # MCP servers                                       (exists)
├── commands/            # slash commands (*.md)                             (exists)
├── skills/  skills-<mode>/   # skills                                       (exists)
├── rules/   rules-<mode>/    # rules / custom instructions                  (exists)
└── shoferignore         # tool access control                              (exists)
```

Scopes and their roots:

| Scope       | Root                                                                                                                                                                                    | Writable by the workspace? | Who writes it                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------- |
| **global**  | a **read-only path outside `/home`** — SaaS: ConfigMap mount (e.g. `/etc/shofer/`); standalone default: the extension global-storage `.shofer/` (where `custom_modes.yaml` lives today) | **no** (RO mount)          | host/integration (config-manager)     |
| **user**    | **`~/.shofer/`** (writable per-user)                                                                                                                                                    | yes                        | the user                              |
| **project** | `<workspace>/.shofer/`                                                                                                                                                                  | yes                        | committed to the repo, shared via git |

> **Semantic remap.** What Shofer calls "global" today (`~/.shofer/`) becomes the **user**
> scope; a new **org-global** layer (RO, outside `/home`) sits above it. The global root is
> **configurable** (`SHOFER_GLOBAL_DIR`, see E6) so SaaS points it at a RO out-of-`/home`
> mount while a standalone FOSS install uses the extension global-storage dir (kept distinct
> from `~/.shofer/`). The RO-outside-`/home` property is a **hard requirement** for locked
> policy: a global layer the workspace could edit would make locking meaningless.

**Effective config** is a per-key/per-entity deep-merge across the three scopes:

- **Locked** key/entity (global marks it): the **global** value wins and is final —
  user/project contributions to that key/entity are dropped.
- **Unlocked** key/entity: the normal **more-specific-wins** merge applies
  (`project` > `user` > `global`), global as the default. This is Shofer's existing
  mode/rules precedence, reused unchanged for the unlocked case.

**Locking mechanism.** The global scope declares what it locks in a manifest —
`.shofer/locked.json` listing locked paths and named entities, e.g.
`["autoApprovalEnabled", "modes/Code", "providers/default", "mcp/<server>"]`. **Only the
global (RO) scope's manifest is honored**; a `locked.json` under user/project is ignored
(they can neither lock against each other nor unlock policy). The merge engine consults it
per key/entity and routes to the locked or default branch above — one merge, one manifest,
applied uniformly to settings, modes, rules, mcp, and commands.

### The secrets exception

API keys / provider profiles do **not** become files — they stay in `SecretStorage`
(Part B keeps the profiles blob as their sole SoT). In a SaaS / untrusted-workspace
deployment the workspace holds **no** provider secret at all; access is gated by the
attestation edge (`arkware.ai` `docs/authnz_arch.md` §11.4/§15). `.shofer/settings.json`
may reference a profile **by name/id**, never by key value — which is exactly what keeps
"export = zip `.shofer/`" safe to hand around. Core stays FOSS-agnostic: it only knows
"secrets live in `SecretStorage`, not in files"; the SaaS authnz is an integration concern,
not core's (Core Self-Sufficiency Rule).

## Export / import become trivial (Part E consequence)

- **Export**: zip the chosen scope's `.shofer/` (default: merged/global view). Replaces
  `exportSettings` in [`importExport.ts`](../src/core/config/importExport.ts).
- **Import**: unzip into a scope root. Replaces `importSettingsFromPath` +
  `providerSettingsManager.import` + `contextProxy.setValues`. Secrets, if any, applied
  out of band, never from the zip.
- **`autoImportSettingsPath`** is subsumed: "load on start" becomes "read the global
  `.shofer/` that was unpacked there" (keep a thin bootstrap pointing at the global root;
  see D2).

## SaaS integration (why this is being asked for now)

`arkware.ai` user-console is adding **Shofer config bundles** associated with workspaces
(parent-repo feature). With this refactor a bundle **is** a zipped `.shofer/` tree, and
resource-manager's injection is "unpack it into the workspace's global `.shofer/`"
(a ConfigMap-mounted directory) — no per-key ConfigMap, no schema knowledge. User/project
`.shofer/` still override. Core remains standalone and never learns the SaaS exists.

---

## Part A: Port 14 VS Code config settings to globalState/ContextProxy

Each requires: (a) add key to `globalSettingsSchema` if missing, (b) repoint the consumer
(see the mechanism note below), (c) add Settings UI row in the Shofer webview, (d) remove
from `package.json` `contributes.configuration.properties`.

> ⚠️ **Mechanism correction (verified against source 2026-07-24).** The item bodies below
> say "read from `getConfiguration("shofer")`", but the live consumers read through **two**
> paths, and the fix differs by path — the naive "swap to `ContextProxy.getValue`" is
> **wrong for core**:
>
> - **Host-side consumers** (`src/**`, e.g. `ShoferProvider`, `CodeActionProvider`,
>   `vscode-lm.ts`) may read `ContextProxy` directly. `ShoferProvider.debug` was migrated
>   this way (done).
> - **`@shofer/core` consumers** (`packages/core/**`, e.g. `timeout-config.ts` →
>   `apiRequestTimeout`, `file-search.ts` → `maximumIndexedFilesForFileSearch`,
>   `NewTaskTool.ts`/`Task.ts`/`generateSystemPrompt.ts` → `newTaskRequireTodos`) read via
>   the **host seam** `getHost().config.get(Package.name, "key", default)` and **MUST NOT**
>   import `ContextProxy` (Core Self-Sufficiency Rule). The correct migration is to reroute
>   the **host's `config` seam implementation** (`HostProvider.config`) to read from
>   `ContextProxy`/globalState, so every core consumer moves in one change without crossing
>   the boundary — not to touch each core call site. This is a prerequisite for dropping the
>   `package.json` rows of the core-consumed keys (`apiRequestTimeout`,
>   `maximumIndexedFilesForFileSearch`, `newTaskRequireTodos`, `debugProxy.*`,
>   `vsCodeLmModelSelector`), since removing the vscode registration while the seam still
>   reads vscode config would strip their Settings-UI/schema without giving them a home.
>
> **Status:** (a) schema keys added for all 9 migrating keys + classified in
> `SETTING_SYNC_SCOPE` (commit `8fa1e95ba`); `debug` fully migrated host-side (commit
> `106f99a8b`). Remaining: the `getHost().config` seam reroute (core keys), the host-side
> `enableCodeActions`/`enableLlmProviderIntegration` repoints, the `allowedCommands`/
> `deniedCommands` dual-write removal, and the `package.json`/UI steps.

### A1. `allowedCommands` — Dual-write cleanup

- **Status:** Already in `globalSettingsSchema` and written to both `globalState` and
  vscode config. Dual-write in `webviewMessageHandler.ts:749-750` and
  `ShoferProvider.ts:3613-3614`.
- **Action:** Remove vscode config write paths. Remove `package.json` registration.
  Remove `extension.ts:135-139` seed-from-config init path.
- **Settings UI:** Already in Auto-Approve tab → allowed commands editor.

### A2. `deniedCommands` — Dual-write cleanup

- **Status:** Same as A1. Dual-write at `webviewMessageHandler.ts:758-759` and
  `ShoferProvider.ts:3619-3620`.
- **Action:** Same as A1. Remove dual-write, remove `package.json` registration.
- **Settings UI:** Already in Auto-Approve tab → denied commands editor.

### A3. `preventCompletionWithOpenTodos`

- **Status:** In `globalSettingsSchema`. Consumer: [`AttemptCompletionTool.ts:96-97`](extensions/shofer/src/core/tools/AttemptCompletionTool.ts:96)
  reads from vscode config.
- **Action:** Change consumer to `ContextProxy.getValue("preventCompletionWithOpenTodos")`.
  Remove `package.json` registration.
- **Settings UI:** Already in the webview (Auto-Approve tab or similar).

### A4. `vsCodeLmModelSelector`

- **Status:** Object `{ vendor, family }`. NOT in `globalSettingsSchema`. Consumer:
  vscode-lm provider handler (reads from vscode config).
- **Action:** Add `vsCodeLmModelSelector: z.object({ vendor: z.string().optional(), family: z.string().optional() }).optional()`
  to `globalSettingsSchema`. Update vscode-lm provider to read from ContextProxy.
  Remove `package.json` registration.
- **Settings UI:** Needs new row in Providers tab under VS Code LM section.

### A5. `enableCodeActions`

- **Status:** Boolean. NOT in `globalSettingsSchema`. Consumer: [`CodeActionProvider.ts:41`](extensions/shofer/src/activate/CodeActionProvider.ts:41)
  reads from vscode config.
- **Action:** Add to `globalSettingsSchema`. Update consumer. Remove `package.json`.
- **Settings UI:** Needs new toggle in UI/General tab.

### A6. `maximumIndexedFilesForFileSearch`

- **Status:** Number (5000–500000). NOT in `globalSettingsSchema`. Consumer: [`file-search.ts:121`](extensions/shofer/src/services/search/file-search.ts:121).
- **Action:** Add to `globalSettingsSchema`. Update consumer. Remove `package.json`.
- **Settings UI:** Needs new row in Code Index settings tab.

### A7. `apiRequestTimeout`

- **Status:** Number (0–3600). NOT in `globalSettingsSchema`. Consumer: [`timeout-config.ts:12`](extensions/shofer/src/api/providers/utils/timeout-config.ts:12) →
  all API provider handlers use `getApiRequestTimeout()`.
- **Action:** Add to `globalSettingsSchema`. Update `getApiRequestTimeout()` to read from
  ContextProxy (convert to async, or cache the value). Remove `package.json`.
- **Settings UI:** Needs new row in API & Providers tab.

### A8. `newTaskRequireTodos`

- **Status:** Boolean. NOT in `globalSettingsSchema`. Consumers: [`NewTaskTool.ts:99-100`](extensions/shofer/src/core/tools/NewTaskTool.ts:99),
  [`Task.ts:4961-4962`](extensions/shofer/src/core/task/Task.ts:4961),
  [`generateSystemPrompt.ts:62-63`](extensions/shofer/src/core/webview/generateSystemPrompt.ts:62).
- **Action:** Add to `globalSettingsSchema`. Update consumers. Remove `package.json`.
- **Settings UI:** Needs new toggle in Task Behaviour section.

### A9. `codeIndex.embeddingBatchSize`

- **Status:** Number (1–200). NOT in `globalSettingsSchema`. Consumer: code index embedder.
- **Action:** Add to `codebaseIndexConfigSchema` (or `globalSettingsSchema`).
  Update consumer. Remove `package.json`.
- **Settings UI:** Needs new row in Code Index settings tab.

### A10. `debug`

- **Status:** Boolean. NOT in `globalSettingsSchema`. Consumers: [`ShoferProvider.ts:2917`](extensions/shofer/src/core/webview/ShoferProvider.ts:2917)
  (posted to webview state), [`webviewMessageHandler.ts:2488-2489`](extensions/shofer/src/core/webview/webviewMessageHandler.ts:2488).
- **Action:** Add to `globalSettingsSchema`. Update consumers. Remove `package.json`.
- **Settings UI:** Needs new toggle in Debug/Diagnostics section.

### A11–A13. `debugProxy.enabled`, `debugProxy.serverUrl`, `debugProxy.tlsInsecure`

- **Status:** Boolean / string / boolean. NOT in `globalSettingsSchema`. Consumer: [`networkProxy.ts:207`](extensions/shofer/src/utils/networkProxy.ts:207).
- **Action:** Add all three to `globalSettingsSchema`. Update consumer. Remove `package.json`.
- **Settings UI:** Needs new section in Debug tab.

### A14. `enableLlmProviderIntegration`

- **Status:** Already in `globalSettingsSchema`. Consumer: already reads from ContextProxy.
- **Action:** Remove from `package.json` only (already single-source-of-truth in globalState).

---

## Part B: Remove individual SecretStorage keys — eliminate blob duplication

API keys are stored in TWO places:

1. **Profiles blob** (`shofer_config_api_config`) — full profile data including keys,
   managed by `ProviderSettingsManager`. Source of truth.
2. **Individual keys** (31 entries in `SECRET_STATE_KEYS` + `GLOBAL_SECRET_KEYS`) —
   denormalized cache of the active profile's API keys, managed by `ContextProxy`.

### B1. Route ContextProxy secret reads through ProviderSettingsManager

- Change `ContextProxy.getSecret(key)` to delegate to `ProviderSettingsManager.getActiveProfile()[key]`
  instead of reading from individual SecretStorage entries.
- This is the TODO acknowledged at [`importExport.ts:172-174`](extensions/shofer/src/core/config/importExport.ts:172):
    > "It seems like we don't need to have the provider settings in the proxy;
    > we can just use providerSettingsManager as the source of truth."

### B2. Route ContextProxy secret writes through ProviderSettingsManager

- Change `ContextProxy.setValue(key, value)` for secret keys to call
  `ProviderSettingsManager.updateActiveProfile({ [key]: value })` instead of
  `secrets.store(key, value)`.

### B3. Migrate existing individual keys to profiles blob

- One-time migration: read all individual secret keys, find them in the active profile,
  write them into the blob (they should already be there), then delete the individual entries.

### B4. Remove individual key infrastructure

- Remove `SECRET_STATE_KEYS` and `GLOBAL_SECRET_KEYS` arrays.
- Remove individual `secrets.get()/store()/delete()` calls from ContextProxy.
- Remove `secretCache` — replace with ProviderSettingsManager integration.
- Remove `openRouterImageApiKey` from individual secrets (it belongs in the profiles blob
  or globalSettings, not as a standalone secret).

### B5. Update export/import to not touch individual keys

- Export already reads from profiles blob — no change.
- Import currently calls `contextProxy.setProviderSettings()` which writes individual
  keys. Change to only write the blob.

---

## Part C: Dead code removal

### C1. Remove `shofer.devmandExecutionTimeout` from package.json

- Zero consumers. The runtime reads `commandExecutionTimeout` from `globalSettingsSchema`.

### C2. Remove `shofer.devmandTimeoutAllowlist` from package.json

- Zero consumers. The runtime reads `commandTimeoutAllowlist` from `globalSettingsSchema`.

### C3. Remove `shofer.newTaskRequireTodos` from package.json (after A8 port)

- After port to globalState, remove the vscode config registration.

---

## Part D: Other simplification opportunities

### D1. Collapse ProviderSettings into globalSettingsSchema

- Currently `shoferSettingsSchema = providerSettingsSchema.merge(globalSettingsSchema)`.
  The split is historical and adds cognitive overhead. All values are stored in the same
  `globalState` backend. The discriminated-union ProviderSettings type would still exist
  for Zod validation, but the schema split in `global-settings.ts` could be flattened.

### D2. Remove `customStoragePath` and `autoImportSettingsPath` bootstrapping from vscode config

- These two MUST remain in vscode config (read before ContextProxy exists).
  Alternative: use environment variables (`SHOFER_STORAGE_PATH`, `SHOFER_AUTO_IMPORT_PATH`)
  as the bootstrapping mechanism, removing the last remaining `shofer.*` vscode config keys.
  This would allow complete removal of `contributes.configuration.properties` from `package.json`.

### D3. Remove `allowedCommands`/`deniedCommands` dual-write sync

- `webviewMessageHandler.ts` writes to BOTH `globalState` and vscode config on every
  change. After A1/A2, remove the vscode config write. Also remove the
  `extension.ts:135-139` init-seed and `ShoferProvider.ts:3613-3620` dual-write.

### D4. Remove `mergeCommandLists` from ShoferProvider

- [`ShoferProvider.ts:2572-2597`](extensions/shofer/src/core/webview/ShoferProvider.ts:2572)
  merges command lists from vscode config + globalState. After A1/A2, only globalState
  is needed — simplify to single-source read.

### D5. One-time migration helper for existing vscode config values

- On extension activation (after ContextProxy init), read any existing vscode config
  values for the migrated keys and seed them into globalState if not already present.
  This prevents "my settings disappeared" for existing users.

### D6. Update `configuration.md`

- Rewrite as "Global Settings Reference" documenting the ContextProxy/globalState keys
  rather than "shofer._ VS Code settings." Remove the misleading "Complete reference for
  all shofer._ VS Code settings" framing.

---

## Part E: Move the settings SoT from `globalState` to layered `.shofer/` files

This is the new end-state (Phase 2), done after A–D have unified everything into
`globalSettingsSchema`.

### E1. Define the on-disk shape and scopes

- `globalSettingsSchema` becomes the schema for **`.shofer/settings.json`** (Schema-First
  Persistence Rule — keep it Zod-first, `safeParse` on read, versioned per the Versioned
  Snapshot Rule).
- Resolve three scope roots: `global` (a **configurable, read-only, out-of-`/home`** path —
  env `SHOFER_GLOBAL_DIR`, default = the extension global-storage `.shofer/` for standalone;
  a ConfigMap mount in SaaS), `user` (`~/.shofer/`), `project` (`<workspace>/.shofer/`).
  Treat the global root as immutable: never write to it from `setValue`/the Settings UI
  (writes go to `user`/`project`); honor `locked.json` only from the global scope.

### E2. Layered read + merge (locked-vs-default)

- Read `settings.json` (and `shofermodes`, `rules/`, `mcp.json`, …) from all three scopes,
  plus the global scope's `locked.json`. Build/repurpose ONE precedence engine and route
  modes, rules, settings, and mcp through it, applying the **per-key/per-entity**
  locked-vs-default rule: locked → global value final; unlocked → `project > user > global`
  (the current more-specific-wins direction). See the merge rule + `locked.json` above.

### E3. Back `ContextProxy` with the files

- `ContextProxy.getValue`/`setValue` for global-settings keys read/write the appropriate
  scope's `.shofer/settings.json` instead of `globalState`; `globalState` becomes a hot
  cache rehydrated from files. Add file watchers (like `.shofermodes`) to reload + refresh
  the webview on change.

### E4. Settings UI writes to a scope

- The Settings webview gains a **scope selector** (global/user/project) and persists to that
  scope's file, honoring the save-gating rules (AGENTS.md "Settings & configuration").

### E5. Export/import = zip/unzip `.shofer/`

- Replace `exportSettings`/`importSettingsFromPath` in
  [`importExport.ts`](../src/core/config/importExport.ts) with zip of a scope's `.shofer/`
  and unzip into a scope root. Secrets stay out of the zip (Part B); applied out of band.

### E6. Subsume `autoImportSettingsPath`

- "Load on start" = read the global `.shofer/` unpacked at the RO root. Keep only a thin
  bootstrap resolving the global root from `SHOFER_GLOBAL_DIR` (default = the extension
  global-storage `.shofer/`), per D2. The SaaS sets it to the RO ConfigMap mount.

---

## Decisions

1. **`user` scope = `~/.shofer/`** (writable per-user). The new RO org-global layer sits
   above it; project is `<ws>/.shofer/`. (In a single-user SaaS workspace `user` and
   `project` are both writable and near-equivalent, but the three-layer model stands.)
2. **Format = JSON** for `settings.json` and `locked.json`; modes stay YAML (`shofermodes`),
   commands/rules/skills stay markdown.
3. **Migration = one-time seed** on activation: read existing `globalState` (plus the
   Part-A-migrated vscode-config keys) and write them to the writable `user`
   `~/.shofer/settings.json` if absent, then treat files as SoT. Avoids "my settings
   vanished"; not a repeated sync.
4. **Secrets** stay in `SecretStorage` (Part B). A SaaS workspace holds **no** provider
   secret; access is gated by `docs/authnz_arch.md` §11.4/§15 (built; enforcing waypoint
   still to be hardened). Bundles/zips reference profiles by name only.
5. **Per-key locked-vs-default** (not blanket global-wins) — the merge rule + `locked.json`
   above. Locking is per key **and per named entity** (a mode slug like `Code`, a
   provider-config name like `default`, an mcp server, a command).

---

## Migration order (recommended)

1. **Part C first** (dead code removal) — zero risk, immediate cleanup.
2. **Part A** (port 14 settings) — one setting at a time, each with its own Settings UI row.
   Start with A1/A2 (already dual-written, easiest). End with A4/A7 (need schema additions).
3. **Part B** (remove individual keys) — after all reads go through ContextProxy. Requires
   the A migration complete so all secret reads use the new routing.
4. **Part D** (simplifications) — sweep after A+B are done. Everything is now unified in
   `globalSettingsSchema` with `globalState` as the single settings backend.
5. **Part E** (move to `.shofer/` files) — the Phase-2 end-state: repoint the unified
   surface off `globalState` onto layered files, invert precedence, zip/unzip export.
   Depends on A–D having collapsed the surface to one schema first.

---

## Files touched

| File                                         | Changes                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/package.json`                           | Remove config properties (A, C)                                                     |
| `packages/types/src/global-settings.ts`      | Add new keys to schema (A4–A13)                                                     |
| `src/core/config/ContextProxy.ts`            | Route secrets to ProviderSettingsManager (B1–B2); remove secretCache (B4)           |
| `src/core/config/ProviderSettingsManager.ts` | Expose active profile field read/write (B1–B2)                                      |
| `src/core/webview/webviewMessageHandler.ts`  | Remove dual-writes (A1/A2); update debug (A10)                                      |
| `src/core/webview/ShoferProvider.ts`         | Remove dual-writes (A1/A2, D3); update debug (A10); simplify mergeCommandLists (D4) |
| `src/core/tools/AttemptCompletionTool.ts`    | Read from ContextProxy (A3)                                                         |
| `src/core/tools/NewTaskTool.ts`              | Read from ContextProxy (A8)                                                         |
| `src/core/task/Task.ts`                      | Read from ContextProxy (A8)                                                         |
| `src/core/webview/generateSystemPrompt.ts`   | Read from ContextProxy (A8)                                                         |
| `src/activate/CodeActionProvider.ts`         | Read from ContextProxy (A5)                                                         |
| `src/services/search/file-search.ts`         | Read from ContextProxy (A6)                                                         |
| `src/api/providers/utils/timeout-config.ts`  | Read from ContextProxy (A7)                                                         |
| `src/utils/networkProxy.ts`                  | Read from ContextProxy (A11–A13)                                                    |
| `src/utils/storage.ts`                       | (unchanged — needs vscode config for bootstrapping)                                 |
| `src/utils/autoImportSettings.ts`            | (unchanged — needs vscode config for bootstrapping)                                 |
| `src/extension.ts`                           | Remove allowedCommands seed (A1); add migration helper (D5)                         |
| `src/api/providers/vscode-lm.ts`             | Read vsCodeLmModelSelector from ContextProxy (A4)                                   |
| webview Settings UI files                    | Add rows for A4–A13                                                                 |
| `docs/settings_overlay.md`                   | Update backend count, remove individual-keys section                                |
| `docs/configuration.md`                      | Rewrite as Global Settings reference (D6)                                           |
