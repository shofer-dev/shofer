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

- [ ] **Multiple simultaneous video tracks.** OpenShot composites N stacked
      tracks; we only play clips sequentially (+ static image overlays). A
      real "track" model would let a video clip play _over_ another.
      _Hard — needs a timeline/track abstraction in the config and a layered
      `overlay` graph._
- [ ] **Picture-in-picture (video overlay).** Overlay a _second video_ (not
      just an image) at an arbitrary position/scale/time window.
      _Medium — extend `overlays` to accept video files with their own trim._
- [ ] **Per-clip transform: position / scale / rotation / shear.** OpenShot
      keyframes location, scale, rotation and shear per clip. We only center +
      pillarbox. _Medium — `transform: {x,y,scale,rotation}`, static first,
      keyframed later._
- [x] **Crop / region selection.** Crop a clip to a sub-rectangle.
      _Easy — ffmpeg `crop`; add `crop: {x,y,w,h}`._
- [ ] **Blend / compositing modes** (multiply, screen, overlay, add…).
      _Medium — ffmpeg `blend=all_mode=…` between layers._
- [x] **Scale modes** (fit / stretch / crop-to-fill). We always fit+pad.
      _Easy — `fit: contain|cover|stretch`._

## Missing — keyframe animation

- [ ] **General keyframe engine** with linear / bezier / constant
      interpolation for _any_ property (opacity, scale, position, volume,
      effect params). This is OpenShot's core differentiator. Our effects are
      mostly start→end ramps (zoom) or simple fades.
      _Hard — a shared keyframe representation + per-property `sendcmd`/expr
      generation. The single biggest gap._

## Missing — video effects / filters

- [ ] **Chroma key / green screen** (`colorkey`/`chromakey`). _Easy._
- [x] **Blur** (gaussian) — `effects: {type: blur}`. _(Animated blur-in titles
      still pending the keyframe engine.)_
- [x] **Hue / color-shift / negate / pixelate / posterize** — `hue`/`negate`/
      `pixelate`/`posterize` effects (plus `grayscale`/`sepia`).
- [ ] **Mask / alpha mask from an image (luma wipe).** OpenShot uses mask
      images for custom transitions and clip masks. _Medium — `alphamerge`/
      `maskedmerge`._
- [x] **Vignette** done (effect). _wave / distortion / bars dropped as niche /
      low-value for screencast demos._
- [x] **Stabilizer** — `effects: {type: stabilize, smoothing}` (`vidstab`
      two-pass; auto-skips if ffmpeg lacks vidstab).
- [ ] **Object detection / tracking** (track a box to a moving object).
      _Hard — OpenShot bundles an OpenCV tracker; out of scope for now._
- [x] **Deinterlace** — `effects: {type: deinterlace}` (`yadif`).

## Missing — time effects

- [x] **Reverse playback** — per-clip `reverse: true`.
- [x] **Explicit freeze-frame** — per-clip `freeze: {start, end}` (holds the
      first/last frame via `tpad`). _(Mid-clip freeze still needs the keyframe/
      time-remap engine.)_
- [ ] **Variable retiming via keyframes** (speed ramps inside one clip).
      _Medium — ties into the keyframe engine._

## Missing — audio

- [ ] **Use the source clip's own audio.** We currently build the soundtrack
      from TTS + music only; clip audio is dropped. _Medium — mix `a` streams,
      add `audio: {use_source, volume}` per clip._
- [ ] **Per-clip volume keyframes / audio fades.** _Easy once source audio is
      mixed in._
- [ ] **Audio effects** (EQ, compressor, noise reduction, pitch). _Medium._
- [ ] **Multiple music/SFX beds** (we support exactly one music file).
      _Easy — accept a list._

## Missing — titles / text

- [ ] **Animated titles** (slide-in, fade-in, typewriter, blur-in). Ours are
      static lower-thirds. _Medium — animate the overlay via keyframes._
- [ ] **Title templates / positions** (upper-third, centered, full-screen
      cards, multi-line with subtitle). _Easy — `title_style`/`title_pos`._
- [ ] **Rich SVG/HTML title import** (OpenShot's title editor). We render our
      own bar; importing arbitrary SVG titles with their own layout is partly
      covered by `overlays`. _Low priority._

## Missing — transitions

- [ ] **Custom mask-image (luma) transitions.** OpenShot ships dozens of mask
      wipes; we expose ffmpeg `xfade` presets only. _Medium._
- [ ] **Per-transition easing / offset control** beyond `type`+`duration`.
      _Easy._

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

- [ ] **Rich text filter** — HTML/styled text with outline, background box,
      drop shadow, and **text-on-path / 3D text**. _Medium — `drawtext` covers
      the basics; full rich text needs SVG rendering._
- [ ] **Subtitles** — import/burn-in **SRT/VTT**, or export a sidecar track.
      We have titles but no subtitle concept. _Easy (burn-in) — `subtitles`
      filter; add `subtitles: file.srt`._

### Audio (Shotcut's audio filter set is large)

- [x] **Loudness normalization** (EBU R128) — `audio: {loudnorm: true}` or
      `{I, TP, LRA}` on the final mix.
- [ ] **Compressor / limiter / expander / gate / notch.** _Medium —
      `acompressor`/`alimiter`/`agate`._
- [ ] **Gain / pan / balance / bass & treble / channel ops.** _Easy —
      `volume`/`pan`/`bass`/`treble`. Extends the existing audio backlog._
- [ ] **Clip audio crossfade** at transitions (`acrossfade`). _Easy once
      source-clip audio is mixed in._

### Source generators (clips with no input file)

- [ ] **Synthetic source clips** — solid **color**, **text card**, **noise**,
      **transparent**, **count/timer**. We require a real `file` per clip.
      _Easy — `color=`/`testsrc`/`drawtext` virtual inputs; add a `generator`
      clip type. Good for intro/outro cards without prerendered assets._

### Speed / time

- [ ] **Pitch-preserving speed change.** Shotcut keeps audio pitch when you
      retime; we change `setpts` only and drop clip audio anyway.
      _Medium — `atempo` chain, relevant once source audio is mixed in._

### Encode / export

- [x] **Multiple codecs & containers** — `encode.vcodec` (VP9/H.264/H.265/
      ProRes) + `acodec`; container from the `output` extension (.webm/.mp4/
      .mov). _(Hardware-accelerated encoding NVENC/QSV/VAAPI still pending.)_

### 360° video

- [ ] **360°/equirectangular filters** (projection, rectilinear view, 360
      stabilize). _Medium, niche — `v360`. Only if we ever target VR footage._

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
