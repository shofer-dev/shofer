# Video config schema (the agent's IR)

Reference for the YAML/JSON config consumed by
`scripts/video-builder/build-video.py` — the **intermediate representation** the
LLM agents read and write, the viewer renders, and the engine executes. Prose
docs live in [`scripts/video-builder/README.md`](../scripts/video-builder/README.md);
this file is the **field-level contract**, intended to be promoted to a published
**JSON Schema** (`video-config.schema.json`) that tools validate against before
rendering.

Paths are resolved relative to the config file (or to `clips_dir` if set). Only
`clips` is required; everything else has a default.

## Top-level

| Key               | Type / values                 | Default       | Notes                                             |
| ----------------- | ----------------------------- | ------------- | ------------------------------------------------- |
| `output`          | path (`.webm`/`.mp4`/`.mov`)  | `out.webm`    | Container picks codec when `encode.vcodec: auto`. |
| `clips_dir`       | string                        | `""`          | Base dir prepended to clip/asset paths.           |
| `canvas`          | `{width,height,fps}`          | `1280×720@30` | Output geometry.                                  |
| `background`      | color                         | `black`       | Pillarbox/letterbox fill.                         |
| `fit`             | `contain`\|`cover`\|`stretch` | `contain`     | Default clip fit.                                 |
| `speed`           | number                        | `1.0`         | Global base speed (`0.5` = half).                 |
| `subtitles`       | path `.srt`/`.ass`            | `""`          | Burned into output.                               |
| `subtitles_style` | string                        | `""`          | ffmpeg `force_style` (srt).                       |
| `pacing`          | object                        | see below     | Motion-adaptive speed.                            |
| `title`           | object                        | see below     | Generated title bars.                             |
| `transition`      | `{type,duration}`             | `{fade,0.6}`  | Default join between clips.                       |
| `intro`           | `{narration,delay}`           | `{"",0.5}`    | Optional spoken intro.                            |
| `voice`           | object                        | see below     | TTS narration.                                    |
| `music`           | bed **or list of beds**       | `{file:""}`   | Background music.                                 |
| `audio`           | object                        | see below     | Final-mix audio + source audio.                   |
| `encode`          | object                        | see below     | Codec/container/quality.                          |
| `clips`           | list of **clip**              | —             | **Required**, in playback order.                  |

### `pacing`

`enabled` (bool), `slow` (speed in busy spans, `0.7`), `fast` (speed in quiet
untitled silent spans, `1.6`), `motion_hi`/`motion_lo` (peak-motion fractions,
`0.45`/`0.06`), `bucket` (analysis granularity s, `0.5`).

### `title`

`enabled`, `position` (`lower`/`upper`/`center`), `animate`
(`none`/`fade`/`slide`/`slidefade`), `animate_dur` (`0.4`), `seconds` (fixed time
or `null` = reading-time), `read_wps` (`2.5`), `read_base` (`1.0`), `at` (appear
time), `bar_frac` (`0.20`), `bar_color`, `bar_opacity` (`0.78`), `text_color`,
`font`, `max_font_frac` (`0.045`), `margin_frac` (`0.04`).

### `voice`

`enabled`, `engine` (`auto`/`kokoro`/`piper`/`flite`), `tts_home`, `kokoro_voice`
(`af_heart`…), `kokoro_speed`, `narration_gap`.

### `music` (single bed, or a list of these)

`file` (path; empty = none, looped to cover), `volume` (`0.25`), `fade_in`
(`1.0`), `fade_out` (`2.0`), `duck` (bool, dip under narration), `duck_amount`
(`0.35`).

### `audio` (final-mix filters + source-clip audio)

`use_source` (mix each clip's own audio), `source_volume`, `source_duck`,
`source_duck_amount`; `loudnorm` (`true` or `{I,TP,LRA}`), `gain` (dB), `bass`
(dB), `treble` (dB), `balance` (−1..1), `denoise` (bool), `compress` (bool),
`filters` (list of raw ffmpeg audio filters — escape hatch).

### `encode`

`vcodec` (`auto`\|`libvpx-vp9`\|`libx264`\|`libx265`\|`prores_ks`\|hardware e.g.
`h264_nvenc`), `acodec` (`auto`→opus/aac), `crf` (`null`→`vp9_crf` for VP9 else
`18`), `vp9_crf` (`32`), `preset` (`medium`), `pix_fmt` (`yuv420p`),
`prores_profile` (`3`), `audio_kbps` (`96`), `extra` (list of raw ffmpeg args).

## Clip object

| Field           | Type                              | Notes                                                |
| --------------- | --------------------------------- | ---------------------------------------------------- |
| `file`          | path                              | **Required** unless `generator`.                     |
| `generator`     | `{type,color,duration}`           | Synthetic clip: `color`/`testsrc`/`smptebars`/…      |
| `title`         | string                            | On-screen caption (else derived from `description`). |
| `description`   | string                            | Fills `title`/`narration` when absent.               |
| `narration`     | string                            | Spoken line (falls back to `description`).           |
| `trim`          | `[start,end]` s                   | Cut to this source range.                            |
| `crop`          | `{x,y,w,h}`                       | Source sub-rectangle (pre-fit).                      |
| `fit`           | `contain`/`cover`/`stretch`       | Overrides global.                                    |
| `speed`         | number                            | Per-clip speed.                                      |
| `reverse`       | bool                              | Play backwards.                                      |
| `freeze`        | `{start,end}` s                   | Hold first/last frame.                               |
| `transform`     | `{scale,rotate,x,y}`              | Position/scale/rotate over background.               |
| `retime`        | `[[t,speed],…]`                   | Piecewise variable speed ramp.                       |
| `volume`        | number                            | Source-audio gain (with `audio.use_source`).         |
| `audio_fade`    | `{in,out}` s                      | Fade source audio.                                   |
| `mute`          | bool                              | Drop source audio.                                   |
| `title_at`      | s                                 | Title appear time.                                   |
| `title_pos`     | `lower`/`upper`/`center`          | Per-clip title position.                             |
| `title_animate` | `none`/`fade`/`slide`/`slidefade` | Per-clip title animation.                            |
| `narration_at`  | s                                 | When the line is spoken (defaults to `title_at`).    |
| `transition`    | `{type,duration}`                 | Join **into the next clip**.                         |
| `overlays`      | list of **overlay**               | Layered graphics/video/text.                         |
| `effects`       | list of **effect**                | Applied in order.                                    |

## Overlay (one of three kinds)

**Common:** `start`, `end` (seconds within the clip), `x`, `y`.
`x`/`y` accept a number, an ffmpeg expression, or a **keyframe spec** (motion path).

- **image** — `{image, scale, fade, mask}` + common. `scale` = fraction of canvas
  width; `fade` (s) needs finite `end`; `mask` = grayscale image shaping alpha.
- **text** — `{text, size, color, font, box, boxcolor, boxborderw, border,
bordercolor}` + common (rendered via `drawtext`).
- **video** (picture-in-picture) — `{video, trim, scale, rotate, opacity,
chromakey, blend}` + common. `scale` may be a number **or a keyframe spec**
  (grow/shrink). `chromakey` = color string or `{color,similarity}`. `blend`
  (e.g. `screen`/`multiply`) composites full-frame instead of positioning.

### Keyframe spec

`{keyframes: [[t, value], …], interp: linear|hold}` → piecewise expression in `t`.
Used for overlay `x`/`y` (canvas px) and a video overlay's `scale` (0..1).

## Effect (discriminated by `type`)

| `type`                           | Params                                                    |
| -------------------------------- | --------------------------------------------------------- |
| `fadein` / `fadeout`             | `duration`                                                |
| `eq`                             | `brightness`,`contrast`,`saturation`,`gamma` (any subset) |
| `zoom`                           | `from`,`to` (Ken Burns)                                   |
| `blur`                           | `sigma`                                                   |
| `sharpen`                        | `amount`                                                  |
| `denoise`                        | —                                                         |
| `hue`                            | `h`,`s`                                                   |
| `negate` / `grayscale` / `sepia` | —                                                         |
| `vignette`                       | `angle?`                                                  |
| `pixelate`                       | `size`                                                    |
| `posterize`                      | `levels`                                                  |
| `glow`                           | `sigma`                                                   |
| `sketch`                         | —                                                         |
| `oldfilm`                        | `grain?`                                                  |
| `deinterlace`                    | —                                                         |
| `lut`                            | `file` (`.cube`)                                          |
| `curves`                         | `preset`                                                  |
| `levels`                         | `rimin,rimax,gimin,…` (`colorlevels` keys)                |
| `colorbalance`                   | `shadows`,`mids`,`highs` (each `[r,g,b]`, −1..1)          |
| `white_balance`                  | `temperature` (K)                                         |
| `stabilize`                      | `smoothing` (vidstab 2-pass)                              |
| `v360`                           | `in`,`out` (+ any extra `v360` params)                    |

## Transitions

`transition.type` = any ffmpeg `xfade` name (`fade`, `wipeleft`, `slideup`,
`circleopen`, `dissolve`, `pixelize`, …) or `cut` (hard cut). `duration` in s.

---

### Toward a JSON Schema

When formalizing as `video-config.schema.json`: model overlays as a `oneOf`
keyed by presence of `image`/`text`/`video`; effects as a `oneOf`/discriminated
union on `type`; keyframe-able fields (`overlay.x/y`, video `overlay.scale`) as
`oneOf: [number, string, {keyframes,…}]`; and `music` as `oneOf: [bed,
array<bed>]`. The agents should validate against it before calling `render_video`.
