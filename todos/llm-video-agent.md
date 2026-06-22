# LLM-driven video agent — Shofer-native (design)

**Status:** design / not started. Build the LLM video-editing product **inside
Shofer**, reusing what Shofer already has — the **Slang workflow** engine, **vision-
capable apiConfiguration**, and the **native tools** (file read/write, `view_image`)
— and adding only what's missing as a **standalone companion VS Code extension**:
(a) a small set of **specialized tools** registered with Shofer, and (b) a
friendly **read-only viewer** for the video config (the in-IDE equivalent of the
web app's visual editor).

The video **config** (the YAML that `scripts/video-builder/build-video.py`
consumes; schema captured in [`video-config-schema.md`](./video-config-schema.md))
is the source of truth and the agents' editing surface.

---

## 1. Concept → mapped onto existing Shofer

```
brief.md + dropped clips
  → [workflow] perception agent(s): probe / transcribe / snapshot inputs, build an asset catalog
  → [workflow] director agent: write/patch the video config YAML
  → [tool] render_video (proxy or segment) → frame snapshots on disk
  → [workflow] reviewer agent: view_image the snapshots, critique, request changes
  → loop (Slang mailbox + converge) until the brief is met
```

| Need                                      | Use the existing Shofer mechanism                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-stage, multi-agent pipeline         | **Slang workflow** (`.slang` in `.claude/workflows/`) — `flow`/`agent`/mailbox/`converge` (`src/core/workflow/`)                        |
| Per-stage model (incl. vision)            | **Modes + per-mode apiConfiguration** (`ProviderSettingsManager.modeApiConfigs`); point review/intake modes at a `supportsImages` model |
| Read/write the config & brief             | **Native file tools** (read_file / write_to_file / apply_diff)                                                                          |
| "See" images                              | **Native `view_image` tool** (`src/core/tools/ViewImageTool.ts`) — returns `ImageBlockParam` to the model                               |
| Render + extract frames; probe/transcribe | **NEW specialized tools** (companion extension — below)                                                                                 |
| Friendly visualization of the config      | **NEW custom editor** (companion extension — below), modeled on `SlangEditorProvider`                                                   |

What's genuinely new is small: a few tools + one viewer. Everything else is Shofer.

## 2. The companion extension (the only new code)

A new sibling under `extensions/` (e.g. `extensions/video-tools`), scaffolded like
`extensions/vscode-tools` (TypeScript + tsc). Two responsibilities:

### A. Specialized tools (private tool provider)

Registered via the **private tool provider** contract (same as `vscode-tools`):
package.json declares `…privateToolProviders` with a `getDefinitions` command
(returns `{name, description, inputSchema}[]`) and an `invokeTool` command
(returns `{content: string, is_error?}`). See
`extensions/shofer/docs/tool-registration-interface.md` and
`extensions/shofer/src/core/task/build-tools.ts` (lines ~88–201).

Proposed tools:

- **`render_video`** — wraps `build-video.py`. Args:
  `config` (path), `range`/`clips` (render only a time window or specific clip
  indices — fast iteration), `proxy` (low-res/fps), `fps`, `output`,
  `snapshots` (extract N frames evenly) and/or `snapshot_at` (timestamps).
  Returns (text): the output path + the **list of snapshot image paths**.
- **`video_snapshot`** — extract frames from **any** video (an input clip _or_ a
  prior render) to disk: `file`, `at[]`/`every`/`count` → returns image paths.
  This is how agents inspect **input footage** too.
- **`probe_media`** — duration/dimensions/fps/streams/has-audio (ffprobe) as JSON
  text. (Foundation of the asset catalog.)
- _(optional)_ **`transcribe`** — Whisper → timestamped transcript text.

### B. Read-only config viewer (custom editor)

A `CustomTextEditorProvider` for `*.video.yaml` (package.json `customEditors`),
modeled directly on **`src/core/webview/SlangEditorProvider.ts`**: webview with
enableScripts, build HTML once, **debounced `onDidChangeTextDocument` → postMessage**
to re-render in place, preserve zoom/pan. It renders a **timeline + swimlanes
(layers) + waypoint dots** from the config, and embeds a `<video>` for the latest
render. Read-only — the user changes things by **prompting the agent**, not
dragging (matches the product thesis). This is the in-IDE version of "the web app
visualizer."

## 3. The vision workaround (key integration detail)

The API has no video input, and **private tools can't return images** (the
provider contract is text-only; only native tools return `ImageBlockParam`). So:

> specialized tool **renders/extracts frames to disk and returns their paths** →
> the agent calls the **native `view_image`** tool on each path → the vision model
> sees them.

This needs **zero changes to Shofer** and covers both directions — seeing input
clips (`video_snapshot` on a source file) and reviewing output (`render_video`
proxy + snapshots). _Optional later enhancement:_ extend Shofer's private-tool
contract to let external tools return image blocks directly (removes the extra
`view_image` hop) — but it's not required for v1.

## 4. The workflow (Slang sketch)

```
flow make_video(brief, clips_dir) {
  agent intake   { mode: "video-intake";   tools: [probe_media, video_snapshot, view_image, write_to_file] }
  agent director { mode: "video-director"; tools: [read_file, write_to_file, apply_diff, render_video] }
  agent reviewer { mode: "video-review";   tools: [render_video, view_image, read_file] }   // vision model
  // intake builds the asset catalog; director writes the config;
  // reviewer renders a proxy, views snapshots, posts notes to the mailbox;
  // director patches the config; converge when reviewer signs off.
}
```

- **Modes** (`video-intake`/`video-director`/`video-review`) are mode configs with
  appropriate tool groups and role/instructions; the review (and intake) modes are
  pointed at a **vision-capable apiConfiguration**.
- Iteration, hand-offs and stop condition use the Slang **mailbox + `converge`**.

## 5. Engine & artifacts

- **Renderer:** the existing `scripts/video-builder/build-video.py` (already
  supports trim/effects/overlays/transitions/keyframed motion+scale/audio/multi-
  codec). `render_video` shells out to it. Add a **`--dump-json`** resolved model
  to the script so the viewer renders an accurate timeline without re-parsing.
- **Artifacts in the workspace:** `brief.md` (input), `*.video.yaml` (the config /
  IR), an `assets.json` catalog (perception output), `*/snapshots/*.jpg` (transient
  frames), and the rendered `*.webm`/`.mp4`/`.mov`.

## 6. Constraints / risks

- **Private tools are text-only** → the snapshot-then-`view_image` hop (handled
  above). Don't design tools that need to return images directly in v1.
- **Engine deps** (ffmpeg/ffprobe/inkscape/python + optional Whisper) must exist
  wherever the tool runs (the user's machine). Detect + guide setup.
- **Perception quality** gates output quality; weak transcription/scene-detection
  ⇒ poor edits regardless of the LLM.
- **Vision cost/latency**: snapshots are images per review round — sample sparsely
  (e.g. 1 frame/clip + key moments), not every frame.
- **Determinism/cost**: always iterate on **proxy/segment** renders; full render on
  sign-off only.

## 7. Phasing

1. **`render_video` + `video_snapshot` + `probe_media`** tools in a new companion
   extension (wrapping `build-video.py`); add `--dump-json` to the script.
2. **Modes** (`video-intake`/`director`/`review`) + a `make_video.slang` workflow;
   wire the proxy→`view_image`→critique→patch loop. (Vision via existing apiConfig.)
3. **Config viewer** custom editor (timeline/swimlanes/waypoints + playback).
4. **Perception depth**: transcription, scene detection, richer asset catalog.
5. Folder/Drive ingest niceties; optional private-tool image-return enhancement.

## 8. Open questions

- Companion extension name + scaffold (clone `vscode-tools`): `video-tools`?
- File glob for the viewer/config (`*.video.yaml`) and where artifacts live per
  project.
- Do intake/review share one vision mode/config, or separate?
- Should `render_video` run renders in a worker/queue to avoid blocking, and stream
  progress to the viewer (like `SlangEditorProvider.notifyRuntimeState`)?
- Eventually: promote the private-tool contract to support image returns (drops the
  `view_image` hop) — worth it?
