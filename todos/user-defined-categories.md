# TODO: User-defined (dynamic) tool categories

Today the tool-category vocabulary is **closed**: `toolGroups` in
`packages/types/src/tool.ts` is a 9-member const enum, every schema that
mentions a group validates against it, and each group maps to a hand-wired
`alwaysAllow*` settings key with a hand-rendered UI toggle. The target state:

1. **The existing categories work as-is.** The 8 builtin groups that carry
   native tools or special semantics (`read`, `write`, `execute`, `mcp`,
   `mode`, `subtasks`, `questions`, `uncategorized`) keep their exact current
   behavior, their flat `alwaysAllow*` toggles, and their UI rows.
2. **A category is created on demand.** When a tool is registered under a
   group name that is not a builtin — an MCP server declaring
   `_meta["shofer.dev/toolGroup"]: "salesforce"`, a user `toolGroups` override
   in `mcp.json`, a private-tool provider's `group`, a plugin's custom-tool
   `group`, or a name typed into the MCP group dropdown — that name becomes a
   **dynamic category**: it is validated as a slug, registered in a runtime
   registry, and from then on behaves like a builtin for mode filtering and
   auto-approval. Previously an unknown group string was silently dropped to
   `uncategorized`; the new behavior is equally fail-closed (the new
   category's toggle defaults to absent = ask), it just stops lying about the
   category's name.
3. **UI and API support.** Every registered dynamic category appears in the
   Auto-Approve settings section and in the chat Auto-Approve dropdown with
   its own toggle. The toggle state lives in ONE new settings key,
   `alwaysAllowGroups: Record<string, boolean>`, which flows through the
   layered `.shofer/` scopes, `ContextProxy`, the `updateSettings` webview
   message, the headless posture seed, and `ExtensionState` like any other
   setting — so a controller driving the ShoferApi can read and set it.
4. **`browser` becomes the first dynamic category.** It has zero native tools
   (`TOOL_GROUPS.browser.tools` is `[]`); every browser tool arrives over MCP
   and is classified by the `browser_` prefix inference. Removing `browser`
   from the static enum and deleting the flat `alwaysAllowBrowser` key
   exercises the whole dynamic path end to end — registration, toggle
   storage, UI rendering, headless posture — using a category that already
   has real tools on real deployments.

Per the repo's no-backward-compatibility rule there is **no migration**: the
flat `alwaysAllowBrowser` key is deleted, not aliased. A stale
`alwaysAllowBrowser` in an old `settings.json` is stripped by
`globalSettingsSchema.partial()` like any unknown key. Bump the extension
**minor** version (persisted-state shape change).

## Target-state model

```mermaid
flowchart TD
    SRC1["MCP _meta toolGroup / opGroups"] --> REG
    SRC2["mcp.json toolGroups override"] --> REG
    SRC3["private-tool provider group"] --> REG
    SRC4["plugin custom-tool group"] --> REG
    SRC5["prefix inference browser_ / ide_"] --> REG
    REG["category registry<br/>builtins ∪ dynamic (slug-validated)"] --> UI["Settings + Auto-Approve dropdown<br/>one toggle per category"]
    REG --> GATE["isGroupAutoApproved:<br/>builtin → GROUP_GATE flat toggle<br/>dynamic → alwaysAllowGroups[name]"]
    UI -->|"updateSettings"| MAP["alwaysAllowGroups: Record&lt;string, boolean&gt;<br/>one globalSettingsSchema key"]
    MAP --> GATE
```

Design decisions, settled (do not re-litigate without a reason):

- **Name validation** reuses the skill-name slug rule
  (`/^[a-z0-9]+(-[a-z0-9]+)*$/`, max 64) via a new `toolGroupNameSchema` in
  `packages/types/src/tool.ts`. A string that fails the slug rule is dropped
  to `uncategorized` exactly as unknown strings are dropped today — that path
  is the malformed-input guard and stays fail-closed.
- **`ToolGroup` widens to `string`.** Keep `BuiltinToolGroup` (the 8 literals)
  for the exhaustive records (`TOOL_GROUPS`, `GROUP_GATE`); export
  `ToolGroup = string` (optionally `BuiltinToolGroup | (string & {})` for
  editor hints). Everywhere currently typed `ToolGroup` that can carry a
  dynamic name (MCP tool metadata, mode group entries, private-tool meta)
  takes the wide type; the two exhaustive Records take `BuiltinToolGroup`.
- **Toggle shape: one record key, not synthesized flat keys.** A dynamic
  `alwaysAllow<Something>` key can never be routed — `ContextProxy` routes by
  `GLOBAL_STATE_KEYS`, `globalSettingsSchema` strips unknown keys, and
  `parseScopeSettings` silently drops them. The precedent for an open bucket
  in the schema is `pluginConfigs`. `alwaysAllowGroups` is consulted **only
  for non-builtin groups** — a builtin name inside the map is ignored, so
  each category has exactly one source of truth for its toggle.
- **Wildcard:** `alwaysAllowGroups["*"] === true` approves every dynamic
  category; an explicit per-category `false` beats the wildcard (same
  deny-by-exception shape as `allowedCommands`/`deniedCommands`). The
  wildcard exists for the unattended headless seed, whose rationale ("the
  person who typed the command is the author of that grant") covers
  categories nobody has met yet.
- **Dynamic categories get no modifier toggles** (no outside-workspace /
  protected variants). Those modifiers are `read`/`write`-specific and
  `isPathAutoApproved` already refuses other groups.
- **No danger ordering.** The integrator-side "tool-level group is the max
  over op groups" rule is computed on the Go server side; in this repo group
  gates are independent booleans, and dynamic categories change nothing
  about that. Do not invent a `MostDangerousGroup` here.
- **Mode filtering needs no semantics change.** Matching is already plain
  string-set matching (`filterMcpToolsForMode`, `filterPrivateToolsForMode`);
  a mode lists a dynamic category by name and sees its tools, exactly like a
  builtin. Only the schemas that would reject the name at load time change.
  Builtin modes keep listing `"browser"` — it is now simply a dynamic name
  they happen to name.

## Steps

Order matters: each step builds and tests green on its own, and later steps
depend on the types the earlier ones open.

### 1. Open the vocabulary in `@shofer/types`

Files: `packages/types/src/tool.ts`, `packages/types/src/mode.ts`,
`packages/types/src/modes.ts`, `packages/types/src/shofermodes-schema.ts`,
`packages/types/src/mcp.ts`, `packages/types/src/custom-tool.ts`,
`packages/types/src/vscode-extension-host.ts`,
`packages/types/src/global-settings.ts`.

- `tool.ts`: add `toolGroupNameSchema` (slug regex above); remove `"browser"`
  from the `toolGroups` const (leaving 8 builtins); introduce
  `BuiltinToolGroup` (from the remaining enum) and widen `ToolGroup` to
  `string`; retype `TOOL_GROUPS` as `Record<BuiltinToolGroup, ToolGroupConfig>`
  and delete its empty `browser` entry. Fix the stale "8 categories" doc
  comment while there.
- `mode.ts` / `shofermodes-schema.ts`: replace every `toolGroupsSchema` arm of
  `groupEntrySchema` with `toolGroupNameSchema` (all three arms, including the
  `scopedGroupEntrySchema` refine). Plugin mode contributions
  (`plugin.ts` `pluginModeContributionSchema`) inherit this automatically —
  verify, don't duplicate.
- `modes.ts`: `getGroupName` returns `string`; `getToolsForMode` must treat a
  group with no `TOOL_GROUPS` entry as an empty native set
  (`TOOL_GROUPS[name]?.tools ?? []`) — today it throws a TypeError, protected
  only by the schema wall this step removes.
- `mcp.ts`: `McpTool.group` / `McpTool.opGroups` widen to `string`.
- `custom-tool.ts`: `CustomToolDefinition.group` widens to `string`.
- `vscode-extension-host.ts`: the `setMcpToolGroup` message's
  `toolGroup` field widens to `string | null`; remove `alwaysAllowBrowser`
  from the `ExtensionState` pick and the `GlobalSettings` key union; add
  `alwaysAllowGroups` and `dynamicToolGroups: string[]` (the registry
  snapshot, step 3) to `ExtensionState`.
- `global-settings.ts`: add
  `alwaysAllowGroups: z.record(z.string(), z.boolean()).optional()` to
  `globalSettingsSchema`; delete `alwaysAllowBrowser`; update
  `EVALS_SETTINGS` (drop `alwaysAllowBrowser`, add an explicit
  `alwaysAllowGroups` if evals need `browser`).

Unblocks everything below. Tests: type-level; update the schema tests that
assert rejection of unknown group names to assert acceptance of slugs and
rejection of non-slugs.

### 2. The settings key end to end (host)

Files: `src/core/webview/webviewMessageHandler.ts`,
`src/core/webview/ShoferProvider.ts`,
`packages/core/src/config/layered-settings-file.ts` (tests only — see below).

- `updateSettings` handling needs no per-key branch: `alwaysAllowGroups` is
  one known key routed by `ContextProxy` like any other; the webview sends the
  WHOLE merged record (the webview owns merge-on-edit, same as it would for
  any object-valued setting).
- `ShoferProvider.getStateToPostToWebview()` / `getState()`: ship
  `alwaysAllowGroups ?? {}` (replacing the `?? false` for the deleted
  `alwaysAllowBrowser`).
- Verify with a test that `parseScopeSettings` round-trips
  `alwaysAllowGroups` from a `.shofer/settings.json` scope (this is the path
  that silently strips unknown keys; the record is a known key so it survives,
  but pin it) and that `mergeLayeredConfig` / `locked.json` key-path locking
  behave sanely for one record-valued key. Locking granularity: the bare key
  `alwaysAllowGroups` locks the whole map; per-category locking
  (`alwaysAllowGroups.browser`) works only if the key-path matcher descends
  into record values — check `isPathLocked` in
  `packages/core/src/config/layered-config.ts` and either support it or
  document that the lock is whole-map.

Unblocks steps 4, 6, 7.

### 3. The dynamic-category registry

New module `packages/core/src/tool-groups/category-registry.ts` (singleton
re-export at the definition site, per the Singleton Re-export Rule):
`registerToolGroup(name: string)` (slug-validates, no-ops on builtins and
known names), `getDynamicToolGroups(): string[]`, and a change subscription.
Registration call sites — every place a group string enters the system:

- `packages/core/src/services/mcp/McpHub.ts`:
    - `resolveGroup` (currently `toolGroupsSchema.safeParse`, dropping unknown
      strings) → `toolGroupNameSchema.safeParse` + `registerToolGroup` on
      success. Same for `resolveOpGroups` per entry.
    - `BaseConfigSchema.toolGroups`: `z.record(toolGroupsSchema)` →
      `z.record(toolGroupNameSchema)`.
    - `setToolGroup`: `toolGroupsSchema.parse(group)` → `toolGroupNameSchema.parse(group)`
      (this is what makes a name typed into the MCP UI dropdown create a
      category).
- `packages/core/src/task/build-tools.ts`: `resolvePrivateToolGroup`'s two
  `toolGroupsSchema.options.includes(...)` guards → slug validation +
  registration. `restrictToolsToDeclaredGroups`'s fail-closed filter likewise
  accepts slugs (a task restricted to a not-yet-registered category is
  legitimate: the tools arrive when their server connects).
- `packages/core/src/custom-tools/custom-tool-registry.ts`: register
  `CustomToolDefinition.group` at registration time.
- `packages/core/src/auto-approval/tools.ts`: the `browser_` prefix inference
  keeps returning `"browser"` — now resolved against the registry, which is
  what creates the `browser` category on first sight of a browser tool. The
  `ide_` → `execute` inference is unchanged (`execute` stays builtin).

Surface the snapshot on `ExtensionState.dynamicToolGroups` (set in step 1's
type change; populated by `ShoferProvider` from the registry, refreshed on
registry change and on MCP server connect/disconnect).

Unblocks steps 4 and 7. Tests: registration from each call site; slug
rejection; no duplicate/builtin registration.

### 4. The gate: `GROUP_GATE` + `checkAutoApproval`

Files: `packages/core/src/auto-approval/group-gates.ts`,
`packages/core/src/auto-approval/index.ts`,
`packages/core/src/auto-approval/mcp.ts`,
`packages/core/src/tools/validateToolUse.ts`.

- `group-gates.ts`:
    - `AutoApprovalState` union: delete `alwaysAllowBrowser`.
    - `GROUP_GATE`: retype to `Record<BuiltinToolGroup, GroupGate>`; delete the
      `browser` entry.
    - `isGroupAutoApproved(group: string, ...)`: look up `GROUP_GATE[group]`; on
      a miss (dynamic category) the gate is
      `state.alwaysAllowGroups?.[group] === true ||
 (state.alwaysAllowGroups?.[group] === undefined && state.alwaysAllowGroups?.["*"] === true)`.
      Absent = false, so an unconfigured dynamic category always asks —
      identical fail-closed posture to today's drop-to-`uncategorized`. Keep
      `applyModifiers` a no-op for dynamic groups (no modifier toggles exist
      for them).
    - The exhaustiveness test in `__tests__/group-gates.spec.ts`
      (`toolGroups.filter((g) => !(g in GROUP_GATE))`) keeps passing unchanged —
      it now also proves no dynamic name leaked into the static table.
- `index.ts` (`checkAutoApproval`): replace the closed whitelist
  `toolGroup === "browser" || toolGroup === "read" || toolGroup === "write"`
  with: `read`/`write` keep their modifier-bearing path
  (`applyModifiers: true`, plus the existing `batchFiles` outside-workspace
  refinement); **every other resolved group — builtin or dynamic — goes
  through `isGroupAutoApproved(group, state, {}, { applyModifiers: false })`**,
  which lands dynamic categories (browser included) on their
  `alwaysAllowGroups` entry and previously-unreachable builtins on their
  existing gates. Add `alwaysAllowGroups` to the `state` Pick surface.
  Delete the comment citing `browser` → `alwaysAllowBrowser`.
- `mcp.ts`: `getMcpToolGroup` return type widens to `string`; resolution
  order (user override → op group → tool group → `uncategorized`) unchanged.
- `validateToolUse.ts` (`isToolAllowedForMode`): `TOOL_GROUPS[groupName]` →
  tolerate unknown groups (empty native tool set), same rule as
  `getToolsForMode` in step 1.

Tests: `alwaysAllowGroups: { browser: true }` approves a `browser_navigate`
call and a `browser`-grouped MCP call; absent key asks; `"*"` approves,
explicit `false` overrides `"*"`; a builtin name in the map is ignored;
`browser` absent from `GROUP_GATE`.

### 5. Headless posture (CLI)

File: `apps/cli/src/agent/approval-posture.ts` (+ its test).

- `APPROVAL_POSTURE_KEYS`: replace `alwaysAllowBrowser` with
  `alwaysAllowGroups` (the comment "This is the exact set config may take
  over" is the contract — keep it exact).
- `unattendedApprovalSeed()`: replace `alwaysAllowBrowser: true` with
  `alwaysAllowGroups: { "*": true }` — the seed's contract is "every declared
  capability", and a category first declared by a server connecting mid-run
  is exactly the case the wildcard exists for.
- `defaultApprovalSeed()` (serve): unchanged — seeds only
  `autoApprovalEnabled: false`; absent `alwaysAllowGroups` denies, which is
  the intended posture.
- `describeApprovalPosture` / `resolveApprovalPosture`: render the record
  readably in diagnostics.

### 6. Webview: toggles for categories nobody hardcoded

Files: `webview-ui/src/components/settings/AutoApproveToggle.tsx`,
`webview-ui/src/components/settings/AutoApproveSettings.tsx`,
`webview-ui/src/components/chat/AutoApproveDropdown.tsx`,
`webview-ui/src/components/settings/SettingsView.tsx`,
`webview-ui/src/context/ExtensionStateContext.tsx`,
`webview-ui/src/hooks/useAutoApprovalToggles.ts`,
`webview-ui/src/hooks/useAutoApprovalState.ts`,
`webview-ui/src/components/mcp/McpToolRow.tsx`,
`webview-ui/src/components/settings/ToolsSettings.tsx`,
`webview-ui/src/i18n/locales/en/settings.json` (+ `chat.json`; other locales
sync from en).

- `AutoApproveToggle.tsx`: keep `autoApproveSettingsConfig` for the 8 builtin
  toggles (minus browser). Export a second, data-driven renderer: for each
  name in `dynamicToolGroups` (from extension state), one toggle row reading
  `alwaysAllowGroups[name]`, writing the merged record via `updateSettings`.
  Labels for a dynamic category are NOT hand-keyed i18n entries — use a
  generic template (`settings:autoApprove.dynamic.label` /
  `.description` with `{{name}}` interpolation, e.g. "Always allow {{name}}
  tools"), satisfying the i18n String Rule without per-category keys. Fix the
  existing drift: `useAutoApprovalState`'s local interface omits
  `alwaysAllowUncategorized` — align while editing these hooks.
- `AutoApproveSettings.tsx`: render the dynamic rows as a "Custom categories"
  block after the builtin toggles; no per-category conditional sections
  (dynamics have no modifiers).
- `AutoApproveDropdown.tsx`: append dynamic categories to the list; the
  mode-group filter (`getModeAllowedGroups`) keeps working because it is
  string matching — a dynamic category shows in the dropdown exactly when the
  current mode lists it. Replace the hardcoded per-key setter switch with the
  generic record write.
- `ExtensionStateContext.tsx`: drop the `setAlwaysAllowBrowser` setter; add a
  generic `setDynamicToolGroupApproval(name, value)` that posts
  `updateSettings` with the merged `alwaysAllowGroups`.
- `SettingsView.tsx`: remove `alwaysAllowBrowser` from the destructure /
  payload / props; add `alwaysAllowGroups` and `dynamicToolGroups`.
  Save-gating and change-detection specs need the new key.
- `McpToolRow.tsx`: the group dropdown offers builtin groups + registered
  dynamic categories + a free-text "new category…" entry (validated against
  the slug rule client-side; the host re-validates in `setToolGroup`). This
  is the UI path that CREATES a category.
- `ToolsSettings.tsx`: the `Record<ToolGroup, McpToolEntry[]>` reduce and the
  `for (const group of toolGroups)` section loop must iterate builtins ∪
  dynamic (from the registry snapshot) so a tool in a dynamic category gets a
  section.

Tests: `AutoApproveToggle.spec.tsx` gains dynamic-row rendering + write
tests; SettingsView change-detection/unsaved-changes specs cover
`alwaysAllowGroups`; dropdown spec covers mode filtering of a dynamic
category.

### 7. Rules and docs in this repo (same change as the code they document)

Per the Documentation Lock-Step Rule:

- `AGENTS.md` — rewrite the **Tool Group Count Coherence Rule**: the
  enumeration is no longer "exactly 9 members"; the rule becomes "8 builtins,
  fixed; new categories are dynamic and require NO coordinated change — if
  you are editing five files to add a category, you are adding a builtin,
  which needs justification". Update the Tool-Group Dual-Resolution Rule's
  prefix-inference paragraph (browser is now dynamic).
- `docs/tool-categories.md` — the primary consumer doc: the 9-category table
  becomes 8 builtins + the dynamic model; `browser` is the worked example of
  a dynamic category; the `getToolGroupForSayTool` prefix section and the
  "browser group has zero native tools" gap note are rewritten; the "Adding a
  New Extension's Tools" section now says "pick any slug — the category is
  created on first use".
- `docs/auto_approval.md` — toggles table (delete `alwaysAllowBrowser`, add
  the `alwaysAllowGroups` row explaining the record + wildcard), the
  `GROUP_GATE` table (browser row moves to the dynamic mechanism), the
  headless-seed paragraph, and the MCP per-group gate prose.
- `docs/configuration.md` — the headless-posture section's key enumeration.
- `docs/terminology.md` §10 (Tool Groups).
- `plugins/builtin-config/docs/modes.md` — the `TOOL_GROUPS` section and the
  per-mode group tables (the modes still list `browser`; what changes is what
  `browser` IS).
- `docs/adding-new-tools.md` — Step 3 (assign to a group) and Step 10
  (auto-approval): a new tool may name a new slug.
- `docs/tool_access.md` — if it enumerates groups where it describes
  `computeToolAccess`; check and sync.

### 8. Integrator follow-ups (arkware.ai parent repo — separate commit, after this lands)

The submodule is public; per the No Cross-Repo Link Rule these references are prose, not links.

- `shared/integrationmanifest/approvalposture.go`: the posture-key catalog
  and per-key guidance table enumerate `alwaysAllowBrowser`; rule 11 must
  learn `alwaysAllowGroups` (a map: recurse into it — an integration must not
  auto-approve `browser` or any other acting category, and an ABSENT key is
  reported exactly like a `true` one).
- `shared/shoferbundle/shofer-settings.schema.json`: add the
  `alwaysAllowGroups` object; delete `alwaysAllowBrowser`.
- Integration manifests declaring `alwaysAllowBrowser`
  (`integrations/gmail/integration.json`, `integrations/phone/integration.json`)
  move it to `alwaysAllowGroups: { "browser": false }` — stated, because the
  manifest is the reviewable statement and silence would read as ASK-by-
  omission either way.
- `infra/kapitan/templates/setup/63-init-l2-agent-bundle.sh.j2`: the L2
  bundle's seeded posture keys.
- Parent docs carrying the key: `docs/integrations/approvals.md`,
  `docs/integrations/model.md`, `docs/bundles/l2-agent-config-bundle.md`,
  `docs/telephony/phone_conversations.md`,
  `docs/phones/android_remote_control.md`,
  `docs/phones/skills/provision-android-operator/SKILL.md`,
  `.claude/rules/agent-tools.md` (the "write/browser/execute groups" prose),
  and `integration-tests/research/shofer-contracts.md`.

## Acceptance

- Registering an MCP server whose tool declares
  `_meta["shofer.dev/toolGroup"]: "salesforce"` (no config anywhere names
  that string) results in: a `salesforce` category in the registry, a
  `salesforce` toggle in Settings and in the chat dropdown, and a call to the
  tool asking until that toggle (or `"*"`) is on.
- `browser` works exactly as before for a user who turns its toggle on —
  including over MCP and via prefix-inferred say tools — with
  `alwaysAllowBrowser` gone from schema, seeds, UI, and docs.
- A `.shofer/settings.json` carrying `alwaysAllowGroups: { "salesforce": true }`
  survives `parseScopeSettings` and auto-approves.
- `shofer run` (unattended) auto-approves a dynamic-category tool via the
  `"*"` seed; `shofer serve` asks.
- `go…` — n/a; the gate here is `pnpm` per-package: `check-types` plus the
  per-package vitest runs for `types`, `core`, `cli`, and `webview-ui` (see
  `.shofer/commands/test.md`).

## Notes

- Persisted-state shape change (new key, deleted key) → bump the extension
  **minor** version (`Y` in `X.Y.Z`); patch stays derived.
- Shofer ships in two images in the parent repo (`shofer-l2-worker`,
  `code-server`); landing step 8 requires a submodule bump there, which
  redeploys both.
- Non-goal: per-operation groups (`opGroups`) are untouched — a dynamic
  category name can appear in an `opGroups` value and registers the same way.
- Non-goal: deleting a category. A registered name lives for the session;
  stale names in `alwaysAllowGroups` are inert map entries, not an error.
