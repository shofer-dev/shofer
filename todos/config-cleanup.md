# Shofer Configuration Backend Cleanup

**Goal:** Reduce the number of config storage backends from 4 to 2 (plus file-based configs)
and eliminate duplication between the profiles blob and individual SecretStorage keys.

Current backends (too many):

1. `package.json` `contributes.configuration.properties` — VS Code Settings editor (18 keys)
2. `globalState` (SQLite) — ContextProxy (~126 keys)
3. `SecretStorage` individual keys — 31 API key entries
4. `SecretStorage` profiles blob — `shofer_config_api_config` (duplicates #3)

Target backends (simplified):

1. `globalState` (SQLite) — all runtime settings via ContextProxy
2. `SecretStorage` profiles blob — sole source of truth for API keys + profiles
3. (unchanged) `.shofermodes`, `custom_modes.yaml`, `mcp_settings.json` — file-based configs

---

## Part A: Port 14 VS Code config settings to globalState/ContextProxy

Each requires: (a) add key to `globalSettingsSchema` if missing, (b) update consumer from
`vscode.workspace.getConfiguration("shofer").get("key")` to `ContextProxy.getValue("key")`,
(c) add Settings UI row in the Shofer webview, (d) remove from `package.json`
`contributes.configuration.properties`.

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

## Migration order (recommended)

1. **Part C first** (dead code removal) — zero risk, immediate cleanup.
2. **Part A** (port 14 settings) — one setting at a time, each with its own Settings UI row.
   Start with A1/A2 (already dual-written, easiest). End with A4/A7 (need schema additions).
3. **Part B** (remove individual keys) — last, after all reads go through ContextProxy.
   Requires the A migration to be complete so all secret reads use the new routing.
4. **Part D** (simplifications) — sweep after A+B are done.

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
