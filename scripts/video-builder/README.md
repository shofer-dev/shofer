# Video tooling

Scripts for turning screen-recording clips into a narrated, paced, polished
video — titles, voiceover, transitions, overlays, and adaptive speed, all from a
single config file.

| Script                | What it does                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`build-video.py`**  | Generic, config-driven builder. Assembles a video from one or more clips described in a YAML/JSON file. **Use this for new videos.**                                                                |
| `build-demo-video.py` | The original Shofer demo builder. Rebuilds the marketing demo from the OpenShot project (`media/demo.osp`); narration/pacing are hard-coded near the top. Kept for reproducing that specific video. |
| `video.example.yaml`  | A fully-commented example config for `build-video.py`.                                                                                                                                              |

Both write a `VP9 + Opus` `.webm`.

---

## Requirements & installation

| Dependency             | Why                                            | Required?                                       |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `python3` (3.8+)       | Runs the scripts.                              | Yes                                             |
| `ffmpeg` + `ffprobe`   | All video/audio processing and probing.        | Yes                                             |
| `inkscape`             | Rasterizes the title-bar/end-card SVGs to PNG. | Yes (titles & demo end-card)                    |
| `PyYAML`               | Reading `.yaml` configs (not needed for JSON). | For `build-video.py` YAML configs               |
| TTS env (Kokoro/Piper) | Neural voiceover. Skippable with `--no-voice`. | For narration — see [Voice setup](#voice-setup) |
| `libflite` (flite)     | Offline robotic TTS fallback if no neural env. | Optional                                        |

### System packages (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y ffmpeg inkscape python3 python3-pip flite
python3 -m pip install --user PyYAML        # or: sudo apt install python3-yaml
```

macOS (Homebrew): `brew install ffmpeg inkscape python && pip3 install PyYAML`.

### Verify the toolchain

The scripts check for `ffmpeg`/`ffprobe`/`inkscape` on startup and exit with a
clear message if one is missing. To check by hand:

```bash
ffmpeg -version | head -1 && ffprobe -version | head -1
inkscape --version
python3 -c 'import yaml; print("PyYAML", yaml.__version__)'
```

Voiceover needs the separate TTS environment in `media/video/` — see
[Voice setup](#voice-setup). Without it (or with `--no-voice`) everything else
still works; the build just renders silent.

---

## build-video.py

### CLI usage

```bash
# From the repo root (paths inside the config are resolved relative to the config file):
python3 scripts/video-builder/build-video.py scripts/video-builder/video.example.yaml

# A JSON config works too (no PyYAML needed):
python3 scripts/video-builder/build-video.py myvideo.json

# Rebuild the Shofer demo from its committed config:
python3 scripts/video-builder/build-video.py scripts/video-builder/demo.yaml

# Fast iteration while editing a config — skip narration and motion analysis:
python3 scripts/video-builder/build-video.py demo.yaml --no-voice --no-pace

# Debug a bad render — keep the scratch dir of intermediate files:
python3 scripts/video-builder/build-video.py demo.yaml --keep-temp

python3 scripts/video-builder/build-video.py --help
```

The config path is the first positional argument; flags can go in any order.

| Flag           | Effect                                                            |
| -------------- | ----------------------------------------------------------------- |
| `--no-voice`   | Skip TTS narration — render silent (no TTS env needed). Fast.     |
| `--no-pace`    | Disable adaptive pacing; use the configured/base speed uniformly. |
| `--keep-temp`  | Keep the scratch directory of intermediate files for debugging.   |
| `-h`, `--help` | Print usage and exit.                                             |

### What it does (pipeline)

1. **Normalize** each clip to the canvas — scale-to-fit + pillarbox/letterbox —
   and bake in its generated **title bar** and any **overlays/effects**, at the
   clip's base speed.
2. **Assemble** the clips in order, joined by **transitions** (`xfade`) or hard
   cuts.
3. **Adaptive pacing** (optional): measures on-screen motion and speeds the
   result up in quiet, untitled, silent stretches and slows it down in busy
   ones. Narration is never accelerated, so the voiceover stays in sync.
4. **Narration**: synthesizes each clip's line (from its `narration`, or its
   `description`) plus an optional intro, and muxes them at each clip's title
   time — mapped through the pacing warp.
5. **Encode** VP9 + Opus to the configured `output`.

### Capabilities

What the config can express:

- **Multiple clips, ordered** — assembled in list order (a single clip is fine).
- **Cutting** — `trim: [start, end]` keeps part of a source; list the same file
  twice with different trims to use several pieces.
- **Speed** — per-clip `speed` (slow or fast) plus a global base `speed`.
- **Adaptive pacing** — automatic slow-downs on busy frames and speed-ups on
  quiet, untitled, silent stretches; never accelerates under narration.
- **Generated titles** — lower-third bars rendered from `title`/`description`
  text (no SVG editing); on-screen time auto-sized to reading length.
- **Voiceover** — neural TTS narration per clip (+ an intro), auto-timed to each
  clip and kept in sync through the pacing warp.
- **Background music** — a looped music bed with fade in/out and automatic
  **ducking** (volume dips while narration plays).
- **Transitions** — `xfade` styles (fade/wipe/slide/dissolve/…) or hard `cut`.
- **Overlays** — SVG or raster images, positioned and time-windowed per clip,
  with optional fade in/out.
- **Cropping & framing** — per-clip `crop` (source sub-rectangle), `fit`
  (`contain` pillarbox / `cover` fill+crop / `stretch`), any `canvas` size/fps,
  configurable pillarbox `background`.
- **Time effects** — per-clip `reverse` and `freeze` (hold first/last frame).
- **Effects** — `fadein`/`fadeout`, `eq` (brightness/contrast/saturation/gamma),
  `zoom` (Ken Burns), `blur`, `sharpen`, `denoise`, `hue`, `negate`, `grayscale`,
  `sepia`, `vignette`, `pixelate`, `deinterlace`, and 3D-`lut` (`.cube`).
- **Audio loudness** — optional EBU R128 `loudnorm` on the final mix.
- **Output** — configurable codec/container: VP9+Opus `.webm` (default),
  H.264/H.265 `.mp4`, or ProRes `.mov`.

Not supported (use a full editor like OpenShot for these): multi-track / picture-
in-picture compositing, audio mixing beyond music+narration, a general keyframe
engine (animated motion paths, animated titles), blend/compositing modes, and
chroma-key (green screen) — chroma-key needs a layer beneath it, so it waits on
PiP compositing. See [`TODO.md`](./TODO.md) for the full backlog.

### Config reference

Paths inside the config are resolved relative to the config file (or to
`clips_dir`, if set). Only `clips` is required; everything else has a default.
See `video.example.yaml` for a working file. Top-level keys:

| Key          | Default                          | Meaning                                          |
| ------------ | -------------------------------- | ------------------------------------------------ |
| `output`     | `out.webm`                       | Output path (relative to the config file).       |
| `clips_dir`  | `""`                             | Base dir prepended to each clip's `file`.        |
| `canvas`     | `{width:1280,height:720,fps:30}` | Output frame geometry.                           |
| `background` | `black`                          | Pillarbox/letterbox fill for off-aspect clips.   |
| `fit`        | `contain`                        | Default fit: `contain`/`cover`/`stretch`.        |
| `subtitles`  | `""`                             | Path to a `.srt`/`.ass` to burn into the output. |
| `speed`      | `1.0`                            | Base speed for all clips (`0.5` = half speed).   |
| `pacing`     | see below                        | Adaptive speed by motion.                        |
| `title`      | see below                        | Generated title-bar style.                       |
| `transition` | `{type:fade,duration:0.6}`       | Default join between clips.                      |
| `intro`      | `{narration:"",delay:0.5}`       | Optional spoken intro before clip 1.             |
| `voice`      | see below                        | TTS engine + voice.                              |
| `music`      | see below                        | Optional background-music bed.                   |
| `audio`      | `{loudnorm:false}`               | Final-mix loudness normalization.                |
| `encode`     | see below                        | Output codec/container/quality.                  |
| `clips`      | —                                | Ordered list of clips (below).                   |

**`pacing`**: `enabled`, `slow` (speed in busy spans), `fast` (speed in quiet,
untitled, silent spans), `motion_hi`/`motion_lo` (fractions of peak motion that
count as busy/quiet), `bucket` (analysis granularity, s).

**`title`**: `enabled`, `position` (`lower`/`upper`/`center`), `seconds` (fixed
on-screen time, or `null` to derive from reading time), `read_wps`/`read_base`
(reading-time formula), `at` (default appear time), `bar_frac`, `bar_color`,
`bar_opacity`, `text_color`, `font`.

**`encode`** also takes `extra` — a list of raw ffmpeg args appended to the
encode (e.g. `["-cq", "23"]` for hardware encoders like `h264_nvenc`). And
`subtitles_style` — an ffmpeg `force_style` string for burned-in `.srt`.

**`voice`**: `enabled`, `engine` (`auto|kokoro|piper|flite`), `tts_home` (default
`media/video`), `kokoro_voice` (`af_heart`, `af_bella`, `am_michael`, `am_onyx`,
`bm_george`), `kokoro_speed`.

**`music`**: a single bed `{file, volume, fade_in, fade_out, duck, duck_amount}`
**or a list** of such beds (all looped to cover the video and mixed). `file`
empty = none. `duck` lowers that bed while narration plays.

**`audio`** (filters on the final mixed track): `use_source` (mix each clip's own
audio — see clip `volume`/`audio_fade`/`mute`), `source_volume`, `source_duck`/
`source_duck_amount` (dip source audio under narration); `gain`/`bass`/`treble`
(dB), `balance` (−1..1), `compress`, `denoise`; `filters` (a list of raw ffmpeg
audio filters — escape hatch); `loudnorm` (`true`, or `{I, TP, LRA}`).

**`encode`**: `vcodec` (`libvpx-vp9` default, or `libx264`/`libx265`/`prores_ks`),
`acodec` (`auto` → Opus for `.webm`, AAC otherwise), `crf` (`null` → `vp9_crf` for
VP9, else `18`), `vp9_crf`, `preset` (x264/x265), `pix_fmt`, `prores_profile`
(0–5), `audio_kbps`. The container is taken from the `output` extension
(`.webm`/`.mp4`/`.mov`); VP9 uses 2-pass, the others a single CRF pass.

**Each entry in `clips`:**

| Field          | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `file`         | Clip path (relative to `clips_dir`/config). Required unless `generator`.              |
| `generator`    | `{type, color, duration}` synthetic clip (no `file`): `color`/`testsrc`/`smptebars`/… |
| `title_pos`    | Per-clip title position (`lower`/`upper`/`center`).                                   |
| `title`        | On-screen caption text. If omitted, derived from `description`.                       |
| `description`  | Source text; fills `title` and `narration` when those are absent.                     |
| `narration`    | Spoken line for this clip. Falls back to `description`.                               |
| `trim`         | `[start, end]` seconds — **cut** to this part of the source.                          |
| `speed`        | Per-clip speed override (`0.8` slower, `1.4` faster).                                 |
| `crop`         | `{x, y, w, h}` — crop a source sub-rectangle before fitting.                          |
| `fit`          | `contain`/`cover`/`stretch` for this clip (overrides global).                         |
| `reverse`      | `true` to play the clip backwards.                                                    |
| `freeze`       | `{start, end}` seconds — hold the first/last frame.                                   |
| `volume`       | Gain for this clip's source audio (with `audio.use_source`).                          |
| `audio_fade`   | `{in, out}` seconds — fade this clip's source audio.                                  |
| `mute`         | `true` to drop this clip's source audio.                                              |
| `title_at`     | When the title appears (seconds into the clip).                                       |
| `narration_at` | When the line is spoken (defaults to `title_at`).                                     |
| `transition`   | `{type, duration}` for the join **into the next clip**.                               |
| `overlays`     | List of overlay graphics (see below).                                                 |
| `effects`      | List of effects (see below).                                                          |

Each **overlay** is either an image `{image, x, y, scale, start, end, fade}` (SVG
or raster) or **text** `{text, x, y, size, color, font, box, boxcolor, border,
bordercolor, start, end}` (rendered with `drawtext`). For images, `x`/`y` are
ffmpeg overlay expressions (`W`,`H` = canvas; `w`,`h` = overlay), `scale` is a
fraction of canvas width, and `fade` (optional, s) fades it in/out (needs a
finite `end`). For text, `x`/`y` accept `drawtext` expressions (`w`,`h`,
`text_w`, `text_h`).

The `v360` effect (`{type: v360, in, out, …}`) remaps 360/equirectangular
footage; any extra keys pass straight to the `v360` filter.

Effects apply in list order. Each **effect** is one of:

- `{type: fadein, duration}` / `{type: fadeout, duration}` — fade the clip
  from/to black.
- `{type: eq, brightness, contrast, saturation, gamma}` — colour adjust (any
  subset; `contrast`/`saturation`/`gamma` are multipliers around 1.0).
- `{type: zoom, from, to}` — Ken Burns: smooth centred zoom from `from`× to
  `to`× across the clip.
- `{type: blur, sigma}` — Gaussian blur (default `sigma: 8`).
- `{type: sharpen, amount}` — unsharp mask (default `amount: 1.0`).
- `{type: denoise}` — temporal/spatial denoise (`hqdn3d`).
- `{type: hue, h, s}` — rotate hue `h` degrees, scale saturation `s`.
- `{type: negate}` / `{type: grayscale}` / `{type: sepia}` — colour stylize.
- `{type: vignette, angle}` — darkened-corner vignette (`angle` optional).
- `{type: pixelate, size}` — mosaic; larger `size` = blockier (default `16`).
- `{type: posterize, levels}` — reduce tonal levels (default `6`).
- `{type: glow, sigma}` — bloom (blur + screen blend; default `sigma: 12`).
- `{type: sketch}` — edge-detect line-art look.
- `{type: oldfilm, grain}` — vintage curve + film grain.
- `{type: deinterlace}` — `yadif` (only for interlaced sources).
- `{type: lut, file}` — apply a 3D LUT (`.cube`), path relative to the config.
- `{type: curves, preset}` — tone-curve preset (`vintage`, `lighter`, …).
- `{type: levels, rimin, rimax, …}` — per-channel in/out levels (`colorlevels`).
- `{type: colorbalance, shadows, mids, highs}` — 3-way colour wheels; each is
  an `[r, g, b]` triple in `-1..1`.
- `{type: white_balance, temperature}` — colour temperature in Kelvin.
- `{type: stabilize, smoothing}` — `vidstab` two-pass stabilization (auto-skips
  if ffmpeg lacks vidstab).
- `{type: v360, in, out, …}` — 360/equirectangular projection remap.

Transition `type` is any ffmpeg `xfade` transition (`fade`, `wipeleft`,
`slideup`, `circleopen`, `dissolve`, …) or `cut` for a hard cut.

### Complete config skeleton

Every key with its default; override only what you need.

```yaml
output: out.webm # .webm | .mp4 | .mov — container drives the muxer
clips_dir: "" # base dir for clip files (relative to this config)
canvas: { width: 1280, height: 720, fps: 30 }
background: black # pillarbox/letterbox fill
fit: contain # contain (pillarbox) | cover (fill+crop) | stretch
speed: 1.0 # base speed for all clips
pacing:
    enabled: true
    slow: 0.7 # speed in busy spans
    fast: 1.6 # speed in quiet, untitled, silent spans
    motion_hi: 0.45 # >= this fraction of peak motion -> busy
    motion_lo: 0.06 # <= this fraction of peak motion -> quiet
    bucket: 0.5 # motion analysis granularity (s)
title:
    enabled: true
    seconds: null # fixed on-screen time, or null = reading-time
    read_wps: 2.5
    read_base: 1.0
    at: 0.0 # default appear time (s into clip)
    bar_frac: 0.20 # bar height / canvas height
    bar_color: "#000000"
    bar_opacity: 0.78
    text_color: "#f2c14e"
    font: "DejaVu Sans"
transition: { type: fade, duration: 0.6 }
intro: { narration: "", delay: 0.5 }
voice:
    enabled: true
    engine: auto # auto | kokoro | piper | flite
    tts_home: media/video
    kokoro_voice: af_heart
    kokoro_speed: 1.0
music:
    file: "" # background bed; empty = none (looped to cover the video)
    volume: 0.25
    fade_in: 1.0
    fade_out: 2.0
    duck: true # lower music while narration plays
    duck_amount: 0.35
audio:
    loudnorm: false # true | { I: -16, TP: -1.5, LRA: 11 } — EBU R128
encode:
    vcodec: libvpx-vp9 # libvpx-vp9 | libx264 | libx265 | prores_ks
    acodec: auto # auto -> opus(.webm) / aac(.mp4,.mov)
    crf: null # null -> vp9_crf for VP9, else 18
    vp9_crf: 32
    preset: medium # x264/x265 preset
    pix_fmt: yuv420p
    prores_profile: 3 # prores_ks 0..5 (3 = HQ)
    audio_kbps: 96
clips:
    - file: clip1.mp4
      title: "A caption" # or omit and use description
      narration: "What the voice says here."
      trim: [0, 10] # optional cut
      crop: { x: 0, y: 0, w: 1280, h: 720 } # optional source crop
      fit: contain # optional per-clip fit override
      speed: 1.0 # optional per-clip speed
      reverse: false # optional: play backwards
      freeze: { start: 0, end: 0 } # optional: hold first/last frame (s)
      title_at: 0.0
      transition: { type: wipeleft, duration: 0.5 }
      overlays:
          - { image: logo.svg, x: "W-w-30", y: "30", scale: 0.18, start: 1, end: 4, fade: 0.4 }
      effects:
          - { type: fadein, duration: 0.5 }
          - { type: zoom, from: 1.0, to: 1.08 } # ken burns
          - { type: eq, saturation: 1.1, contrast: 1.05 } # colour adjust
          - { type: blur, sigma: 8 } # also: sharpen, denoise, hue, negate,
          - { type: vignette } # grayscale, sepia, pixelate, deinterlace, lut
```

### Preparing source clips

`build-video.py` takes already-recorded clips. To turn a long raw capture into
clip-sized fragments (trim dead air, speed up slow stretches, add an end-card),
see [Appendix: source-clip prep](#appendix-source-clip-prep).

---

## build-demo-video.py

Rebuilds the specific Shofer marketing demo (`website/public/demo.webm`) from the
OpenShot project `media/demo.osp` — including its time-remap/freeze-frames, the
14 lower-third title bars, and the narration. The narration script, base speed,
pacing, and voice are constants at the top of the file. `--help` documents its
flags (`--speed`, `--no-pace`, `--engine`, `--no-voice`, `--keep-temp`).

It exists because that video was edited in OpenShot, whose own exporter produced
audio-only files (its x264 encoder rejected the 993×1078 odd-width source). The
script recomposes the timeline directly with ffmpeg.

---

## Voice setup

Both scripts synthesize narration with, in order of preference, **Kokoro**
(neural, natural), **Piper** (neural, flatter), then **flite** (robotic,
always-available offline fallback via `libflite`). The Kokoro/Piper environment
lives at **`SHOFER_TTS_HOME`** (default `media/video/`, git-ignored).

To (re)create it:

```bash
HOME_DIR=extensions/shofer/media/video
python3 -m venv "$HOME_DIR"
"$HOME_DIR/bin/pip" install --index-url https://pypi.org/simple/ \
  kokoro-onnx soundfile piper-tts          # piper-tts is optional (fallback)

# Kokoro model + voices (~340 MB):
mkdir -p "$HOME_DIR/kokoro"
base=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
curl -L -o "$HOME_DIR/kokoro/kokoro-v1.0.onnx"  "$base/kokoro-v1.0.onnx"
curl -L -o "$HOME_DIR/kokoro/voices-v1.0.bin"   "$base/voices-v1.0.bin"
```

The venv has machine-specific absolute paths, so it isn't portable — recreate it
per machine. Run with `--no-voice` to skip narration entirely.

---

## Appendix: source-clip prep

How the demo's source screencast was reduced from a 17-minute raw capture to a
~63s clip. Useful as a recipe for making fragments for `build-video.py`.

Common VP9 encode flags (`$VP9`):

```
-c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 -pix_fmt yuv420p -an
```

`-b:v 0 -crf 32` = constant-quality VP9; `-an` = no audio.

> Source caveat: the capture is VFR with a millisecond (1000) timebase, so tools
> that trust the container fps misread it. Work in real seconds or re-decode.

### 1 — Trim dead segments (ffmpeg concat demuxer)

Keep only the wanted ranges; one sequential re-encode is memory-light. List the
kept ranges in a cut-list and run:

```
# /tmp/cut-list.txt — repeat per kept range:
file '/abs/path/screencast.webm'
inpoint 0
outpoint 14
...
```

```bash
ffmpeg -y -f concat -safe 0 -i /tmp/cut-list.txt $VP9 screencast-trimmed.webm
```

### 2 — Speed up a slow stretch

Encode the parts separately (avoids `split`+`concat` frame-buffering that can
exhaust RAM), then concat the small pieces.

```bash
ffmpeg -y -i "$SRC" -ss 0 -to 11 $VP9 /tmp/seg_a.webm                       # normal
ffmpeg -y -ss 11 -to 410 -i "$SRC" -filter:v "setpts=(PTS-STARTPTS)/133.0" \
  -r 30 $VP9 /tmp/seg_b.webm                                                # 133x
ffmpeg -y -i "$SRC" -ss 410 $VP9 /tmp/seg_c.webm                           # normal
ffmpeg -y -i /tmp/seg_a.webm -i /tmp/seg_b.webm -i /tmp/seg_c.webm \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1[out]" -map "[out]" $VP9 out.webm
```

**Gotcha:** for the sped segment, seek on the **input** side (`-ss/-to` _before_
`-i`). Output-side seeking after `setpts` discards the whole (now-short) clip and
yields 0 frames.

### 3 — Append a logo end-card

Render the vector logo crisply with Inkscape (ImageMagick's SVG fallback is
blurry), composite centered on white, make a 1s clip, and concat:

```bash
inkscape "$SVG" --export-type=png --export-filename=/tmp/mark.png \
  --export-area-drawing --export-height=560
convert -size 1080x1136 xc:white /tmp/mark.png -gravity center -composite /tmp/endcard.png
ffmpeg -y -loop 1 -i /tmp/endcard.png -t 1 -r 30 \
  -c:v libvpx-vp9 -b:v 0 -crf 28 -row-mt 1 -pix_fmt yuv420p -an /tmp/endcard.webm
ffmpeg -y -i in.webm -i /tmp/endcard.webm \
  -filter_complex "[0:v][1:v]concat=n=2:v=1[out]" -map "[out]" $VP9 final.webm
```

### Notes

- An earlier approach used a similarity-based **deduplicator** (drops near-identical
  consecutive frames to a target duration or a "% pixels changed" threshold).
  Replaced by explicit trim+speed-up here because the cuts were known.
- Avoid `split`-into-`concat` on the long source — it buffers decoded frames and
  can exhaust RAM.
