# Markdown Rendering in ChatTextArea — Design Dilemma

## Goal

Enable in-line markdown formatting (bold, italic, code, strikethrough) in the
chat input bar so users see styled text as they type, not just raw `**` and
`*` syntax.

---

## Approach 1: Overlay with Styled Spans (attempted — buggy)

### How it works

`ChatTextArea` already has an "overlay" div (`highlightLayerRef`) layered on
top of the `<textarea>`. It displays the same text but with HTML `<mark>`
wrapping for @mentions and /commands. The existing overlay uses
`text-transparent` + `color: transparent` so only the highlights are visible,
and the underlying textarea shows black text through the transparent overlay.

The idea: extend `updateHighlights()` to also wrap `**bold**`, `*italic*`,
`` `code` ``, and `~~strikethrough~~` in `<span>` tags with CSS classes.

### The bug

The overlay and textarea share **position** but not **font metrics**:

- `.textarea-md-bold` uses `font-weight: 700` — bold characters are wider,
  shifting all subsequent text right in the overlay relative to the textarea.
- `.textarea-md-italic` uses `font-style: italic` — italic glyphs have
  different advance widths than upright ones.
- `.textarea-md-code` uses `font-family: monospace` — a different font family
  with completely different character measurements.

Result: the overlay text visually corrupts — bold/italic/code text renders at
slightly different positions than the underlying textarea, causing a
"doubled" or "overlapping" appearance where both the transparent styled span
and the underlying unstyled textarea text are visible and misaligned.

### Fix for Approach 1

Use only **color-based** CSS properties that don't affect character grid:

| Styling purpose | Safe (color-only)                               | Unsafe (changes metrics) |
| --------------- | ----------------------------------------------- | ------------------------ |
| Bold            | `color: var(--vscode-foreground)` (brighter)    | `font-weight: 700`       |
| Italic          | `color: var(--vscode-charts-blue)`              | `font-style: italic`     |
| Code            | `color: var(--vscode-textPreformat-foreground)` | `font-family: monospace` |
| Strikethrough   | `text-decoration: line-through`                 | _(safe)_                 |

`text-decoration` is the exception — it doesn't change glyph metrics.

If all markdown formatting is expressed as color/saturation/opacity changes
on the **same** font, the character grid stays pixel-identical between the
overlay and the textarea. No drift.

---

## Approach 2: Replace `<textarea>` with `contenteditable` div

### How it works

Instead of an overlay, replace the `<textarea>` entirely with a
`contenteditable` `<div>` that natively supports inline formatting. Typing
markdown syntax triggers real-time DOM replacements: `**text**` becomes a
`<strong>` node, `` `code` `` becomes a `<code>` node, etc. On Send, the raw
markdown is extracted from the DOM.

### What breaks

`ChatTextArea` is ~1495 lines deeply coupled to the `<textarea>` API:

| Current API                                                                      | Used by                 | contenteditable equivalent                        | Complexity                                    |
| -------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------- | --------------------------------------------- |
| `e.target.value`                                                                 | `handleInputChange`     | `innerText` extraction                            | Medium — must walk DOM nodes                  |
| `selectionStart` / `selectionEnd`                                                | 5+ handlers             | `window.getSelection()` + `Range`                 | High — character offsets cross DOM boundaries |
| `setSelectionRange()`                                                            | 7 call sites            | Compute range from character offsets across nodes | Very high                                     |
| `setInputValue(string)`                                                          | ~15 call sites          | Set `innerText`, destroys formatting spans        | High — must re-parse markdown                 |
| `scrollTop`/`scrollLeft`                                                         | `updateHighlights`      | Same API, works                                   | None                                          |
| `forwardRef<HTMLTextAreaElement>`                                                | `ChatView.tsx`          | Interface break                                   | `ChatView` casts to textarea                  |
| `onSelect`                                                                       | Cursor tracking         | `document.onselectionchange`                      | Medium                                        |
| `isComposing`                                                                    | IME detection           | Different detection needed                        | Medium                                        |
| `DynamicTextArea` (autosize)                                                     | Row count               | Not supported on contenteditable                  | High — need manual height calculation         |
| Mention autocomplete (`insertMention`, `removeMention`, `shouldShowContextMenu`) | Textarea cursor offsets | Range-based cursor tracking across DOM            | Very high                                     |
| `ContextMenu` popover positioning                                                | Textarea cursor coords  | Re-architect positioning                          | Medium                                        |

**Estimated effort:** Multi-day rewrite. Every user-interaction path
(keyboard, paste, drop, IME, mentions, commands, prompt history) needs
re-architecting.

**Regression risk:** Very high. 52 existing tests would need rewriting.

### Benefits

- Truly native markdown rendering — not an overlay trick.
- Bold and italic render with real font metrics (because the contenteditable
  handles layout natively).
- No overlay alignment issues.

---

## Approach 3: Toggle between raw textarea and read-only preview

### How it works

A button toggles between the existing `<textarea>` (raw markdown) and a
read-only `<Markdown>` component rendering the current input.

### Pros/Cons

| Pro                                | Con                             |
| ---------------------------------- | ------------------------------- |
| Trivial to implement (~50 lines)   | User can't type in preview mode |
| Zero regression risk               | Requires toggle to edit         |
| Uses battle-tested `MarkdownBlock` | Not "live" preview              |

---

## Recommendation

**Approach 1 with color-only fix** is the pragmatic choice for an immediate
working solution (~30 lines changed, zero regression risk, no toggle needed).

**Approach 2 (contenteditable)** is the correct long-term solution but
requires dedicated effort — not something to attempt as a side task.
