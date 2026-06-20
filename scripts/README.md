# Video tooling

Scripts for turning screen-recording clips into a narrated, paced, polished
video — titles, voiceover, transitions, overlays, and adaptive speed, all from a
single config file.

| Script                | What it does                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`build-video.py`**  | Generic, config-driven builder. Assembles a video from one or more clips described in a YAML/JSON file. **Use this for new videos.**                                                                |
| `build-demo-video.py` | The original Shofer demo builder. Rebuilds the marketing demo from the OpenShot project (`media/demo.osp`); narration/pacing are hard-coded near the top. Kept for reproducing that specific video. |
| `video.example.yaml`  | A fully-commented example config for `build-video.py`.                                                                                                                                              |

Both write a `VP9 + Opus` `.webm`. Requirements: `ffmpeg`, `ffprobe`, `inkscape`,
and (for `.yaml` configs) `PyYAML`. Voiceover needs a TTS environment — see
[Voice setup](#voice-setup).

---

## build-video.py

```bash
python3 scripts/build-video.py CONFIG.yaml            # build
python3 scripts/build-video.py CONFIG.yaml --no-voice # skip narration
python3 scripts/build-video.py --help
```

Flags: `--no-voice`, `--no-pace` (uniform speed), `--keep-temp` (keep the scratch
dir for debugging), `-h/--help`.

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

### Config reference

Paths inside the config are resolved relative to the config file (or to
`clips_dir`, if set). Only `clips` is required; everything else has a default.
See `video.example.yaml` for a working file. Top-level keys:

| Key          | Default                          | Meaning                                        |
| ------------ | -------------------------------- | ---------------------------------------------- |
| `output`     | `out.webm`                       | Output path (relative to the config file).     |
| `clips_dir`  | `""`                             | Base dir prepended to each clip's `file`.      |
| `canvas`     | `{width:1280,height:720,fps:30}` | Output frame geometry.                         |
| `background` | `black`                          | Pillarbox/letterbox fill for off-aspect clips. |
| `speed`      | `1.0`                            | Base speed for all clips (`0.5` = half speed). |
| `pacing`     | see below                        | Adaptive speed by motion.                      |
| `title`      | see below                        | Generated title-bar style.                     |
| `transition` | `{type:fade,duration:0.6}`       | Default join between clips.                    |
| `intro`      | `{narration:"",delay:0.5}`       | Optional spoken intro before clip 1.           |
| `voice`      | see below                        | TTS engine + voice.                            |
| `encode`     | `{vp9_crf:32,audio_kbps:96}`     | Output quality.                                |
| `clips`      | —                                | Ordered list of clips (below).                 |

**`pacing`**: `enabled`, `slow` (speed in busy spans), `fast` (speed in quiet,
untitled, silent spans), `motion_hi`/`motion_lo` (fractions of peak motion that
count as busy/quiet), `bucket` (analysis granularity, s).

**`title`**: `enabled`, `seconds` (fixed on-screen time, or `null` to derive from
reading time), `read_wps`/`read_base` (reading-time formula), `at` (default
appear time), `bar_frac`, `bar_color`, `bar_opacity`, `text_color`, `font`.

**`voice`**: `enabled`, `engine` (`auto|kokoro|piper|flite`), `tts_home` (default
`media/video`), `kokoro_voice` (`af_heart`, `af_bella`, `am_michael`, `am_onyx`,
`bm_george`), `kokoro_speed`.

**Each entry in `clips`:**

| Field          | Meaning                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `file`         | Clip path (relative to `clips_dir`/config). **Required.**                                                                                                  |
| `title`        | On-screen caption text. If omitted, derived from `description`.                                                                                            |
| `description`  | Source text; fills `title` and `narration` when those are absent.                                                                                          |
| `narration`    | Spoken line for this clip. Falls back to `description`.                                                                                                    |
| `trim`         | `[start, end]` seconds — **cut** to this part of the source.                                                                                               |
| `speed`        | Per-clip speed override (e.g. `0.8` slow, `1.4` fast).                                                                                                     |
| `title_at`     | When the title appears (seconds into the clip).                                                                                                            |
| `narration_at` | When the line is spoken (defaults to `title_at`).                                                                                                          |
| `transition`   | `{type, duration}` for the join **into the next clip**.                                                                                                    |
| `overlays`     | List of `{image, x, y, scale, start, end}` (SVG or raster). `x`/`y` are ffmpeg expressions; `W,H`=canvas, `w,h`=overlay; `scale`=fraction of canvas width. |
| `effects`      | List of `{type: fadein                                                                                                                                     | fadeout, duration}`. |

Transition `type` is any ffmpeg `xfade` transition (`fade`, `wipeleft`,
`slideup`, `circleopen`, `dissolve`, …) or `cut` for a hard cut.

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
