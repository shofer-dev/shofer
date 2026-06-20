#!/usr/bin/env python3
"""
Build the Shofer demo video from the OpenShot project (media/demo.osp).

Why this exists
---------------
OpenShot's own "Export Video" produces an audio-only file for this project: its
x264 encoder fails on the 993x1078 screencast source (odd width) and on the
second clip, which references source content past the end of the recording, so
OpenShot writes only the (silent) audio track. Instead of fighting the exporter
we recompose the timeline directly with ffmpeg, which is fully reproducible.

Pipeline
--------
  1. Parse media/demo.osp for clip positions, source windows and the per-clip
     `time` keyframe curve (OpenShot's time-remap / freeze-frame feature).
  2. Rasterize the lower-third title SVGs (media/demo_assets/title/*.svg) to
     1280x720 transparent PNGs with Inkscape.
  3. For each video clip, rebuild the time-remapped stream by concatenating the
     source's play- and freeze-segments described by the `time` curve, take the
     clip's visible [start, end] window, scale-to-fit + center (pillarbox) on a
     black 1280x720 canvas, then overlay each title bar during its in/out window.
  4. Encode VP9 -> website/public/demo.webm.

All work happens in a temp dir; only the final webm is written into the repo.

Requirements: python3, ffmpeg, inkscape.
Usage: python3 scripts/build-demo-video.py [--keep-temp]
"""
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))      # extensions/shofer (../../)
OSP = os.path.join(ROOT, "media", "demo.osp")
OUT = os.path.join(ROOT, "website", "public", "demo.webm")

# Base playback speed (1.0 = original timing). 0.5 = half speed. With adaptive
# pacing off, the whole video plays at this speed. Override with --speed.
SPEED = 0.5

# ---- Adaptive pacing ----------------------------------------------------------
# Instead of one uniform speed, compute a per-region speed from screen motion
# and title presence: busy spans slow down, quiet+untitled spans speed up, and
# titles are slowed enough to read. Narration is never accelerated (stays in
# sync). Toggle with --no-pace. Tunables below (Balanced defaults).
PACE_ADAPTIVE = True
PACE_SLOW = 0.40          # speed for high-motion ("too fast") spans
PACE_FAST = 1.30          # speed for quiet spans with no title and no narration
PACE_MOTION_HI = 0.45     # >= this fraction of peak motion -> slow span
PACE_MOTION_LO = 0.06     # <= this fraction of peak motion -> quiet (accelerate)
PACE_BUCKET = 0.5         # analysis granularity, seconds (original timeline)
PACE_READ_WPS = 2.5       # title reading speed (words/sec) for readability
PACE_READ_BASE = 1.0      # extra seconds for the eye to land on a new title

# ---- Voiceover ----------------------------------------------------------------
# Synthesized narration, muxed in as an Opus audio track. Each line is spoken
# starting at its caption's on-screen time (scaled for SPEED). Disable with
# --no-voice.
NARRATE = True

# Engine selection: "auto" picks the best available (Kokoro -> Piper -> flite).
# Force one with --engine kokoro|piper|flite (handy for A/B comparison).
ENGINE = os.environ.get("TTS_ENGINE", "auto")

# Persistent home for the TTS venv + models (override with SHOFER_TTS_HOME).
# Lives in the repo at media/video/ (git-ignored); survives reboots, unlike /tmp.
TTS_HOME = os.environ.get("SHOFER_TTS_HOME", os.path.join(ROOT, "media", "video"))

# Kokoro (neural, natural prosody). Voice options include af_heart, af_bella,
# am_michael, am_onyx, bm_george; SPEED above is video speed, KOKORO_SPEED is
# speech rate. See https://github.com/thewh1teagle/kokoro-onnx
KOKORO_PYTHON = os.environ.get("KOKORO_PYTHON", f"{TTS_HOME}/bin/python")
KOKORO_MODEL = os.environ.get("KOKORO_MODEL", f"{TTS_HOME}/kokoro/kokoro-v1.0.onnx")
KOKORO_VOICES = os.environ.get("KOKORO_VOICES", f"{TTS_HOME}/kokoro/voices-v1.0.bin")
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
KOKORO_SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))

# Piper (neural but flatter). Override via env PIPER_BIN / PIPER_VOICE.
PIPER_BIN = os.environ.get("PIPER_BIN", f"{TTS_HOME}/bin/piper")
PIPER_VOICE = os.environ.get(
    "PIPER_VOICE", f"{TTS_HOME}/voices/en_US-lessac-medium.onnx")

# Optional spoken intro, played near the very start before the first caption's
# line (does not shift any video or other narration). INTRO_DELAY is in final
# (slowed) timeline seconds. Set INTRO = "" to disable.
INTRO = ("Meet Shofer, the open-source AI coding agent for VS Code, built for "
         "unmatched parallelism, usability, and observability.")
INTRO_DELAY = 0.5

# Narration script, keyed by the title SVG's filename stem. The titles only mark
# WHEN to speak about a topic -- this is the actual voiceover (grounded in
# README.md, NOT the caption text). Each line is sized to fit the gap before the
# next caption at the current SPEED; the build prints any line that overruns so
# you can trim it. Edit freely.
NARRATION = {
    "TaskLauncher":       "Let's launch one of Shofer's multi-agent workflows.",
    "Feature":            "We'll implement a feature, with an architect, a developer, and a reviewer working as a team.",
    "Input":              "It begins by asking what we want built.",
    "StateDiagrams":      "As it runs, Shofer draws it live, a state diagram showing exactly where every agent is.",
    "TitleFileName (1)":  "Everything stays organized. You can manage entire trees of tasks and workflows from one place.",
    "Approve":            "Notice the architect pauses for you. Nothing gets implemented until you've reviewed the plan and approved it.",
    "TreeHierarchy":      "Once approved, the work fans out across a tree of tasks, each one tracked here.",
    "TaskChat":           "Open any task, and you can follow exactly what it did, every message, every tool call, every file.",
    "SequenceDiagram":    "You can also see how the agents talked to each other, laid out as a clean sequence diagram.",
    "InternalState":      "Or drill into an agent's internal state.",
    "DetailedStatistics": "And because nothing is hidden, you get detailed stats and logs: active time and cost across the whole run.",
    "PriceCaps":          "Speaking of cost, Shofer puts hard limits on it. Set a dollar cap per task or per session, and a runaway loop simply stops, no matter which provider you're using.",
    "SelfEvaluation":     "As things wrap up, each agent even evaluates its own performance, so you see how well it actually did, not just that it finished.",
    "done":               "And that's a complete workflow, from start to finish.",
}

# All clips in this project use gravity=CENTER (4) and scale=FIT (1); the title
# SVGs are full-frame (1920x1080) lower-third bars. If that ever changes in the
# OpenShot project, revisit the compositing below.


def run(cmd, input_text=None, **kw):
    print("+", " ".join(cmd[:6]), "..." if len(cmd) > 6 else "")
    r = subprocess.run(cmd, capture_output=True, text=True,
                       input=input_text, **kw)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2000:] + "\n")
        raise SystemExit(f"command failed (rc={r.returncode}): {cmd[0]}")
    return r


def need(tool):
    if not shutil.which(tool):
        raise SystemExit(f"required tool not found on PATH: {tool}")


def probe_duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path])
    return float(r.stdout.strip())


HELP = """\
build-demo-video.py - rebuild the Shofer demo video (edit + voiceover) from the
OpenShot project, in one step.

Usage:
  python3 scripts/build-demo-video.py [options]

What it does:
  Parses media/demo.osp, rasterizes the title SVGs, composites the screencast
  with its freezes + title bars, applies a global slowdown, synthesizes the
  narration, and writes website/public/demo.webm (VP9 video + Opus audio).

Options:
  --speed FLOAT    Base playback speed (default %(speed)s). <1 = slower,
                   >1 = faster. With adaptive pacing on, this is the speed for
                   normal/title regions. e.g. --speed 0.6
  --no-pace        Disable adaptive pacing; play everything at the base speed.
  --engine NAME    TTS engine: kokoro | piper | flite | auto (default %(engine)s).
                   auto = best available (kokoro -> piper -> flite). Use to A/B
                   compare voices, e.g. --engine piper
  --no-voice       Skip narration; produce a silent video.
  --keep-temp      Keep the temp build dir (prints its path) for debugging.
  -h, --help       Show this help and exit.

Adaptive pacing (on by default): busy spans slow to PACE_SLOW, quiet spans with
no title/narration speed up to PACE_FAST, titles are slowed/extended to stay
readable, and narration is never accelerated. Tune via PACE_* constants.

Edit in-file (top of script):
  NARRATION        The spoken script, one line per title (keyed by SVG name).
  SPEED            Default playback speed.
  KOKORO_VOICE     Voice id: af_heart, af_bella, am_michael, am_onyx, bm_george.
  KOKORO_SPEED     Speech rate (separate from video SPEED).

Environment overrides:
  SHOFER_TTS_HOME  TTS venv + models dir (default media/video/).
  TTS_ENGINE, KOKORO_VOICE, KOKORO_SPEED, KOKORO_PYTHON, KOKORO_MODEL,
  KOKORO_VOICES, PIPER_BIN, PIPER_VOICE  - per-setting overrides.

Requires: ffmpeg, ffprobe, inkscape; for voice: a Kokoro/Piper venv at
SHOFER_TTS_HOME (else it falls back to flite, offline but robotic).
""" % {"speed": SPEED, "engine": ENGINE}


def resolve(path, osp_dir, osp_stem):
    # OpenShot stores asset paths with an "@assets" placeholder that maps to
    # "<project-stem>_assets" next to the .osp file.
    if path.startswith("@assets"):
        path = osp_stem + "_assets" + path[len("@assets"):]
        return os.path.normpath(os.path.join(osp_dir, path))
    return os.path.normpath(os.path.join(osp_dir, path))


# Standalone Kokoro synth, run under the venv python (text arrives on stdin).
KOKORO_HELPER = r"""
import sys, soundfile as sf
from kokoro_onnx import Kokoro
model, voices, voice, speed, out = sys.argv[1:6]
text = sys.stdin.read().strip()
k = Kokoro(model, voices)
samples, sr = k.create(text, voice=voice, speed=float(speed), lang="en-us")
sf.write(out, samples, sr)
"""


def kokoro_available():
    return all(os.path.exists(p) for p in
               (KOKORO_PYTHON, KOKORO_MODEL, KOKORO_VOICES))


def piper_available():
    return os.path.exists(PIPER_VOICE) and (
        shutil.which(PIPER_BIN) or os.path.exists(PIPER_BIN))


def flite_available():
    try:
        import ctypes
        ctypes.CDLL("libflite.so.1")
        ctypes.CDLL("libflite_cmu_us_slt.so.1")
        return True
    except OSError:
        return False


def engine_available(eng):
    return {"kokoro": kokoro_available, "piper": piper_available,
            "flite": flite_available}.get(eng, lambda: False)()


def tts_engine():
    if ENGINE != "auto":
        return ENGINE
    if kokoro_available():
        return "kokoro"
    if piper_available():
        return "piper"
    return "flite"


def svg_text(path):
    """Plain caption text inside a title SVG (for word-count readability)."""
    try:
        xml = open(path, encoding="utf-8").read()
    except OSError:
        return ""
    parts = (re.findall(r"<tspan[^>]*>(.*?)</tspan>", xml, re.S)
             or re.findall(r"<text[^>]*>(.*?)</text>", xml, re.S))
    txt = " ".join(re.sub(r"<[^>]+>", "", p) for p in parts)
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">")):
        txt = txt.replace(a, b)
    return re.sub(r"\s+", " ", txt).strip()


def measure_motion(path, bucket):
    """Mean frame-to-frame luma change per `bucket` seconds (a motion proxy)."""
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path, "-vf",
         "format=gray,tblend=all_mode=difference,signalstats,"
         "metadata=print:key=lavfi.signalstats.YAVG", "-an", "-f", "null", "-"],
        capture_output=True, text=True)
    cur, buckets = None, {}
    for line in r.stderr.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            cur = float(m.group(1))
        m = re.search(r"YAVG=([\d.]+)", line)
        if m and cur is not None:
            buckets.setdefault(int(cur / bucket), []).append(float(m.group(1)))
    return {b: sum(v) / len(v) for b, v in buckets.items()}


def build_speed_map(total, titles, motion, narr_cover):
    """Per-region speed (original timeline). Rules: high motion -> slow; title
    on screen -> its readability speed; quiet + no title + no narration -> fast;
    otherwise base SPEED. Returns merged [(start, end, speed), ...]."""
    peak = max(motion.values()) if motion else 1.0
    hi, lo = PACE_MOTION_HI * peak, PACE_MOTION_LO * peak
    nb = max(1, int(math.ceil(total / PACE_BUCKET)))
    sp = []
    for b in range(nb):
        mid = b * PACE_BUCKET + PACE_BUCKET / 2
        mv = motion.get(b, 0.0)
        act = [t for t in titles if t["pos"] <= mid < t["pos"] + t["dur"]]
        narr = any(s <= mid < e for s, e in narr_cover)
        if act:
            f = min(t["f"] for t in act)
            if mv >= hi:
                f = min(f, PACE_SLOW)
        elif mv >= hi:
            f = PACE_SLOW
        elif narr:
            f = SPEED
        elif mv <= lo:
            f = PACE_FAST
        else:
            f = SPEED
        sp.append(f)
    segs, i = [], 0
    while i < nb:
        j = i
        while j < nb and sp[j] == sp[i]:
            j += 1
        segs.append((round(i * PACE_BUCKET, 3),
                     round(min(j * PACE_BUCKET, total), 3), sp[i]))
        i = j
    return segs


def warp_time(segs, t):
    """Map an original-timeline time to final time through the speed map."""
    ft = 0.0
    for s, e, f in segs:
        if t <= s:
            break
        ft += (min(t, e) - s) / f
    return ft


def synth_line(text, out_wav, _helper=[None]):
    """Synthesize one narration line to a WAV (engine per tts_engine())."""
    eng = tts_engine()
    if eng == "kokoro":
        if _helper[0] is None:                       # write helper once
            _helper[0] = out_wav + ".kokoro_helper.py"
            with open(_helper[0], "w") as fh:
                fh.write(KOKORO_HELPER)
        # espeak-ng phonemizer lib (no CLI on this box, but the .so is present)
        env = dict(os.environ)
        env.setdefault("PHONEMIZER_ESPEAK_LIBRARY", "libespeak-ng.so.1")
        run([KOKORO_PYTHON, _helper[0], KOKORO_MODEL, KOKORO_VOICES,
             KOKORO_VOICE, str(KOKORO_SPEED), out_wav], input_text=text, env=env)
        return
    if eng == "piper":
        run([PIPER_BIN, "-m", PIPER_VOICE, "-f", out_wav], input_text=text)
        return
    # fallback: libflite via ctypes (offline, lower quality)
    import ctypes
    flite = ctypes.CDLL("libflite.so.1")
    slt = ctypes.CDLL("libflite_cmu_us_slt.so.1")
    flite.flite_init()
    slt.register_cmu_us_slt.restype = ctypes.c_void_p
    slt.register_cmu_us_slt.argtypes = [ctypes.c_char_p]
    voice = slt.register_cmu_us_slt(None)
    flite.flite_text_to_speech.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                                           ctypes.c_char_p]
    flite.flite_text_to_speech.restype = ctypes.c_float
    flite.flite_text_to_speech(text.encode(), voice, out_wav.encode())


def main():
    global SPEED, NARRATE, ENGINE, PACE_ADAPTIVE
    if "-h" in sys.argv or "--help" in sys.argv:
        print(HELP)
        return
    keep_temp = "--keep-temp" in sys.argv
    if "--no-pace" in sys.argv:
        PACE_ADAPTIVE = False
    if "--no-voice" in sys.argv:
        NARRATE = False
    if "--speed" in sys.argv:
        SPEED = float(sys.argv[sys.argv.index("--speed") + 1])
    if "--engine" in sys.argv:
        ENGINE = sys.argv[sys.argv.index("--engine") + 1]
    # ---- preflight: fail fast, before any expensive work --------------------
    for t in ("ffmpeg", "ffprobe", "inkscape"):
        need(t)
    if not os.path.isfile(OSP):
        raise SystemExit(f"project file not found: {OSP}")
    if NARRATE:
        eng = tts_engine()
        if ENGINE != "auto" and not engine_available(eng):
            raise SystemExit(
                f"--engine {eng} requested but not usable. Check SHOFER_TTS_HOME"
                f" ({TTS_HOME}) and its model files, or run --no-voice.")
        if not engine_available(eng):
            raise SystemExit(
                "no TTS engine available (kokoro/piper/flite all missing). "
                "Set up SHOFER_TTS_HOME (see --help) or run --no-voice.")
        print(f"voiceover engine: {eng}")
        if eng == "flite":
            print("  note: flite is the robotic fallback; install Kokoro or "
                  "Piper under SHOFER_TTS_HOME for a natural voice.")

    with open(OSP) as f:
        proj = json.load(f)

    W = proj.get("width", 1280)
    H = proj.get("height", 720)
    fps_d = proj.get("fps", {"num": 30, "den": 1})
    FPS = fps_d["num"] / fps_d["den"]
    osp_dir = os.path.dirname(OSP)
    osp_stem = os.path.splitext(os.path.basename(OSP))[0]

    video_clips, image_clips = [], []
    for c in proj.get("clips", []):
        path = resolve(c["reader"]["path"], osp_dir, osp_stem)
        item = {
            "path": path,
            "pos": float(c["position"]),
            "start": float(c["start"]),
            "end": float(c["end"]),
        }
        ext = os.path.splitext(path)[1].lower()
        if ext == ".svg":
            image_clips.append(item)
        else:
            # OpenShot time-remap: keyframes map timeline frame (X, 1-based) to
            # source frame (Y, 1-based). Flat segments are freeze-frames.
            tprop = c.get("time") or {}
            pts = sorted(((p["co"]["X"], p["co"]["Y"]) for p in tprop.get("Points", [])),
                         key=lambda xy: xy[0])
            item["time"] = pts          # [] -> straight playback
            video_clips.append(item)
    video_clips.sort(key=lambda x: x["pos"])
    image_clips.sort(key=lambda x: x["pos"])

    if not video_clips:
        raise SystemExit("no video clips found in project")

    src = video_clips[0]["path"]
    if not os.path.exists(src):
        raise SystemExit(f"source video missing: {src}")
    src_dur = probe_duration(src)
    print(f"source: {src} ({src_dur:.3f}s)  canvas {W}x{H}@{FPS:g}")

    tmp = tempfile.mkdtemp(prefix="shofer-demo-")
    png_dir = os.path.join(tmp, "png")
    os.makedirs(png_dir)

    # 1) rasterize title SVGs --------------------------------------------------
    png_for = {}
    for i, clip in enumerate(image_clips):
        if not os.path.exists(clip["path"]):
            raise SystemExit(f"overlay SVG missing: {clip['path']}")
        out_png = os.path.join(png_dir, f"ov{i}.png")
        run(["inkscape", clip["path"], "--export-type=png",
             f"--export-filename={out_png}", "-w", str(W), "-h", str(H)])
        png_for[i] = out_png

    # 2) build the screencast track ------------------------------------------
    # Per clip: rebuild the time-remapped source from its `time` curve, take the
    # visible [start, end] window, then pillarbox onto a black WxH canvas.
    pad = f"scale=-2:{H},pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
    fc = []          # filter_complex statements
    parts = []       # labels to concat, in timeline order
    cursor = 0.0
    seg_id = 0       # unique label counter for remap sub-segments
    src_uses = []    # each entry is one independent copy of [0:v] we consume

    def src_copy():
        # ffmpeg needs a `split` to use the source on multiple filter chains;
        # hand out a fresh copy label each call, wire up split() at the end.
        lbl = f"src{len(src_uses)}"
        src_uses.append(lbl)
        return f"[{lbl}]"

    def black(dur, label):
        fc.append(f"color=c=black:s={W}x{H}:r={FPS:g}:d={dur:.4f}[{label}]")

    def remap_stream(points, label):
        # Emit the time-remapped source as a concat of play/freeze segments.
        nonlocal seg_id
        if len(points) < 2:                      # no curve -> source as-is
            fc.append(f"{src_copy()}fps={FPS:g}[{label}]")
            return
        subs = []
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            out_f = int(round(x1 - x0))          # output frames in this segment
            if out_f <= 0:
                continue
            lbl = f"s{seg_id}"; seg_id += 1
            f0 = max(int(round(y0)) - 1, 0)      # source frame (0-based)
            if abs(y1 - y0) < 1e-6:              # freeze: hold one source frame
                fc.append(
                    f"{src_copy()}trim=start_frame={f0}:end_frame={f0+1},"
                    f"setpts=PTS-STARTPTS,tpad=stop_mode=clone:"
                    f"stop_duration={out_f / FPS:.4f},fps={FPS:g},"
                    f"trim=end_frame={out_f},setpts=PTS-STARTPTS[{lbl}]")
            else:                                # play (speed = src/out frames)
                f1 = max(int(round(y1)) - 1, f0 + 1)
                speed = (f1 - f0) / out_f
                fc.append(
                    f"{src_copy()}trim=start_frame={f0}:end_frame={f1},"
                    f"setpts=(PTS-STARTPTS)/{speed:.6f},fps={FPS:g},"
                    f"trim=end_frame={out_f},setpts=PTS-STARTPTS[{lbl}]")
            subs.append(lbl)
        fc.append("".join(f"[{s}]" for s in subs) +
                  f"concat=n={len(subs)}:v=1:a=0[{label}]")

    for n, clip in enumerate(video_clips):
        gap = clip["pos"] - cursor
        if gap > 0.01:
            lbl = f"g{n}"
            black(gap, lbl)
            parts.append(lbl)
        remap_stream(clip["time"], f"rm{n}")     # full time-remapped source
        seg = f"v{n}"
        fc.append(f"[rm{n}]trim={clip['start']}:{clip['end']},"
                  f"setpts=PTS-STARTPTS,{pad}[{seg}]")
        parts.append(seg)
        cursor = clip["pos"] + (clip["end"] - clip["start"])

    fc.append("".join(f"[{p}]" for p in parts) +
              f"concat=n={len(parts)}:v=1:a=0[trk]")

    # fan the source out to every chain that consumed a copy
    fc.insert(0, f"[0:v]split={len(src_uses)}" +
              "".join(f"[{l}]" for l in src_uses))

    total_orig = cursor

    # title readability: how long each title needs to be on screen, and whether
    # to extend its graphic into available slack / slow its region to get there.
    order = sorted(range(len(image_clips)), key=lambda i: image_clips[i]["pos"])
    tmeta = {}                       # clip index -> (display_dur_orig, speed)
    for n, i in enumerate(order):
        c = image_clips[i]
        pos, own = c["pos"], c["end"] - c["start"]
        nxt = (image_clips[order[n + 1]]["pos"]
               if n + 1 < len(order) else total_orig)
        gap = nxt - pos
        read_s = len(svg_text(c["path"]).split()) / PACE_READ_WPS + PACE_READ_BASE
        if PACE_ADAPTIVE:
            disp = min(max(own, read_s * SPEED), gap)        # extend into slack
            f = SPEED if disp / SPEED >= read_s - 1e-3 else \
                max(disp / read_s, PACE_SLOW)                # else slow region
        else:
            disp, f = own, SPEED
        tmeta[i] = (disp, f)

    # 3) overlay the title bars (with extended display windows) ----------------
    cur = "trk"
    for i, clip in enumerate(image_clips):
        disp = tmeta[i][0]
        s, e = clip["pos"], clip["pos"] + disp
        nxt = f"o{i}"
        fc.append(f"[{cur}][{i+1}:v]overlay=0:0:"
                  f"enable='between(t,{s:.3f},{e:.3f})'[{nxt}]")
        cur = nxt

    # render the composite at ORIGINAL timing; pacing is applied as a 2nd pass
    fc.append(f"[{cur}]trim=0:{total_orig:.3f},setpts=PTS-STARTPTS[vout]")
    inputs = ["-i", src]
    for i in range(len(image_clips)):
        inputs += ["-i", png_for[i]]
    master_orig = os.path.join(tmp, "master_orig.mp4")
    run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(fc),
         "-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-r", str(int(FPS)), "-movflags", "+faststart",
         master_orig])

    # synthesize narration up front -- its durations drive pacing + sync
    voice = []
    if NARRATE:
        print(f"narration: synthesizing with {tts_engine()}")
        items = [(-1.0, "intro", INTRO)] if INTRO else []
        for clip in image_clips:
            stem = os.path.splitext(os.path.basename(clip["path"]))[0]
            if NARRATION.get(stem):
                items.append((clip["pos"], stem, NARRATION[stem]))
        items.sort(key=lambda x: x[0])
        for k, (pos, label, text) in enumerate(items):
            wav = os.path.join(tmp, f"vo{k}.wav")
            synth_line(text, wav)
            voice.append({"pos": pos, "label": label, "wav": wav,
                          "dur": probe_duration(wav)})

    # compute the speed map (original timeline)
    if PACE_ADAPTIVE:
        motion = measure_motion(master_orig, PACE_BUCKET)
        titles = [{"pos": image_clips[i]["pos"], "dur": tmeta[i][0],
                   "f": tmeta[i][1]} for i in range(len(image_clips))]
        narr_cover = [
            (0.0, (INTRO_DELAY + v["dur"]) * SPEED) if v["pos"] < 0
            else (v["pos"], v["pos"] + v["dur"] * SPEED) for v in voice]
        segs = build_speed_map(total_orig, titles, motion, narr_cover)
    else:
        segs = [(0.0, total_orig, SPEED)]

    # apply the speed map: retime master_orig -> master
    fcr = ["[0:v]split=%d%s" % (len(segs),
           "".join(f"[p{i}]" for i in range(len(segs))))]
    for i, (s, e, f) in enumerate(segs):
        fcr.append(f"[p{i}]trim={s:.3f}:{e:.3f},setpts=(PTS-STARTPTS)/{f:.4f},"
                   f"fps={FPS:g}[q{i}]")
    fcr.append("".join(f"[q{i}]" for i in range(len(segs)))
               + f"concat=n={len(segs)}:v=1:a=0[vout]")
    master = os.path.join(tmp, "master.mp4")
    run(["ffmpeg", "-y", "-i", master_orig, "-filter_complex", ";".join(fcr),
         "-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-r", str(int(FPS)), "-movflags", "+faststart",
         master])
    total = warp_time(segs, total_orig)
    if PACE_ADAPTIVE:
        slow = sum(e - s for s, e, f in segs if f < SPEED - 1e-6)
        fast = sum(e - s for s, e, f in segs if f > SPEED + 1e-6)
        print(f"pacing: {len(segs)} segments, {slow:.0f}s slowed / {fast:.0f}s "
              f"accelerated -> final {total:.1f}s")

    # 4) encode VP9 webm (2-pass) ---------------------------------------------
    log = os.path.join(tmp, "vp9pass")
    common = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32",
              "-row-mt", "1", "-an", "-passlogfile", log]
    run(["ffmpeg", "-y", "-i", master, *common, "-pass", "1",
         "-f", "null", os.devnull])
    webm = os.path.join(tmp, "demo.webm")
    run(["ffmpeg", "-y", "-i", master, *common, "-pass", "2", webm])

    # 5) mux narration at warped (synced) times -------------------------------
    if NARRATE and voice:
        placed = sorted(
            [(INTRO_DELAY if v["pos"] < 0 else warp_time(segs, v["pos"]), v)
             for v in voice], key=lambda x: x[0])
        ain, afc, amix = [], [], []
        for k, (start, v) in enumerate(placed):
            nxt = placed[k + 1][0] if k + 1 < len(placed) else 1e9
            window = nxt - start
            flag = (f"  !! OVERRUNS by {v['dur'] - window:.1f}s"
                    if v["dur"] > window else "")
            print(f"   {v['label']:20} {v['dur']:4.1f}s / {window:4.1f}s{flag}")
            delay_ms = int(round(start * 1000))
            ain += ["-i", v["wav"]]
            afc.append(f"[{k+1}:a]adelay={delay_ms}|{delay_ms}[d{k}]")
            amix.append(f"[d{k}]")
        afc.append("".join(amix) +
                   f"amix=inputs={len(placed)}:normalize=0:dropout_transition=0,"
                   f"alimiter=limit=0.95[aout]")
        run(["ffmpeg", "-y", "-i", webm, *ain,
             "-filter_complex", ";".join(afc),
             "-map", "0:v", "-map", "[aout]",
             "-c:v", "copy", "-c:a", "libopus", "-b:a", "96k", OUT])
    else:
        shutil.copyfile(webm, OUT)

    size = os.path.getsize(OUT)
    print(f"\nwrote {OUT} ({size/1e6:.2f} MB, {total:.1f}s)")

    if keep_temp:
        print(f"temp kept: {tmp}")
    else:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
