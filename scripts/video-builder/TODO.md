# video-builder — editor feature gap (TODO)

This file tracks capabilities that desktop editors (**OpenShot**, **Shotcut**)
offer that our config-driven `build-video.py` does **not** currently support.
It's a backlog of candidate features, not a list of bugs. Each item notes
roughly how hard it would be to add (ffmpeg already gives us most of the
primitives). The first sections came from OpenShot; the Shotcut section below
adds what's distinct or richer there.

Everything we add stays **config-driven** (a new key in the YAML/JSON) and
**documented** in `README.md`.

## What we already support

For reference, the engine already does: per-clip trim/cut, per-clip and
adaptive (motion-based) speed, generated lower-third titles with reading-time
sizing, clip transitions (`fade`/`wipe*`/`slide*`/`circleopen`/`dissolve`…),
`fadein`/`fadeout`, `eq` (brightness/contrast/saturation/gamma), `zoom`
(Ken Burns), image/SVG overlays with fade, spoken intro + per-clip TTS
narration, a ducked background-music bed, pillarbox/letterbox, VP9+Opus encode.

---

## Missing — compositing / layout

- [x] **Multiple simultaneous video tracks** — stack N video `overlays` (each a
      PiP layer) over a clip. _Layered compositing rather than a free timeline,
      but covers the practical "video over video" case._
- [x] **Picture-in-picture (video overlay)** — `overlays: {video, trim, scale,
  x, y, start, end}`, with optional `rotate`/`opacity`/`chromakey`/`blend`.
- [x] **Per-clip transform: position / scale / rotation** — `transform:
  {scale, rotate, x, y}` composited onto the background. _(shear not done.)_
- [x] **Crop / region selection.** Crop a clip to a sub-rectangle.
      _Easy — ffmpeg `crop`; add `crop: {x,y,w,h}`._
- [x] **Blend / compositing modes** — a video overlay with `blend: multiply|
  screen|overlay|…` blends full-frame (`blend=all_mode=…`).
- [x] **Scale modes** (fit / stretch / crop-to-fill). We always fit+pad.
      _Easy — `fit: contain|cover|stretch`._

## Missing — keyframe animation

- [x] **Keyframe engine (bounded)** — `kf_expr` compiles
      `{keyframes: [[t, v], …], interp: linear|hold}` into an ffmpeg `t`-
      expression. Wired to overlay `x`/`y` (motion paths). Also: animated titles
      and per-clip variable retiming (below). _Arbitrary per-filter-param
      keyframing (e.g. animated `eq`/blur) is bounded by which ffmpeg filters
      accept time expressions — full coverage would need a `sendcmd` layer._

## Missing — video effects / filters

- [x] **Chroma key / green screen** — `overlays: {video, chromakey: {color,
  similarity}}` keys a PiP layer over the clip beneath it.
- [x] **Blur** (gaussian) — `effects: {type: blur}`. _(Animated blur-in titles
      still pending the keyframe engine.)_
- [x] **Hue / color-shift / negate / pixelate / posterize** — `hue`/`negate`/
      `pixelate`/`posterize` effects (plus `grayscale`/`sepia`).
- [x] **Mask / alpha mask from an image** — image `overlays: {image, mask}`
      shapes the overlay's alpha from a grayscale image (`alphamerge`).
- [x] **Vignette** done (effect). _wave / distortion / bars dropped as niche /
      low-value for screencast demos._
- [x] **Stabilizer** — `effects: {type: stabilize, smoothing}` (`vidstab`
      two-pass; auto-skips if ffmpeg lacks vidstab).
- [x] ~~**Object detection / tracking**~~ — won't do: needs a bundled OpenCV
      tracker / ML model, which is far outside an ffmpeg-orchestration tool. Use
      a real NLE (OpenShot/Shotcut/Resolve) for motion tracking.
- [x] **Deinterlace** — `effects: {type: deinterlace}` (`yadif`).

## Missing — time effects

- [x] **Reverse playback** — per-clip `reverse: true`.
- [x] **Explicit freeze-frame** — per-clip `freeze: {start, end}` (holds the
      first/last frame via `tpad`). _(Mid-clip freeze still needs the keyframe/
      time-remap engine.)_
- [x] **Variable retiming** — per-clip `retime: [[t, speed], …]` (piecewise
      speed ramps), in addition to the global motion-based adaptive pacing.

## Missing — audio

- [x] **Use the source clip's own audio** — `audio: {use_source: true}`; each
      clip's audio is trimmed/sped/reversed/frozen to match its video, placed,
      and warped through the pacing map.
- [x] **Per-clip volume / audio fades** — clip `volume`, `audio_fade: {in,out}`,
      `mute`. _(Keyframed volume still needs the keyframe engine.)_
- [x] **Audio effects** — final-mix `bass`/`treble` (EQ), `compress`, `denoise`,
      and pitch-preserving speed (atempo).
- [x] **Multiple music/SFX beds** — `music` accepts a list of beds (each with
      its own volume/fades/duck).

## Missing — titles / text

- [x] **Animated titles** — `title.animate`: `fade` / `slide` / `slidefade`
      (per-clip `title_animate`). _(typewriter/blur-in not done.)_
- [x] **Title templates / positions** — `title.position` / per-clip `title_pos`
      (`lower`/`upper`/`center`); full-screen cards via `generator` clips.
- [x] **Rich SVG/HTML title import** — SVG/PNG via `overlays`, and styled text
      via text `overlays` (`drawtext`). _(text-on-path / 3D text not done.)_

## Missing — transitions

- [x] ~~**Custom mask-image (luma) transitions**~~ — won't do: we already expose
      all ~50 built-in `xfade` transitions (fade/wipes/slides/circles/dissolve/
      pixelize/…). Arbitrary user luma-image wipes need a bespoke per-frame
      blend graph in the assembler for marginal benefit over the built-ins.
- [x] ~~**Per-transition easing**~~ — won't do: ffmpeg `xfade` exposes no easing
      curve (only `transition`/`duration`/`offset`, and offset is already
      computed). Would require a custom blend graph; not worth it.

## Missing — Shotcut features

Shotcut overlaps heavily with OpenShot (multi-track timeline, keyframes, chroma
key, blur, crop, transform, stabilize, reverse, freeze, mask, masked wipes — all
already listed above). The items below are where Shotcut goes **beyond** what's
captured so far, mostly via its large MLT/frei0r filter set.

### Color / grading (richer than our `eq`)

- [x] **3-way color wheels** + **white balance** — `colorbalance` (shadows/
      mids/highs) and `white_balance` (`colortemperature`) effects.
- [x] **Curves / levels** — `curves` (preset) and `levels` (`colorlevels`)
      effects.
- [x] **3D LUT (`.cube`) application** — `effects: {type: lut, file: foo.cube}`.
- [x] **Sharpen** (`unsharp`) and **denoise** (`hqdn3d`) — `sharpen`/`denoise`
      effects.

### Stylize filters

- [x] **vignette**, **sepia**, **mosaic**, **old-film** (`oldfilm`: vintage
      curve + grain), **sketch** (`edgedetect`) done. **glow** added in the
      compositing batch (split+blur+screen blend).

### Text / titles (richer than our lower-third bar)

- [x] **Rich text filter** — text `overlays` via `drawtext` (size, colour, box,
      border, position, time window). _(text-on-path / 3D text not done.)_
- [x] **Subtitles** — burn-in `.srt`/`.ass` via top-level `subtitles` (+
      `subtitles_style`). _(Sidecar/soft-sub export not done.)_

### Audio (Shotcut's audio filter set is large)

- [x] **Loudness normalization** (EBU R128) — `audio: {loudnorm: true}` or
      `{I, TP, LRA}` on the final mix.
- [x] **Compressor / limiter** — `audio: {compress: true}` (`acompressor`) plus
      the existing narration `alimiter`. _(expander/gate/notch still pending.)_
- [x] **Gain / balance / bass & treble** — `audio: {gain, balance, bass, treble}`.
- [x] **Clip audio crossfade** at transitions — overlapping source-audio beds
      with per-clip `audio_fade` crossfade across the transition window.

### Source generators (clips with no input file)

- [x] **Synthetic source clips** — `generator: {type, color, duration}`
      (`color`/`testsrc`/`smptebars`/…); combine with a text `overlay` for a
      title card. _(count/timer not done.)_

### Speed / time

- [x] **Pitch-preserving speed change** — source-clip audio is retimed with an
      `atempo` chain (pitch-preserving) to match the video speed and pacing map.

### Encode / export

- [x] **Multiple codecs & containers + hardware encode** — `encode.vcodec`
      (VP9/H.264/H.265/ProRes, or `h264_nvenc`/`hevc_qsv`/`*_vaapi`) + `acodec`;
      container from the `output` extension; `encode.extra` passes raw args
      (e.g. `-cq`) to hardware encoders.

### 360° video

- [x] **360°/equirectangular filters** — `effects: {type: v360, in, out, …}`
      (any `v360` projection/params). 360-aware stabilize not separately done.

## Out of scope (editor-only, no output relevance)

These are interactive-editing features with no bearing on a headless,
config-driven render, listed only for completeness:

- Razor/split, ripple/roll edits, snapping, magnetic timeline
- Timeline markers, audio-waveform display, clip thumbnails
- Drag-to-resize transitions, manual keyframe curve editing UI
- Project/library asset management, frame snapshot export
- Shotcut: video/audio **scopes** (waveform, vectorscope, histogram, VU/loudness
  meter), **proxy editing**, **webcam/screen/audio capture**, **3-point editing**,
  detached-audio editing, project notes

---

### Suggested priority order

**Done:** crop, scale/fit modes, blur, hue/negate/pixelate/grayscale/sepia,
vignette, deinterlace, reverse, freeze, 3D LUT, sharpen, denoise, loudness
normalization, multi-codec/container encode (VP9/H.264/H.265/ProRes).

Remaining, roughly in priority order:

1. Source-clip audio mixing (`audio.use_source`) — most-requested for real footage.
2. Keyframe engine — unlocks animation across the board (animated titles/blur-in,
   mid-clip freeze, motion paths).
3. Synthetic generator clips (color/text/transparent cards) — easy intro/outro.
4. Hardware-accelerated encoding (NVENC/QSV/VAAPI).
5. Per-clip transform (position/scale/rotation).
6. Picture-in-picture video overlays (also unblocks chroma-key compositing).
