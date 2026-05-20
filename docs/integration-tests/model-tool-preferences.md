# Model Tool Preferences — Integration Test Scenarios

Tests for per-model tool inclusion/exclusion, alias resolution, versioned
cloud settings, and the filter pipeline integration.

## Prerequisites

- Shofer extension running with at least:
    - An OpenAI-compatible profile via OpenRouter.
    - A Gemini API profile.
    - A Vertex AI profile.
    - A Shofer Cloud profile (if cloud testing is available).
- A workspace with a few files for edit testing.

---

## Scenario 1: OpenAI (router) — apply_patch preferred

**Goal:** Verify that OpenAI models via OpenRouter receive `apply_patch` and
lose `apply_diff` + `write_to_file`.

1. Start a new task in Code mode with an OpenAI model via OpenRouter.
2. Ask Shofer to edit a file (e.g., "Add a comment to src/foo.ts").
3. Confirm `apply_diff` is **not** in the model's tool list (check the system
   prompt or observe no `apply_diff` calls in chat).
4. Confirm `apply_patch` **is** in the tool list and the model uses it for
   edits.
5. Confirm `write_to_file` is also excluded — the model uses `apply_patch`
   rather than overwriting the file.

**Expected:** OpenAI router models use `apply_patch` for edits; `apply_diff`
and `write_to_file` are unavailable.

---

## Scenario 2: Gemini — edit preferred

**Goal:** Verify that Gemini models receive `edit` instead of `apply_diff`.

1. Start a new task in Code mode with a Gemini model.
2. Ask Shofer to edit a file.
3. Confirm `apply_diff` is **not** offered to the model.
4. Confirm `edit` **is** offered and the model uses old-string/new-string
   replacement.

**Expected:** Gemini models use `edit`; `apply_diff` is excluded.

---

## Scenario 3: Vertex AI — edit preferred (same as Gemini)

**Goal:** Verify Vertex Gemini models receive the same preferences as native
Gemini.

1. Start a new task in Code mode with a Vertex AI Gemini model.
2. Ask Shofer to edit a file.
3. Confirm `apply_diff` is excluded.
4. Confirm `edit` is included and used.

**Expected:** Vertex Gemini models behave identically to native Gemini.

---

## Scenario 4: Anthropic / DeepSeek — no special preferences

**Goal:** Verify that models with no explicit preferences use the default
tool set.

1. Start a new task in Code mode with an Anthropic model.
2. Ask Shofer to edit a file.
3. Confirm `apply_diff` **is** available (not excluded).
4. Confirm all standard edit tools are present.
5. Repeat with a DeepSeek model (if available) and confirm same result.

**Expected:** All standard tools are available; no exclusions or inclusions
are applied.

---

## Scenario 5: Tool alias resolution — write_file → write_to_file

**Goal:** Verify that when a model specifies `write_file` (the alias) in its
`includedTools`, the canonical `write_to_file` is added and renamed back to
`write_file` in API requests.

1. Configure (or simulate) a model with `includedTools: ["write_file"]`.
2. Start a task and observe tool availability.
3. Confirm `write_to_file` appears in the mode-allowed tool set.
4. Confirm the API request renames `write_to_file` back to `write_file`.

**Expected:** Alias is resolved to canonical form for filtering, but presented
to the model under the alias name.

---

## Scenario 6: Tool alias resolution — search_and_replace → edit

**Goal:** Verify `search_and_replace` alias resolves to `edit`.

1. Configure (or simulate) a model with `includedTools: ["search_and_replace"]`.
2. Start a task and observe tool availability.
3. Confirm `edit` is added to the allowed set (with group membership check).
4. Confirm the API request renames `edit` to `search_and_replace`.

**Expected:** Same alias-resolution pattern as Scenario 5.

---

## Scenario 7: Shofer Cloud versioned settings

**Goal:** Verify versioned settings resolve correctly based on extension
version.

1. Configure the Shofer Cloud API to return `versionedSettings` with:
    ```json
    {
    	"3.36.4": { "includedTools": ["apply_diff"], "excludedTools": ["write_to_file"] },
    	"3.35.0": { "includedTools": ["search_replace"] }
    }
    ```
2. Start Shofer at version 3.36.4 or higher.
3. Confirm `apply_diff` is included and `write_to_file` is excluded (3.36.4
   settings win).
4. Start Shofer at version 3.35.5 (between 3.35.0 and 3.36.4).
5. Confirm **only** `search_replace` is included (3.35.0 is the highest
   version ≤ current).
6. Start Shofer at version 3.34.0 (below all version keys).
7. Confirm the plain `settings` object applies (not versioned).

**Expected:** Versioned settings resolve to the highest version ≤ current
extension version; plain settings are the fallback.

---

## Scenario 8: Shofer Cloud plain settings

**Goal:** Verify plain (non-versioned) cloud settings apply correctly.

1. Configure the Shofer Cloud API to return only plain `settings`:
    ```json
    { "settings": { "includedTools": ["apply_patch"], "excludedTools": ["apply_diff"] } }
    ```
2. Start a task with the cloud-linked model.
3. Confirm `apply_diff` is excluded and `apply_patch` is included.

**Expected:** Plain settings apply regardless of extension version.

---

## Scenario 9: excludedTools + includedTools interaction with mode groups

**Goal:** Verify that `includedTools` only adds tools whose groups are
allowed by the current mode.

1. Start a task in **Ask mode** (read-only — write group not allowed).
2. Configure a model with `includedTools: ["apply_diff"]`.
3. Confirm `apply_diff` is **not** available (write group is not in Ask mode).
4. Switch to **Code mode** (write group allowed).
5. Confirm `apply_diff` **is** available.

**Expected:** `includedTools` are gated by mode group membership, not
unconditionally added.

---

## Scenario 10: excludedTools removes tools regardless of group

**Goal:** Verify that `excludedTools` removes tools unconditionally.

1. Start a task in Code mode with a Gemini model.
2. Confirm `apply_diff` is excluded (per Gemini preferences).
3. Confirm **no** other write tools are affected (`write_to_file`, `sed`, etc.
   remain available).
4. Switch to Architect mode (if write group is allowed there too).
5. Confirm `apply_diff` is still excluded.

**Expected:** `excludedTools` removes tools regardless of mode — it's a
hard exclusion.

---

## Scenario 11: disabledTools setting overrides model preferences

**Goal:** Verify the user-facing `disabledTools` setting can remove tools
that model preferences would otherwise include.

1. Configure `disabledTools: ["edit"]` in settings.
2. Start a task with a Gemini model (which prefers `edit`).
3. Confirm `edit` is **not** available despite Gemini's preferences.
4. Verify `apply_diff` is still excluded (Gemini preference still active).

**Expected:** `disabledTools` removes tools after model customization,
overriding both inclusions and exclusions for user-specified tools.

---

## Scenario 12: Tool switching across model changes

**Goal:** Verify that tool preferences update when switching API profiles
mid-task.

1. Start a task with a Gemini model (edit tool available, apply_diff excluded).
2. Switch the API profile to an OpenAI router model.
3. Confirm `edit` is no longer available.
4. Confirm `apply_patch` is now available.
5. Switch back to Gemini.
6. Confirm `edit` is available again and `apply_diff` is excluded.

**Expected:** Tool preferences are re-evaluated on every model switch; no
stale state leaks between providers.
