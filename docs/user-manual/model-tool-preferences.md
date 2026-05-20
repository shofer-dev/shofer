# Model Tool Preferences — Which Editing Tools Each Model Uses

Shofer automatically selects the best editing tools for the AI model you're
using. Different models have different strengths — some work better with
patch-style edits, others with string replacement. Shofer handles this
transparently so you get reliable file edits without thinking about it.

---

## Why This Matters

Every time Shofer modifies a file — adding a function, fixing a bug, or
refactoring code — it uses one of several editing tools:

| Tool            | How it works                                   |
| --------------- | ---------------------------------------------- |
| `apply_diff`    | Search/replace blocks (precise, line-targeted) |
| `write_to_file` | Overwrites the entire file                     |
| `edit`          | Old-string / new-string replacement            |
| `apply_patch`   | Unified diff format (`@@` hunks)               |

If a model is given a tool it handles poorly, edits become unreliable — the
model might produce broken diffs, miss replacements, or fail to apply changes.

Shofer's **model tool preferences** system prevents this by automatically
tailoring the available tool set for each model.

---

## Which Models Prefer Which Tools

### OpenAI (via OpenRouter)

OpenAI models receive `apply_patch` instead of `apply_diff` and `write_to_file`.
OpenAI models have historically performed better with unified diff format.
XXX: Screenshot of a chat with an OpenAI model showing an apply_patch tool
call in the chat history — the tool-use block would show "@@ hunk headers"
and line-numbered diff context.

### Gemini (Native & Vertex)

Gemini models receive the `edit` tool instead of `apply_diff`. Gemini performs
more reliably with old-string/new-string replacement than with search/replace
block format.
XXX: Screenshot of a chat with a Gemini model showing an edit tool call —
the chat row would display old_string and new_string parameters.

### Anthropic, DeepSeek, Ollama, VS Code LM

These providers currently use the **default tool set** with no special
customization. All standard editing tools are available.

### Shofer Cloud (API-Configured)

If your organization uses the Shofer Cloud API, administrators can configure
per-model tool preferences remotely. These settings are fetched automatically
and override any built-in defaults. This means your team can fine-tune tool
selection without waiting for an extension update.

---

## How It Works (Behind the Scenes)

When you start a task, Shofer:

1. Identifies the model you selected in the
   [API Config Selector](#) (XXX: screenshot of the API Config Selector
   dropdown in the chat input bar, with a model name highlighted).

2. Determines which editing tools the model should use based on built-in
   provider rules and any Shofer Cloud overrides.

3. Removes tools the model handles poorly (`excludedTools`) and adds tools it
   handles well (`includedTools`), but only if those tools belong to a mode
   group your current mode allows.

4. Renames tools to aliases if the model expects them under a different name
   (for example, some models know `write_file` but not `write_to_file`).

You don't need to do anything — this happens automatically every time you
switch models or start a new conversation.

---

## Can I Customize This?

Tool preferences are **not directly configurable** through the Shofer UI or
`settings.json`. They are:

- **Built into the extension** for native providers (Gemini, Vertex, OpenAI
  via routers).
- **Configurable via the Shofer Cloud API** if you have administrative access
  to your organization's cloud settings.

If you're using a self-hosted or local model and find that a specific tool
doesn't work well with it, contact your Shofer administrator or file an
issue describing the model and the tool behavior.

---

## Related Information

- [Tool Categories](tool-categories.md) — How tools are grouped and which
  modes have access to them.
- [Configuration](XXX: link to configuration docs when available) — All
  Shofer settings and how to configure them.
- [Shofer Cloud](XXX: link to cloud docs) — Managing Shofer Cloud API
  settings for your organization.
