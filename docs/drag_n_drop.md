# Drag & Drop Context Files

## Overview

Shofer allows users to attach files and folders from the Explorer panel to
the chat as `@mentions`. Dropped files appear as removable tags above the
chat input and are prepended to the message text on Send.

## Why a native TreeView?

The webview's HTML5 `drop` events are unreliable on Desktop. VSCode Desktop
renders the webview as a **cross-origin `<iframe>` inside an Electron
`<webview>`**, and Electron's security model breaks DOM drag & drop there in
two ways:

1. **`dataTransfer.getData()` is sanitized to empty** for cross-origin frames.
   The `dragover` / `drop` events still fire and `dataTransfer.types` may even
   be populated, but every `getData()` call returns `""` — so the payload can
   never be read inside the webview.
2. **`File.path` was removed** from webview `File` objects (recent Electron),
   so even when `dataTransfer.files` is populated (OS-file drags), only the
   file _name_ is available, not the absolute path needed to build an
   `@mention`. Only image content survives (read via `FileReader`).

> **code-server / VSCode Web behave differently.** Both breakages above are
> **Electron-specific**, not generically "cross-origin." code-server runs in a
> real browser, where the HTML drag-data store _is_ readable during the `drop`
> event (the spec's "protected mode" only blocks `getData()` during
> `dragenter`/`dragover`, not `drop`). So on code-server the **webview-root
> handler** ([`ChatView.handleWebviewDrop`](../webview-ui/src/components/chat/ChatView.tsx:876))
> fires on the **main chat window** — you can drop directly onto it, not just
> onto the TreeView. The code's own comments confirm this: the root handler
> "works on code-server / VSCode Web," while the overlay that swallows
> root-level events is described as Desktop-only. (Caveat: the `cwd` bug in
> "Known issues" #3 still applies, so paths come out absolute; and OS-file
> drags into the browser still yield no usable path — only VSCode-internal
> drags carry `text/uri-list`.)
>
> Because of this, the TreeView is **not registered in web**: `extension.ts`
> only calls `createTreeView` when `vscode.env.uiKind === vscode.UIKind.Desktop`,
> and the view contribution carries `"when": "!isWeb"` so it is hidden in
> code-server / VSCode Web. The chat webview's drop handler covers web there.

To work around the **Desktop** limitation, we register a **native VSCode
TreeView** as the drop target. TreeViews use VSCode's `TreeDragAndDropController` API, whose
`handleDrop` runs in the **extension host** (outside the webview sandbox) and
reads the payload via `dataTransfer.get("text/uri-list").asString()` — not
subject to the sanitization above. It is therefore the only reliable in-app
drop target on Desktop.

> **Important caveat:** a `TreeDragAndDropController` only receives drags that
> **originate inside VSCode** (the Explorer or an editor tab). Files dragged
> from the **OS file manager** (Finder / Windows Explorer / desktop) are _not_
> delivered to a custom tree's `handleDrop` at all. The only native target
> that accepts OS-file drops is VSCode's own Explorer — drop there first, then
> use the Explorer right-click command (below) or drag from the Explorer into
> the drop zone.

The TreeView is registered with `"initialSize": 1` so it appears
as a single thin row at the bottom of the Shofer sidebar — minimal
visual clutter. The user drops files onto its title bar or expands
it to see the hint text.

## Architecture

```
 ┌────────────────────────────────┐
 │   VSCode Explorer (drag)       │
 └──────────────┬─────────────────┘
                │ text/uri-list
                ▼
 ┌────────────────────────────────┐    extension host
 │ ContextDropZoneProvider        │
 │   .handleDrop()                │
 │   • parses URIs                │
 │   • makes paths workspace-rel  │
 │   • posts addContextFiles      │
 └──────────────┬─────────────────┘
                │ postMessageToWebview
                ▼
 ┌────────────────────────────────┐    webview
 │ ChatView                        │
 │   case "addContextFiles":       │
 │     setDroppedContextFiles(...) │
 │   • renders removable tags      │
 │   • prepends @mentions on Send  │
 └────────────────────────────────┘
```

### Components

| Component                 | File                                                                                          | Role                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ContextDropZoneProvider` | [src/core/webview/ContextDropZoneProvider.ts](../src/core/webview/ContextDropZoneProvider.ts) | Native TreeView + `TreeDragAndDropController`. Stateless drop target — forwards files to webview. |
| `ChatView`                | [webview-ui/src/components/chat/ChatView.tsx](../webview-ui/src/components/chat/ChatView.tsx) | Owns the `droppedContextFiles` React state, renders tags, converts to `@mentions` on Send.        |
| `addContextFiles` message | [packages/types/src/vscode-extension-host.ts](../packages/types/src/vscode-extension-host.ts) | Host → webview message carrying `Array<{path, isFile}>`.                                          |
| View contribution         | [src/package.json](../src/package.json) (`shofer.contextDropZone`, `initialSize: 1`)          | Registers the drop-zone TreeView in the Shofer activity-bar container.                            |

## Data flow

1. User drags files from the VSCode Explorer onto the **"Drop Files for
   Context"** view in the Shofer sidebar.
2. `ContextDropZoneProvider.handleDrop` parses the `text/uri-list`
   payload, converts each URI to a workspace-relative path, and posts an
   `addContextFiles` message to the webview.
3. `ChatView` receives the message, dedupes against the existing
   `droppedContextFiles` state, and re-renders the tag list.
4. The user clicks Send; `ChatView` prepends `@/path1 @/path2 ...` to the
   message text and clears the tag list.

## UI

- **Drop Files for Context** — a native VSCode TreeView, registered
  with `"initialSize": 1` in the Shofer sidebar so it appears as
  a minimal row. Contains a single hint row ("Drag files here to add
  to chat context"). Holds no state.
- **File tags** — rendered above the chat input. Each tag has a remove
  (×) button; a "clear all" button removes them all.
- **Status bar** — a brief "Added N files to chat context" message is
  shown for 2 seconds on each successful drop.

## Webview drop handlers

There are two additional drop handlers inside the webview:

- **`ChatView` root** (`handleWebviewDrop`) — a handler on the iframe
  root. VSCode Desktop's cross-origin webview overlay swallows these
  events, so this path effectively never fires on Desktop. It is kept
  as a fallback for runtimes that do deliver root-level drag events.

- **`ChatTextArea` container** (`handleDrop` via `onDrop`) — a handler
  on the native form-control textarea container. This is the only
  webview-side drop path that fires reliably on VSCode Desktop,
  because the overlay does deliver events to form-control descendants.
  It forwards parsed entries to `ChatView`'s `droppedContextFiles` state
  via the `onContextFilesDropped` callback, sharing the same
  `extractUriPayload` / `parseDroppedUris` parser used by the native
  TreeView.

Both handlers delegate to the same `droppedContextFiles` React state,
ensuring consistent behavior regardless of which path processes the drop.

## Shared URI parsers

All three drop paths (native TreeView, ChatView root, ChatTextArea
container) share the same URI parsing logic via
[`webview-ui/src/utils/droppedContextFiles.ts`](../webview-ui/src/utils/droppedContextFiles.ts):

| Export               | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `DroppedContextFile` | Type: `{ path: string, isFile: boolean }`                          |
| `extractUriPayload`  | Extracts a URI-list string from a `DataTransfer` object, probing   |
|                      | `text/uri-list`, `text/plain`, and `application/vnd.code.uri-list` |
|                      | MIME types in that order.                                          |
| `parseDroppedUris`   | Parses newline-separated URI strings into `DroppedContextFile[]`,  |
|                      | resolving workspace-relative paths and deduplicating.              |

The native TreeView uses its own `addUrisToContext` helper (in
`ContextDropZoneProvider.ts`) which duplicates the URI-parsing logic
but also adds the `stat()` best-effort `isFile` detection and the
status-bar message.

## Per-task scoped state

`droppedContextFiles` is scoped per task. When the user switches
tasks, `ChatView` saves the current task's state into a
`taskScopedState` map (keyed by `taskId`) and restores the
incoming task's state — including `droppedContextFiles`. This
prevents file tags from one task leaking into another, and
preserves tags per task across task switches.

## Troubleshooting: "drag & drop doesn't work on Desktop"

The three drop paths behave very differently on Desktop. This table reflects a
full trace of the live code (2026-06-13):

| Path                                                       | Runs in        | Fires on Desktop?                            | Recovers correct path?              | Logging    |
| ---------------------------------------------------------- | -------------- | -------------------------------------------- | ----------------------------------- | ---------- |
| **Native TreeView** (`ContextDropZoneProvider.handleDrop`) | extension host | ✅ for VSCode-internal drags only            | ✅ via `provider.cwd`               | ❌ none    |
| **Textarea** (`ChatTextArea.handleDrop`)                   | webview        | ⚠️ event fires, `getData()` usually stripped | ⚠️ no — `cwd` never passed (see #3) | ✅ verbose |
| **Webview root** (`ChatView.handleWebviewDrop`)            | webview        | ❌ swallowed by the overlay                  | ❌ no — `window.CWD` unset (see #3) | ✅ verbose |

### Diagnosis steps

1. **Identify the drag source.** OS file manager → only VSCode's Explorer can
   accept it (see the caveat under "Why a native TreeView?"). VSCode Explorer
   or an editor tab → the native TreeView should accept it.
2. **Enable webview logging.** Drop logs are emitted at **info** level under
   the **"webview"** category (`webviewLog` is handled in
   [`webviewMessageHandler.ts:565`](../src/core/webview/webviewMessageHandler.ts:565)).
   If Settings → Logging is at `warn`/`error`, or the webview category is off,
   these logs are invisible — set it to `info`/`debug` first.
3. **Drop on the chat input box** and look for `[drop:textarea] fired … types=[…] payloads={…}`.
   If `types` is non-empty but `payloads` is `{}`, that confirms the Electron
   `getData()` sanitization — the webview path **cannot** work on Desktop, and
   the native TreeView (or the Explorer command) is the only option.
4. **Fall back to the Explorer command.** Right-click in the Explorer →
   _Add to Shofer Context_ (`shofer.addFilesToContext`,
   [`extension.ts:303`](../src/extension.ts:303)) bypasses drag entirely and
   uses the correct-`cwd` code path. This is the most reliable route on Desktop.

## Known issues (confirmed)

These are concrete defects found tracing the code, in rough priority order for
fixing the Desktop experience:

1. **The drop zone is physically un-hittable.** The TreeView is registered with
   `"initialSize": 1` ([`src/package.json`](../src/package.json), the
   `shofer.contextDropZone` view) — a ~1px sliver beneath the chat webview. A
   `TreeDragAndDropController` only fires `handleDrop` when the drop lands on the
   tree's rows, and there is effectively no row to hit. This alone can make every
   attempt silently miss. **Fix idea:** give it a usable `initialSize`, or make
   the view expand/highlight while a drag is in progress.

2. **The native path has zero logging.**
   [`ContextDropZoneProvider.handleDrop`](../src/core/webview/ContextDropZoneProvider.ts:124)
   emits nothing, so the one path expected to work on Desktop is completely
   unobservable. **Fix idea:** enumerate the dropped `dataTransfer` MIME types
   and the parsed URI count via `webviewLog`, mirroring the webview handlers.

3. **`cwd` is never wired into either webview drop path**, so even a _successful_
   webview drop emits **absolute** paths instead of workspace-relative
   `@/path` mentions (the `if (cwd && …)` branch in
   [`parseDroppedUris`](../webview-ui/src/utils/droppedContextFiles.ts:79) is
   skipped):

    - `ChatTextArea` is rendered **without a `cwd` prop**
      ([`ChatView.tsx:2375`](../webview-ui/src/components/chat/ChatView.tsx:2375));
      inside, `cwd` is `undefined`.
    - `handleWebviewDrop` reads `(window as any).CWD`
      ([`ChatView.tsx:888`](../webview-ui/src/components/chat/ChatView.tsx:888)),
      but **`window.CWD` is never assigned anywhere** in the codebase.

    Only the native TreeView path (`addUrisToContext`, using `provider.cwd`,
    [`ContextDropZoneProvider.ts:35`](../src/core/webview/ContextDropZoneProvider.ts:35))
    produces correct relative paths.

4. **`dropMimeTypes` advertises only `text/uri-list`.** The native controller
   declares `dropMimeTypes = ["text/uri-list"]`
   ([`ContextDropZoneProvider.ts:104`](../src/core/webview/ContextDropZoneProvider.ts:104)).
   `handleDrop` is only invoked when an advertised type is present; some VSCode
   builds deliver internal drags under additional MIME types
   (`application/vnd.code.tree.*`, `resourceurls`). The webview-side
   [`extractUriPayload`](../webview-ui/src/utils/droppedContextFiles.ts:23)
   already probes seven candidate types, but the native controller does not.
   **Fix idea:** advertise the extra types so `handleDrop` fires and can at
   least log the payload for diagnosis.

## Documentation gaps (lower priority)

- **Architecture diagram is incomplete**: it shows only the native TreeView →
  ChatView path. The ChatTextArea and webview-root handlers, and the shared
  `droppedContextFiles.ts` module, are not represented.

- **No test coverage for the native path**: the `ChatTextArea` handler has tests in
  [`ChatTextArea.spec.tsx`](../webview-ui/src/components/chat/__tests__/ChatTextArea.spec.tsx)
  (path drops, empty lines, image drops, long paths, special characters,
  outside-workspace paths), but the native `ContextDropZoneProvider` and the
  `droppedContextFiles.ts` parser have no dedicated tests.

- **`ShoferIgnoreController` interaction unstated**: dropped files are added to
  context without filtering against `.shofer/shoferignore`. (Note:
  `ShoferIgnoreController` is now widely wired across the codebase — see
  `settings_overlay.md` — so this is a genuine missing integration in the drop
  path, not merely a doc omission.)

- **No light/dark theme screenshot** of the drop zone in the sidebar.

---

# Proposed: Drag & drop into workflow input forms (design — NOT yet implemented)

> Status: **design only**. Nothing below is built. This section captures how
> drag & drop could populate the **typed input form** that collects a workflow's
> inputs, and what plumbing it would require. Implement separately.

## The opportunity

When a workflow declares typed parameters, Shofer collects them up front with a
single structured followup that the webview renders as a form — `WorkflowParamForm`
([webview-ui/src/components/chat/WorkflowParamForm.tsx](../webview-ui/src/components/chat/WorkflowParamForm.tsx)),
driven by `FollowUpData.paramForm`
([packages/types/src/followup.ts](../packages/types/src/followup.ts)). The same
component now also renders **mid-flow** `escalate … form:` prompts (see
[`slang_specs.md` § escalate](slang_specs.md)), so anything designed here benefits
**both** initial flow-param collection and mid-flow escalate forms.

Many of these fields naturally want a **file or folder** as their value — a path
to analyse, a directory to scaffold into, a config file to read. Today the user
must type or paste the path. Letting them **drag a file from the VSCode Explorer
straight onto the field** would make input collection far faster, and it reuses
machinery that already exists for chat context files.

## Why the form is a good drop target (and the Desktop constraint it dodges)

The hard part of Desktop drag & drop (see "Why a native TreeView?" above) is that
the cross-origin webview overlay **swallows root-level drag events** and Electron
**sanitises `dataTransfer.getData()`**. But the existing code already establishes a
crucial exception: **the overlay DOES deliver drag events to native form-control
descendants** — that is exactly why the `ChatTextArea` container handler is "the
only webview-side drop path that fires reliably on VSCode Desktop."

`WorkflowParamForm`'s fields (`widgetFor` → `textarea` / `number` / `dropdown` /
`radio` / `multiselect` / `slider` / `checkbox`) are rendered as real
`<textarea>` / `<input>` / `<select>` controls. So **per-field `onDrop` handlers on
the text-like controls should fire on Desktop for VSCode-internal drags**, with no
native TreeView needed — the same reliability class as `ChatTextArea`.

The unavoidable limitation is unchanged: **OS-file-manager drags still yield no
usable path** in the webview (Electron strips `File.path`); only **VSCode-internal**
drags carry `text/uri-list`. So the affordance must be documented as "drag from the
Explorer / an editor tab," with the Explorer right-click command as the OS-file
fallback.

## Which fields accept a drop, and what a drop inserts

Not every string field wants a path, so drop intent should be **declared**, not
inferred. Proposed model — one new optional trait on `ParamField` / `FlowParam`:

| Declared intent      | Droppable widget(s)         | A dropped file/folder inserts…                                         |
| -------------------- | --------------------------- | ---------------------------------------------------------------------- |
| `accepts: "path"`    | textarea / single-line text | the workspace-relative path (e.g. `src/app.ts`), replacing the value   |
| `accepts: "paths"`   | a multi-value list field    | appends each dropped path; value becomes a `string[]`                  |
| `accepts: "content"` | textarea                    | the file's **text content**, inlined (host reads the file — see below) |
| (unset)              | —                           | field is not a drop target (drop falls through / no-op)                |

For a **multi-select / list** param, dropping several files should append all of
them (mirroring `parseDroppedUris`' dedupe). For a **boolean / slider / dropdown**
field, a drop is meaningless and should be ignored.

`"content"` is the odd one out: the webview only receives `text/uri-list`, never
file bytes, so inlining content requires a **host round-trip** — drop posts the
URIs to the extension host, the host reads the files (respecting
`ShoferIgnoreController`, see Known-issues note), and posts the text back to fill
the field. `"path"`/`"paths"` need no host read and are the simpler first cut.

## Targeting: which field receives the `@` reference

This is the central UX question for the form (it does not arise in chat, which has
a single input). **The chat model cannot answer it.** Today a drop anywhere on
WorkflowView is funnelled by `handleWebviewDrop`
([WorkflowView.tsx](../webview-ui/src/components/chat/WorkflowView.tsx)) into one
`droppedContextFiles` list, then prepended to the message on Send — a **single
sink** with no notion of "which field." A multi-field form has N possible
destinations, so targeting must be **explicit**.

**Rule: the field you drop _onto_ is the field that receives it.** Each droppable
field owns its `onDrop`, and the DOM delivers the event to the control under the
cursor, so the recipient is unambiguous — no focus-tracking, no guessing.

```
 ┌─ WorkflowParamForm (dragging a file from Explorer) ──────────┐
 │  spec      [ ░░░░░░░░░ ]  ← droppable: glows on dragenter      │
 │  exclude   [ ░░░░░░░░░ ]  ← droppable: glows                   │
 │  replicas  (  5  )         ← not droppable: dimmed/no glow     │
 │  notify    [x]             ← not droppable: dimmed             │
 └──────────────────────────────────────────────────────────────┘
        drop on `spec` → only `spec` gets @/path
```

Supporting behaviour:

- **Highlight valid targets on drag.** On `dragenter` over the form, dim the form
  and **glow only the fields whose `accepts` is set**, so the user sees the legal
  destinations before releasing. The field under the cursor gets a stronger ring.
- **Each field stops propagation.** The per-field `onDrop` must call
  `stopPropagation()` so the WorkflowView **root** handler does NOT _also_ add the
  file to the chat-context sink. While a param form is pending, a drop belongs to a
  field, not to `droppedContextFiles`. (On Desktop the root handler is already inert
  — the overlay only reaches form controls — but web/code-server would double-handle
  without this.)
- **Drop on form chrome (not a field):**
    - exactly one droppable field exists → route there (unambiguous);
    - more than one → **no-op + inline hint** ("drop onto a field"), rather than
      silently picking one or leaking into the chat sink;
    - never fall back to the chat `droppedContextFiles` tag list while a form is open
      — that's the confusing status quo this design replaces.

## Value: `@`-mention vs bare path

"What string lands in the field" is a second, separable decision from targeting,
and it's why the question is phrased as "the `@` reference":

- **`@/path` mention** — for a param whose value is fed into an **agent prompt**,
  inserting `@/relative/path` lets Shofer's existing mention resolver **inline the
  file's content** for that agent (same as `@mentions` in chat). This is usually
  what you want for "here's the file to work on."
- **Bare `relative/path`** — for a param used as a **literal path argument** (the
  agent opens it itself, or it's passed to a tool), insert the plain
  workspace-relative path with no `@`.

Make it a property of the declared intent, e.g. `accepts: "mention"` → `@/path`,
`accepts: "path"` → bare path (`accepts: "paths"` → append multiple, space-joined
mentions or a `string[]`). A sensible default for a free-text `string` field is the
**`@/path` mention**, since flow-param values overwhelmingly end up in agent
prompts and the resolver already knows how to expand them. The mention vs bare-path
choice reuses the same workspace-relative resolution `parseDroppedUris` already
does — only the `@` prefix differs.

## Delivery mechanisms

1. **Per-field webview drop (primary).** Add `onDragOver`/`onDrop` to the
   text-like controls in `WorkflowParamForm`. On drop: `extractUriPayload` →
   `parseDroppedUris(payload, cwd, existing)` (the shared parsers in
   [`droppedContextFiles.ts`](../webview-ui/src/utils/droppedContextFiles.ts)) →
   set/append the field value. Show a drop affordance (border highlight) on
   `dragover`, gated to fields whose `accepts` is set. This is the only path that
   can target a **specific** field, because the drop event carries the target
   element.

2. **Native TreeView (not suitable here).** `ContextDropZoneProvider`'s
   `handleDrop` runs in the extension host and has **no idea which form field** a
   drop was meant for — it only knows "add to chat context." Routing it to a field
   would require fragile focus-tracking. The per-field webview path is strictly
   better for forms; the native zone stays chat-only.

## Prerequisites & gotchas (must fix first)

- **`cwd` must reach the form.** Producing `src/app.ts` instead of an absolute
  path needs `cwd` threaded into `WorkflowParamForm` (via `ChatRow`). This is the
  **same wiring gap as Known-issues #3** — `ChatTextArea` and the WorkflowView root
  handler both fall back to an unset `window.CWD`, so paths come out absolute.
  Fixing the cwd plumbing is a shared prerequisite, not form-specific.
- **`.shofer/shoferignore` filtering.** Dropped paths should be filtered through
  `ShoferIgnoreController` (the chat path doesn't today — see "Documentation
  gaps"). A workflow input form is a good place to do it right from the start.
- **Type coercion stays downstream.** The form already coerces values to each
  field's declared type on submit (and `WorkflowTask.requestFlowParams` /
  `handleEscalation` coerce again via `coerceParam`). A dropped path is a string,
  so `string`/`paths` fields are unaffected; don't let a drop bypass coercion.
- **`answeredValues` replay.** Dropped values participate in the normal
  submit/`objectResponse` path, so the read-only replay-after-reload
  (`markFollowupFormAnswered`) needs no change.

## Slang-author surface (sketch)

Drop intent would be declared with the existing param-meta grammar (the same block
`escalate … form:` and flow `param <name> { … }` already parse via
`parseParamMetaFields`), e.g. a new soft-keyword:

```slang
flow "audit" (target: "string") {
  param target { accepts: "path", description: "File or folder to audit" }
}
-- or mid-flow:
escalate @Human reason: "Pick inputs:" form: {
  spec:    "string" { accepts: "path" }
  exclude: "string" { accepts: "paths" }   -- multi: drop several, value is string[]
}
```

This keeps drop a **declared, validated** capability rather than magic on every
text box, and threads through the already-shared `FlowParam` shape.

## Non-goals / open questions

- **OS-file drops** into the form remain unsupported (Electron). Document, don't
  fight it.
- **Images / binary** into a workflow field: out of scope; workflow params are
  scalar text/number/boolean.
- **Folder semantics**: should a dropped folder expand to its files, or stay a
  single directory path? Lean toward a single path for `path`, let the agent
  expand it.
- **Where does `accepts` live** — only on `ParamField` (webview render) and
  `FlowParam` (slang), or also surfaced to `ask_followup_question`'s `form`
  schema so the LLM can request a droppable field? (Probably yes, for symmetry.)
- **Discoverability**: the field needs a visible "drop a file here" hint, since
  drag-onto-textbox isn't obvious.
