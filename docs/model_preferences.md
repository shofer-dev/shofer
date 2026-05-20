# Model Tool Preferences

This document records the tool inclusion/exclusion and alias preferences configured in the codebase for various providers and models.

## Tool Aliases

Defined in [`packages/types/src/tool.ts`](../packages/types/src/tool.ts:266):

| Alias                | Canonical Tool  | Notes                                       |
| -------------------- | --------------- | ------------------------------------------- |
| `write_file`         | `write_to_file` | Shorter name used by some models            |
| `search_and_replace` | `edit`          | Alternative name for the `edit` custom tool |

When a model specifies an alias in `includedTools`, the system:

1. Resolves the alias to the canonical tool name
2. Adds the canonical tool to the allowed set
3. Renames the canonical tool back to the alias in the API response

---

## Provider-Specific Preferences

### OpenAI (Native Provider)

Not explicitly set in code — uses default tool set.

### OpenAI (via OpenRouter/Requesty)

Applied in [`src/api/providers/utils/router-tool-preferences.ts`](../src/api/providers/utils/router-tool-preferences.ts:16):

```typescript
if (modelId.includes("openai")) {
	excludedTools: ["apply_diff", "write_to_file"]
	includedTools: ["apply_patch"]
}
```

| Setting       | Value                                               |
| ------------- | --------------------------------------------------- |
| **Excluded**  | `apply_diff`, `write_to_file`                       |
| **Included**  | `apply_patch`                                       |
| **Rationale** | OpenAI models perform better with patch-style edits |

### Gemini (Native Provider)

Applied in [`src/api/providers/gemini.ts`](../src/api/providers/gemini.ts:357):

```typescript
{
	excludedTools: ["apply_diff"]
	includedTools: ["edit"]
}
```

| Setting       | Value                                                    |
| ------------- | -------------------------------------------------------- |
| **Excluded**  | `apply_diff`                                             |
| **Included**  | `edit`                                                   |
| **Rationale** | Gemini models prefer string replacement over diff format |

### Vertex AI (Native Provider)

Applied in [`src/api/providers/vertex.ts`](../src/api/providers/vertex.ts:28):

```typescript
{
	excludedTools: ["apply_diff"]
	includedTools: ["edit"]
}
```

| Setting       | Value                                        |
| ------------- | -------------------------------------------- |
| **Excluded**  | `apply_diff`                                 |
| **Included**  | `edit`                                       |
| **Rationale** | Same as Gemini — Vertex uses Google's models |

---

## Shofer Cloud (API-Configured)

Settings are fetched from the Shofer Cloud API and applied per model. The API supports two configuration mechanisms:

### Plain Settings

Static values applied to all client versions:

```json
{
	"settings": {
		"includedTools": ["apply_patch"],
		"excludedTools": ["apply_diff", "write_to_file"]
	}
}
```

### Versioned Settings

Version-keyed settings for client-specific behavior:

```json
{
	"versionedSettings": {
		"3.36.4": {
			"includedTools": ["search_replace", "apply_diff"],
			"excludedTools": ["write_to_file"]
		},
		"3.35.0": {
			"includedTools": ["search_replace"]
		}
	}
}
```

**Resolution logic** (from [`src/api/providers/fetchers/versionedSettings.ts`](../src/api/providers/fetchers/versionedSettings.ts:1)):

1. Find the highest version key ≤ current client version
2. If found, use those settings exclusively
3. Otherwise, fall back to plain `settings`

---

## Summary Table

| Provider            | Excluded Tools                | Included Tools  | Effect                    |
| ------------------- | ----------------------------- | --------------- | ------------------------- |
| **OpenAI (router)** | `apply_diff`, `write_to_file` | `apply_patch`   | Uses codex-style patching |
| **Gemini**          | `apply_diff`                  | `edit`          | Uses string replacement   |
| **Vertex**          | `apply_diff`                  | `edit`          | Uses string replacement   |
| **Shofer Cloud**    | Varies by model               | Varies by model | API-configured per model  |

---

## How Tool Filtering Works

The filtering pipeline in [`src/core/prompts/tools/filter-tools-for-mode.ts`](../src/core/prompts/tools/filter-tools-for-mode.ts:225):

1. **Mode groups** — Collect tools from the mode's allowed groups (e.g., `read`, `edit`, `command`, `mcp`)
2. **Always-available** — Add tools from `ALWAYS_AVAILABLE_TOOLS`
3. **Permission checks** — Filter via `isToolAllowedForMode()`
4. **Model customization** — Apply `excludedTools` (remove) and `includedTools` (add, if group allowed)
5. **Feature gates** — Remove `rag_search` (no index), `generate_image` (experiment off), etc.
6. **Alias renames** — Rename canonical tools to aliases for API consistency

---

## Legacy/Custom Edit Tools

These are opt-in tools in the `edit.customTools` array:

| Tool             | Format                                       | Primary Users      |
| ---------------- | -------------------------------------------- | ------------------ |
| `edit`           | `old_string`/`new_string` with `replace_all` | Gemini, Vertex     |
| `search_replace` | `old_string`/`new_string` (strict)           | Versioned settings |
| `edit_file`      | `old_string`/`new_string` + fuzzy matching   | Custom configs     |
| `apply_patch`    | Unified diff (`@@` hunks)                    | OpenAI models      |

They are only available when explicitly included via `modelInfo.includedTools`.

---

## Gaps, Issues & Improvement Areas

This section records deficiencies discovered during the May 2026 verification review. Revisit when the tool-preference subsystem changes.

1. **Code example is a pedagogic simplification, not byte-for-byte source.** The OpenAI router prefs block (lines 32–37) shows a literal `if` with bare `excludedTools: […]` / `includedTools: […]` syntax. The actual source in [`router-tool-preferences.ts`](../src/api/providers/utils/router-tool-preferences.ts:22-26) uses spread-into-Set deduplication (`[...new Set([...(result.excludedTools||[]), "apply_diff", "write_to_file"])]`). The simplified version is clearer for human readers but won't match a grep of the codebase. Consider adding a note that the code is "simplified for clarity" or showing the real source verbatim.

2. **Missing coverage of other native providers.** The doc covers Gemini, Vertex, and OpenAI-via-router but doesn't mention Anthropic, DeepSeek, Ollama, or VS Code LM providers. If any of those gain tool preferences, this doc will silently go stale. Add a section or an explicit note that "these providers currently apply no tool preferences."

3. **Shofer Cloud fetcher entry point not documented.** The doc describes resolution logic but doesn't link to the actual fetcher that loads settings from the API. The closest reference is [`versionedSettings.ts`](../src/api/providers/fetchers/versionedSettings.ts) which only handles version-keyed resolution — it doesn't perform the API fetch. Add a pointer to the file that calls `resolveVersionedSettings` (likely a model-info fetcher).

4. **`disabledTools` setting not mentioned.** The filter pipeline in [`filter-tools-for-mode.ts`](../src/core/prompts/tools/filter-tools-for-mode.ts:310) also supports a `disabledTools` array that removes tools regardless of mode groups or model preferences. This is a user-facing knob orthogonal to the model-preference mechanism and should be documented.

5. **`edit.customTools` source not linked.** The Legacy/Custom Edit Tools table lists `edit_file`, `search_replace`, and `apply_patch` as being in `edit.customTools` but doesn't link to the `TOOL_GROUPS` constant where `edit` group's `customTools` array is actually defined. Add a link to [`packages/types/src/tool.ts`](../packages/types/src/tool.ts).

6. **"OpenAI (Native Provider)" section is a no-op placeholder.** It says "Not explicitly set in code — uses default tool set." If the native OpenAI provider ever gets preferences, this line will silently go out of date with no mechanism to flag it. Consider either linking to the `OpenAiHandler.getModel()` source to prove the claim, or removing the section and adding a note to the summary table that only the router path applies preferences.
