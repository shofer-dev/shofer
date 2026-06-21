#!/usr/bin/env python3
"""
build-video.py - assemble a narrated, paced video from clips + a config file.

A generic successor to build-demo-video.py. Everything is driven by one YAML or
JSON config: the clips and their order, the on-screen titles and spoken
narration (from per-clip descriptions), transitions between clips, image/SVG
overlays, effects, adaptive pacing, the TTS voice, and encode settings.

Pipeline:
  1. Normalize each clip to the canvas (scale-to-fit + pillarbox), bake in its
     generated title bar and any overlays/effects, at the clip's base speed.
  2. Assemble clips in order, joined by transitions (xfade) or hard cuts.
  3. Optionally apply adaptive pacing (slow busy spans, speed up quiet+untitled
     spans; never accelerate under narration).
  4. Synthesize narration (Kokoro -> Piper -> flite) and mux it at each clip's
     title time, mapped through the pacing warp so it stays in sync.
  5. Encode VP9 + Opus to the configured output.

Usage:
  python3 scripts/build-video.py CONFIG.yaml [--no-voice] [--no-pace] [--keep-temp]
  python3 scripts/build-video.py --help

See video.example.yaml for a fully documented config.
Requires: ffmpeg, ffprobe, inkscape; PyYAML (for .yaml); a TTS env for voice.
"""
import copy
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

# ---- defaults: every knob lives here and can be overridden in the config ------
DEFAULTS = {
    "output": "out.webm",
    "canvas": {"width": 1280, "height": 720, "fps": 30},
    "background": "black",            # pillarbox / letterbox color
    "fit": "contain",                 # contain (pillarbox) | cover (crop) | stretch
    "speed": 1.0,                     # base speed for clips (1.0 = original)
    "clips_dir": "",                  # base dir prepended to each clip "file"
    "pacing": {
        "enabled": True,
        "slow": 0.7,                  # speed in high-motion spans
        "fast": 1.6,                  # speed in quiet, untitled, silent spans
        "motion_hi": 0.45,            # >= frac of peak motion -> slow
        "motion_lo": 0.06,            # <= frac of peak motion -> accelerate
        "bucket": 0.5,                # analysis granularity (s)
    },
    "title": {
        "enabled": True,
        "seconds": None,              # fixed on-screen time; None = reading-time
        "read_wps": 2.5,              # reading speed (words/sec)
        "read_base": 1.0,             # +seconds for the eye to land
        "at": 0.0,                    # when the title appears (s into the clip)
        "bar_frac": 0.20,             # bar height as fraction of canvas height
        "bar_color": "#000000",
        "bar_opacity": 0.78,
        "text_color": "#f2c14e",
        "font": "DejaVu Sans",
        "max_font_frac": 0.045,       # max font size as fraction of canvas height
        "margin_frac": 0.04,          # side margin as fraction of canvas width
    },
    "transition": {"type": "fade", "duration": 0.6},   # default between clips
    "intro": {"narration": "", "delay": 0.5},
    "music": {                        # background music bed (file "" = none)
        "file": "",
        "volume": 0.25,               # gain relative to the source track
        "fade_in": 1.0,
        "fade_out": 2.0,
        "duck": True,                 # lower music while narration plays
        "duck_amount": 0.35,          # music gain under narration (duck=true)
    },
    "voice": {
        "enabled": True,
        "engine": "auto",             # kokoro | piper | flite | auto
        "tts_home": os.path.join(ROOT, "media", "video"),
        "kokoro_voice": "af_heart",
        "kokoro_speed": 1.0,
        "narration_gap": 0.0,         # extra s before a line's window check
    },
    "audio": {
        "loudnorm": False,            # True or {I,TP,LRA} -> EBU R128 normalize
    },
    "encode": {
        "vp9_crf": 32,                # CRF for the default VP9 path
        "audio_kbps": 96,
        "vcodec": "libvpx-vp9",       # libvpx-vp9 | libx264 | libx265 | prores_ks
        "acodec": "auto",             # auto -> opus(.webm) / aac(.mp4,.mov)
        "crf": None,                  # None -> vp9_crf for VP9, else 18
        "preset": "medium",           # x264/x265 preset
        "pix_fmt": "yuv420p",
        "prores_profile": 3,          # prores_ks: 0..5 (3 = HQ)
    },
    "clips": [],                      # list of clip dicts (see example)
}


# ============================ small utilities =================================
def run(cmd, input_text=None, **kw):
    print("+", " ".join(str(c) for c in cmd[:6]), "..." if len(cmd) > 6 else "")
    r = subprocess.run(cmd, capture_output=True, text=True, input=input_text, **kw)
    if r.returncode != 0:
        sys.stderr.write((r.stderr or "")[-2000:] + "\n")
        raise SystemExit(f"command failed (rc={r.returncode}): {cmd[0]}")
    return r


def need(tool):
    if not shutil.which(tool):
        raise SystemExit(f"required tool not found on PATH: {tool}")


def filter_available(name, _cache={}):
    """True if ffmpeg was built with the given filter (cached)."""
    if not _cache:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                            capture_output=True, text=True)
        for line in r.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                _cache[parts[1]] = True
    return name in _cache


def deep_merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_config(path):
    with open(path) as f:
        if path.lower().endswith((".yaml", ".yml")):
            import yaml
            data = yaml.safe_load(f)
        else:
            data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit("config must be a mapping at the top level")
    return deep_merge(DEFAULTS, data)


def probe_duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path])
    return float(r.stdout.strip())


def xml_escape(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


# ============================ text-to-speech =================================
KOKORO_HELPER = r"""
import sys, soundfile as sf
from kokoro_onnx import Kokoro
model, voices, voice, speed, out = sys.argv[1:6]
text = sys.stdin.read().strip()
k = Kokoro(model, voices)
samples, sr = k.create(text, voice=voice, speed=float(speed), lang="en-us")
sf.write(out, samples, sr)
"""


def voice_paths(V):
    home = V["tts_home"]
    return {
        "py": os.path.join(home, "bin", "python"),
        "model": os.path.join(home, "kokoro", "kokoro-v1.0.onnx"),
        "voices": os.path.join(home, "kokoro", "voices-v1.0.bin"),
        "piper": os.path.join(home, "bin", "piper"),
        "piper_voice": os.path.join(home, "voices", "en_US-lessac-medium.onnx"),
    }


def kokoro_available(V):
    p = voice_paths(V)
    return all(os.path.exists(p[k]) for k in ("py", "model", "voices"))


def piper_available(V):
    p = voice_paths(V)
    return os.path.exists(p["piper_voice"]) and os.path.exists(p["piper"])


def flite_available(_V=None):
    try:
        import ctypes
        ctypes.CDLL("libflite.so.1")
        ctypes.CDLL("libflite_cmu_us_slt.so.1")
        return True
    except OSError:
        return False


def tts_engine(V):
    if V["engine"] != "auto":
        return V["engine"]
    if kokoro_available(V):
        return "kokoro"
    if piper_available(V):
        return "piper"
    return "flite"


def engine_available(V, eng):
    return {"kokoro": kokoro_available, "piper": piper_available,
            "flite": flite_available}.get(eng, lambda _: False)(V)


def synth_line(V, text, out_wav, _helper=[None]):
    eng = tts_engine(V)
    p = voice_paths(V)
    if eng == "kokoro":
        if _helper[0] is None:
            _helper[0] = out_wav + ".kokoro_helper.py"
            with open(_helper[0], "w") as fh:
                fh.write(KOKORO_HELPER)
        env = dict(os.environ)
        env.setdefault("PHONEMIZER_ESPEAK_LIBRARY", "libespeak-ng.so.1")
        run([p["py"], _helper[0], p["model"], p["voices"], V["kokoro_voice"],
             str(V["kokoro_speed"]), out_wav], input_text=text, env=env)
        return
    if eng == "piper":
        run([p["piper"], "-m", p["piper_voice"], "-f", out_wav], input_text=text)
        return
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


# ============================ titles (generated) =============================
def title_svg(text, W, H, t):
    """Generate a lower-third title-bar SVG (gradient bar + centered text)."""
    bar_h = int(H * t["bar_frac"])
    margin = int(W * t["margin_frac"])
    avail = W - 2 * margin
    max_fs = H * t["max_font_frac"]
    # shrink-to-fit: rough advance width ~0.55*fontsize per glyph for DejaVu
    fs = min(max_fs, avail / max(1, 0.55 * len(text)))
    fs = max(fs, max_fs * 0.45)        # don't go absurdly small
    baseline = H - bar_h / 2 + fs * 0.35
    op = t["bar_opacity"]
    return f"""<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">
  <defs>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{t['bar_color']}" stop-opacity="0"/>
      <stop offset="0.4" stop-color="{t['bar_color']}" stop-opacity="{op*0.55:.3f}"/>
      <stop offset="1" stop-color="{t['bar_color']}" stop-opacity="{op:.3f}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="{H-bar_h}" width="{W}" height="{bar_h}" fill="url(#bar)"/>
  <text x="{W/2:.0f}" y="{baseline:.0f}" text-anchor="middle"
        font-family="{t['font']}" font-weight="bold" font-size="{fs:.1f}"
        fill="{t['text_color']}">{xml_escape(text)}</text>
</svg>"""


def rasterize_svg(svg_path, png_path, W, H):
    run(["inkscape", svg_path, "--export-type=png",
         f"--export-filename={png_path}", "-w", str(W), "-h", str(H)])


# ============================ adaptive pacing ================================
def measure_motion(path, bucket):
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


def build_speed_map(total, base, P, titles, motion, narr_cover):
    """Per-region speed (original timeline). titles/narr_cover: [(start,end)]."""
    peak = max(motion.values()) if motion else 1.0
    hi, lo = P["motion_hi"] * peak, P["motion_lo"] * peak
    bucket = P["bucket"]
    nb = max(1, int(math.ceil(total / bucket)))
    sp = []
    for b in range(nb):
        mid = b * bucket + bucket / 2
        mv = motion.get(b, 0.0)
        titled = any(s <= mid < e for s, e in titles)
        narr = any(s <= mid < e for s, e in narr_cover)
        if mv >= hi:
            f = P["slow"]
        elif titled or narr:
            f = base
        elif mv <= lo:
            f = P["fast"]
        else:
            f = base
        sp.append(f)
    segs, i = [], 0
    while i < nb:
        j = i
        while j < nb and sp[j] == sp[i]:
            j += 1
        segs.append((round(i * bucket, 3), round(min(j * bucket, total), 3), sp[i]))
        i = j
    return segs


def warp_time(segs, t):
    ft = 0.0
    for s, e, f in segs:
        if t <= s:
            break
        ft += (min(t, e) - s) / f
    return ft


# ============================ clip normalization =============================
def normalize_clip(clip, idx, C, tmp):
    """Render one clip to canvas size with its title + overlays baked in.
    Returns (path, duration, title_window_or_None)."""
    W = C["canvas"]["width"]
    H = C["canvas"]["height"]
    FPS = C["canvas"]["fps"]
    bg = C["background"]
    base_speed = clip.get("speed", C["speed"])

    src = clip["file"]
    if C["clips_dir"]:
        src = os.path.join(C["clips_dir"], src)
    if not os.path.isabs(src):
        src = os.path.join(os.path.dirname(os.path.abspath(C["__path__"])), src)
    if not os.path.isfile(src):
        raise SystemExit(f"clip {idx} file not found: {src}")

    # stabilize: vidstab two-pass prepass on the source (before trim/scale)
    if any(e.get("type") == "stabilize" for e in clip.get("effects", [])):
        if not filter_available("vidstabdetect"):
            print("  warning: vidstab not in this ffmpeg build, skipping stabilize")
        else:
            sm = next(e.get("smoothing", 15) for e in clip["effects"]
                      if e.get("type") == "stabilize")
            trf = os.path.join(tmp, f"vid{idx}.trf")
            even = "scale=trunc(iw/2)*2:trunc(ih/2)*2"   # vidstab needs even dims
            run(["ffmpeg", "-y", "-i", src, "-vf",
                 f"{even},vidstabdetect=result={trf}", "-f", "null", os.devnull])
            stab = os.path.join(tmp, f"stab{idx}.mp4")
            run(["ffmpeg", "-y", "-i", src, "-vf",
                 f"{even},vidstabtransform=input={trf}:smoothing={sm},"
                 "unsharp=5:5:0.8", "-c:v", "libx264", "-preset", "medium",
                 "-crf", "18", stab])
            src = stab

    base_dir = os.path.dirname(os.path.abspath(C["__path__"]))
    inputs, fc = ["-i", src], []
    v = "[0:v]"
    trim = clip.get("trim")
    if trim:
        fc.append(f"{v}trim={trim[0]}:{trim[1]},setpts=PTS-STARTPTS[t]")
        v = "[t]"
    chain = f"{v}fps={FPS}"
    crop = clip.get("crop")                          # crop a source sub-rectangle
    if crop:
        chain += (f",crop={crop['w']}:{crop['h']}:"
                  f"{crop.get('x', 0)}:{crop.get('y', 0)}")
    fit = clip.get("fit", C["fit"])                  # how to fit onto the canvas
    if fit == "cover":                               # fill + crop overflow
        chain += (f",scale={W}:{H}:force_original_aspect_ratio=increase,"
                  f"crop={W}:{H},setsar=1")
    elif fit == "stretch":                           # ignore aspect ratio
        chain += f",scale={W}:{H},setsar=1"
    else:                                            # contain: pillarbox/letterbox
        chain += (f",scale={W}:{H}:force_original_aspect_ratio=decrease,"
                  f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:{bg},setsar=1")
    if abs(base_speed - 1.0) > 1e-6:
        chain += f",setpts=(PTS-STARTPTS)/{base_speed}"
    if clip.get("reverse"):                          # play the clip backwards
        chain += ",reverse"
    fr = clip.get("freeze") or {}                    # hold first/last frame
    fstart, fstop = float(fr.get("start", 0) or 0), float(fr.get("end", 0) or 0)
    if fstart or fstop:
        tp = []
        if fstart:
            tp.append(f"start_duration={fstart}:start_mode=clone")
        if fstop:
            tp.append(f"stop_duration={fstop}:stop_mode=clone")
        chain += ",tpad=" + ":".join(tp)
    # per-clip effects
    fdur, src_dur, glow_cfg = None, None, None
    for eff in clip.get("effects", []):
        et = eff.get("type")
        if et == "fadein":
            chain += f",fade=t=in:st=0:d={eff.get('duration', 0.5)}"
        elif et == "fadeout":
            fdur = eff.get("duration", 0.5)        # applied once we know duration
        elif et == "eq":                            # colour adjust
            parts = [f"{k}={eff[k]}" for k in
                     ("brightness", "contrast", "saturation", "gamma") if k in eff]
            if parts:
                chain += ",eq=" + ":".join(parts)
        elif et == "blur":
            chain += f",gblur=sigma={eff.get('sigma', 8)}"
        elif et == "sharpen":
            chain += f",unsharp=5:5:{eff.get('amount', 1.0)}:5:5:0.0"
        elif et == "denoise":
            chain += ",hqdn3d"
        elif et == "hue":
            chain += f",hue=h={eff.get('h', 0)}:s={eff.get('s', 1.0)}"
        elif et == "negate":
            chain += ",negate"
        elif et == "grayscale":
            chain += ",hue=s=0"
        elif et == "sepia":
            chain += (",colorchannelmixer=.393:.769:.189:0:.349:.686:"
                      ".168:0:.272:.534:.131")
        elif et == "vignette":
            chain += ",vignette" + (f"=a={eff['angle']}" if "angle" in eff else "")
        elif et == "deinterlace":
            chain += ",yadif"
        elif et == "pixelate":
            n = eff.get("size", 16)
            chain += (f",scale=iw/{n}:ih/{n}:flags=neighbor,"
                      f"scale={W}:{H}:flags=neighbor")
        elif et == "lut":                           # 3D LUT (.cube)
            lf = eff["file"]
            if not os.path.isabs(lf):
                lf = os.path.join(C["clips_dir"] or base_dir, lf)
            chain += f",lut3d=file='{lf}'"
        elif et == "posterize":
            lv = max(2, eff.get("levels", 6))
            step = max(1, int(256 / lv))
            chain += f",lutyuv=y=round(val/{step})*{step}"
        elif et == "sketch":
            chain += ",edgedetect=mode=colormix:high=0.2"
        elif et == "oldfilm":
            chain += (",curves=preset=vintage,"
                      f"noise=alls={eff.get('grain', 18)}:allf=t")
        elif et == "curves":                        # tone curve preset
            chain += f",curves=preset={eff.get('preset', 'none')}"
        elif et == "levels":                        # per-channel in/out levels
            keys = ("rimin", "rimax", "gimin", "gimax", "bimin", "bimax",
                    "romin", "romax", "gomin", "gomax", "bomin", "bomax")
            parts = [f"{k}={eff[k]}" for k in keys if k in eff]
            if parts:
                chain += ",colorlevels=" + ":".join(parts)
        elif et == "colorbalance":                  # 3-way (shadows/mids/highs)
            sh = eff.get("shadows", [0, 0, 0])
            mi = eff.get("mids", [0, 0, 0])
            hi = eff.get("highs", [0, 0, 0])
            chain += (f",colorbalance=rs={sh[0]}:gs={sh[1]}:bs={sh[2]}:"
                      f"rm={mi[0]}:gm={mi[1]}:bm={mi[2]}:"
                      f"rh={hi[0]}:gh={hi[1]}:bh={hi[2]}")
        elif et == "white_balance":
            chain += f",colortemperature=temperature={eff.get('temperature', 6500)}"
        elif et == "stabilize":                     # handled as a 2-pass prepass
            pass
        elif et == "glow":                          # bloom: blur + screen-blend
            glow_cfg = eff                           # applied after the chain
        elif et == "zoom":                          # ken burns
            if src_dur is None:
                src_dur = probe_duration(src)
            clen = ((trim[1] - trim[0]) if trim else src_dur) / base_speed
            clen += fstart + fstop
            frames = max(1, int(round(clen * FPS)))
            z0, z1 = eff.get("from", 1.0), eff.get("to", 1.1)
            chain += (f",zoompan=z='{z0}+({z1}-{z0})*on/{frames}':d=1:"
                      f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                      f"s={W}x{H}:fps={FPS}")
    if glow_cfg is not None:                         # split -> blur copy -> screen
        sig = glow_cfg.get("sigma", 12)
        fc.append(chain + "[pre]")
        fc.append(f"[pre]split[g0][g1];[g1]gblur=sigma={sig}[gb];"
                  f"[g0][gb]blend=all_mode=screen[base]")
    else:
        fc.append(chain + "[base]")
    cur = "[base]"
    n_in = 1

    # title (generated from text)
    title_text = clip.get("title")
    if title_text is None and clip.get("description"):
        title_text = derive_title(clip["description"])
    twin = None
    if C["title"]["enabled"] and title_text:
        words = len(title_text.split())
        secs = C["title"]["seconds"] or (
            words / C["title"]["read_wps"] + C["title"]["read_base"])
        at = clip.get("title_at", C["title"]["at"]) + fstart
        svg = os.path.join(tmp, f"title{idx}.svg")
        png = os.path.join(tmp, f"title{idx}.png")
        open(svg, "w").write(title_svg(title_text, W, H, C["title"]))
        rasterize_svg(svg, png, W, H)
        inputs += ["-i", png]
        fc.append(f"{cur}[{n_in}:v]overlay=0:0:"
                  f"enable='between(t,{at:.3f},{at+secs:.3f})'[tt]")
        cur = "[tt]"
        twin = (at, secs)
        n_in += 1

    # image/svg overlays (optional alpha fade in/out)
    for j, ov in enumerate(clip.get("overlays", [])):
        img = ov["image"]
        if not os.path.isabs(img):
            img = os.path.join(C["clips_dir"] or base_dir, img)
        ow = int(W * ov.get("scale", 0.25))
        s, e = ov.get("start", 0.0), ov.get("end", 1e9)
        fade = ov.get("fade", 0.0)
        faded = fade > 0 and e < 1e8                  # fade needs a finite window
        need_scale = True
        if img.lower().endswith(".svg"):              # rasterize at target width
            opng = os.path.join(tmp, f"ov{idx}_{j}.png")
            run(["inkscape", img, "--export-type=png",
                 f"--export-filename={opng}", "-w", str(ow)])
            img, need_scale = opng, False
        # fading needs real frames over time -> loop the still for the window
        inputs += (["-loop", "1", "-t", f"{e - s:.3f}", "-i", img] if faded
                   else ["-i", img])
        ops = []
        if need_scale:
            ops.append(f"scale={ow}:-1")
        if faded:
            ops += ["format=rgba", f"fade=t=in:st=0:d={fade}:alpha=1",
                    f"fade=t=out:st={max(0, (e - s) - fade):.3f}:d={fade}:alpha=1",
                    f"setpts=PTS+{s}/TB"]
        if ops:
            fc.append(f"[{n_in}:v]" + ",".join(ops) + f"[ovs{j}]")
            scaled = f"[ovs{j}]"
        else:
            scaled = f"[{n_in}:v]"
        x, y = ov.get("x", "20"), ov.get("y", "20")
        fc.append(f"{cur}{scaled}overlay={x}:{y}:"
                  f"enable='between(t,{s},{e})'[ovr{j}]")
        cur = f"[ovr{j}]"
        n_in += 1

    out = os.path.join(tmp, f"clip{idx}.mp4")
    run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(fc),
         "-map", cur, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-r", str(int(FPS)), out])
    dur = probe_duration(out)
    if fdur:
        out2 = os.path.join(tmp, f"clip{idx}_f.mp4")
        run(["ffmpeg", "-y", "-i", out, "-vf",
             f"fade=t=out:st={max(0,dur-fdur):.3f}:d={fdur}",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18",
             "-pix_fmt", "yuv420p", "-r", str(int(FPS)), out2])
        out, dur = out2, probe_duration(out2)
    return out, dur, twin


def derive_title(description):
    """Fallback title from a description: first clause / ~7 words."""
    text = re.split(r"[.;:\n]", description.strip())[0]
    words = text.split()
    return " ".join(words[:8])


# ============================ assembly ======================================
def assemble(clips_info, C, tmp):
    """Join normalized clips with transitions. Returns (path, [clip_start_abs])."""
    FPS = C["canvas"]["fps"]
    paths = [ci[0] for ci in clips_info]
    durs = [ci[1] for ci in clips_info]
    if len(paths) == 1:
        return paths[0], [0.0]

    inputs = []
    for p in paths:
        inputs += ["-i", p]
    fc = []
    acc = "[0:v]"
    acc_dur = durs[0]
    starts = [0.0]
    for i in range(1, len(paths)):
        tr = clips_info[i - 1][2]                      # transition INTO clip i
        d = 0.0 if tr["type"] == "cut" else float(tr["duration"])
        starts.append(acc_dur - d)
        nxt = f"[{i}:v]"
        out = f"[a{i}]"
        if d <= 0:
            fc.append(f"{acc}{nxt}concat=n=2:v=1:a=0{out}")
            acc_dur += durs[i]
        else:
            off = max(0.0, acc_dur - d)
            fc.append(f"{acc}{nxt}xfade=transition={tr['type']}:"
                      f"duration={d}:offset={off:.3f}{out}")
            acc_dur += durs[i] - d
        acc = out
    out = os.path.join(tmp, "assembled.mp4")
    run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(fc),
         "-map", acc, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-r", str(int(FPS)), out])
    return out, starts


# ============================ main ==========================================
def main():
    args = [a for a in sys.argv[1:]]
    if not args or "-h" in args or "--help" in args:
        print(__doc__)
        return
    cfg_path = args[0]
    flags = set(args[1:])
    C = load_config(cfg_path)
    C["__path__"] = cfg_path
    if "--no-voice" in flags:
        C["voice"]["enabled"] = False
    if "--no-pace" in flags:
        C["pacing"]["enabled"] = False
    keep_temp = "--keep-temp" in flags

    for t in ("ffmpeg", "ffprobe", "inkscape"):
        need(t)
    if not C["clips"]:
        raise SystemExit("config has no clips")
    V = C["voice"]
    if V["enabled"]:
        eng = tts_engine(V)
        if V["engine"] != "auto" and not engine_available(V, eng):
            raise SystemExit(f"voice engine '{eng}' not available (tts_home="
                             f"{V['tts_home']}) -- set it up or use --no-voice")
        print(f"voice engine: {eng}")

    out_path = C["output"]
    if not os.path.isabs(out_path):
        out_path = os.path.join(os.path.dirname(os.path.abspath(cfg_path)), out_path)

    tmp = tempfile.mkdtemp(prefix="build-video-")
    FPS = C["canvas"]["fps"]

    # 1) normalize each clip (title + overlays baked in)
    print(f"normalizing {len(C['clips'])} clip(s)...")
    clips_info = []                       # (path, dur, transition, title_window)
    for idx, clip in enumerate(C["clips"]):
        path, dur, twin = normalize_clip(clip, idx, C, tmp)
        tr = deep_merge(C["transition"], clip.get("transition", {}))
        clips_info.append((path, dur, tr, twin))

    # 2) assemble with transitions
    assembled, starts = assemble(clips_info, C, tmp)
    total_orig = probe_duration(assembled)

    # absolute title windows + narration anchors (original timeline)
    title_windows, narration = [], []
    if V["enabled"] and C["intro"]["narration"]:
        narration.append({"pos": -1.0, "label": "intro",
                          "text": C["intro"]["narration"]})
    for idx, clip in enumerate(C["clips"]):
        twin = clips_info[idx][3]
        if twin:
            title_windows.append((starts[idx] + twin[0],
                                  starts[idx] + twin[0] + twin[1]))
        if V["enabled"]:
            text = clip.get("narration") or clip.get("description")
            if text:
                at = clip.get("narration_at", clip.get("title_at", C["title"]["at"]))
                narration.append({"pos": starts[idx] + at,
                                  "label": clip.get("title")
                                  or f"clip{idx}", "text": text})

    # 3) synthesize narration up front (durations feed pacing + sync)
    voice_clips = []
    if V["enabled"]:
        print(f"narration: synthesizing {len(narration)} line(s)...")
        for k, n in enumerate(narration):
            wav = os.path.join(tmp, f"vo{k}.wav")
            synth_line(V, n["text"], wav)
            voice_clips.append({**n, "wav": wav, "dur": probe_duration(wav)})

    # 4) adaptive pacing -> speed map
    base = C["speed"]
    if C["pacing"]["enabled"]:
        motion = measure_motion(assembled, C["pacing"]["bucket"])
        narr_cover = [
            (0.0, (C["intro"]["delay"] + v["dur"]) * base) if v["pos"] < 0
            else (v["pos"], v["pos"] + v["dur"] * base) for v in voice_clips]
        segs = build_speed_map(total_orig, base, C["pacing"],
                               title_windows, motion, narr_cover)
    else:
        segs = [(0.0, total_orig, base)]

    # apply speed map
    if len(segs) == 1 and abs(segs[0][2] - 1.0) < 1e-6:
        paced = assembled
    else:
        fcr = ["[0:v]split=%d%s" % (len(segs),
               "".join(f"[p{i}]" for i in range(len(segs))))]
        for i, (s, e, f) in enumerate(segs):
            fcr.append(f"[p{i}]trim={s:.3f}:{e:.3f},setpts=(PTS-STARTPTS)/{f:.4f},"
                       f"fps={FPS:g}[q{i}]")
        fcr.append("".join(f"[q{i}]" for i in range(len(segs)))
                   + f"concat=n={len(segs)}:v=1:a=0[v]")
        paced = os.path.join(tmp, "paced.mp4")
        run(["ffmpeg", "-y", "-i", assembled, "-filter_complex", ";".join(fcr),
             "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
             "-pix_fmt", "yuv420p", "-r", str(int(FPS)), paced])
    total = warp_time(segs, total_orig)
    if C["pacing"]["enabled"]:
        slow = sum(e - s for s, e, f in segs if f < base - 1e-6)
        fast = sum(e - s for s, e, f in segs if f > base + 1e-6)
        print(f"pacing: {len(segs)} segments, {slow:.0f}s slowed / {fast:.0f}s "
              f"accelerated -> {total:.1f}s")

    # 5) encode video (codec/container from config) + mux narration
    E = C["encode"]
    vcodec = E.get("vcodec", "libvpx-vp9")
    pix = E.get("pix_fmt", "yuv420p")
    if vcodec == "libvpx-vp9":                        # default: VP9 2-pass
        crf = E["crf"] if E.get("crf") is not None else E["vp9_crf"]
        log = os.path.join(tmp, "vp9pass")
        common = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(crf),
                  "-row-mt", "1", "-pix_fmt", pix, "-an", "-passlogfile", log]
        run(["ffmpeg", "-y", "-i", paced, *common, "-pass", "1",
             "-f", "null", os.devnull])
        venc = os.path.join(tmp, "video.webm")
        run(["ffmpeg", "-y", "-i", paced, *common, "-pass", "2", venc])
    else:                                             # x264/x265/ProRes single pass
        crf = E["crf"] if E.get("crf") is not None else 18
        ext = ".mov" if vcodec == "prores_ks" else ".mp4"
        venc = os.path.join(tmp, "video" + ext)
        cmd = ["ffmpeg", "-y", "-i", paced, "-c:v", vcodec, "-pix_fmt", pix, "-an"]
        if vcodec in ("libx264", "libx265"):
            cmd += ["-preset", E.get("preset", "medium"), "-crf", str(crf)]
        elif vcodec == "prores_ks":
            cmd += ["-profile:v", str(E.get("prores_profile", 3))]
        run([*cmd, venc])

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    # resolve background music
    M = C["music"]
    music_file = M["file"]
    if music_file and not os.path.isabs(music_file):
        music_file = os.path.join(
            C["clips_dir"] or os.path.dirname(os.path.abspath(cfg_path)), music_file)
    have_music = bool(M["file"]) and os.path.isfile(music_file)
    if M["file"] and not have_music:
        print(f"  warning: music file not found, skipping: {music_file}")

    # final placement of each narration line (warped to the paced timeline)
    placed = sorted(
        [(C["intro"]["delay"] if v["pos"] < 0 else warp_time(segs, v["pos"]), v)
         for v in voice_clips], key=lambda x: x[0]) if voice_clips else []

    # output audio codec (auto from container, or explicit)
    acodec = E.get("acodec", "auto")
    if acodec == "auto":
        acodec = "libopus" if out_path.lower().endswith(".webm") else "aac"

    if not placed and not have_music:
        run(["ffmpeg", "-y", "-i", venc, "-c", "copy", out_path])   # remux container
    else:
        ain, afc = [], []
        ai = 1                                    # input 0 = the encoded video
        narr_label = music_label = None
        speech = []                               # (start,end) per line, final time
        if placed:
            mix = []
            for k, (start, v) in enumerate(placed):
                nxt = placed[k + 1][0] if k + 1 < len(placed) else 1e9
                window = nxt - start
                flag = (f"  !! OVERRUNS by {v['dur'] - window:.1f}s"
                        if v["dur"] > window else "")
                print(f"   {str(v['label'])[:22]:22} {v['dur']:4.1f}s /"
                      f" {window:5.1f}s{flag}")
                ain += ["-i", v["wav"]]
                ms = int(round(start * 1000))
                afc.append(f"[{ai}:a]adelay={ms}|{ms}[d{k}]")
                mix.append(f"[d{k}]")
                speech.append((start, start + v["dur"]))
                ai += 1
            afc.append("".join(mix) + f"amix=inputs={len(placed)}:normalize=0:"
                       "dropout_transition=0,alimiter=limit=0.95[narr]")
            narr_label = "[narr]"
        if have_music:
            ain += ["-stream_loop", "-1", "-i", music_file]   # loop to cover video
            mf = (f"[{ai}:a]atrim=0:{total:.3f},asetpts=N/SR/TB,"
                  f"volume={M['volume']}")
            if M["duck"] and speech:                          # dip under narration
                expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in speech)
                mf += f",volume={M['duck_amount']}:enable='{expr}'"
            if M["fade_in"] > 0:
                mf += f",afade=t=in:st=0:d={M['fade_in']}"
            if M["fade_out"] > 0:
                mf += (f",afade=t=out:st={max(0, total - M['fade_out']):.3f}"
                       f":d={M['fade_out']}")
            afc.append(mf + "[music]")
            music_label = "[music]"
            ai += 1

        if narr_label and music_label:
            afc.append(f"{music_label}{narr_label}amix=inputs=2:normalize=0:"
                       "dropout_transition=0[aout]")
            out_a = "[aout]"
        else:
            out_a = narr_label or music_label
        A = C["audio"]                                 # EBU R128 loudness normalize
        if out_a and A.get("loudnorm"):
            ln = A["loudnorm"]
            d = ln if isinstance(ln, dict) else {}
            pars = (f"I={d.get('I', -16)}:TP={d.get('TP', -1.5)}:"
                    f"LRA={d.get('LRA', 11)}")
            afc.append(f"{out_a}loudnorm={pars}[aout_ln]")
            out_a = "[aout_ln]"
        run(["ffmpeg", "-y", "-i", venc, *ain, "-filter_complex", ";".join(afc),
             "-map", "0:v", "-map", out_a, "-c:v", "copy", "-c:a", acodec,
             "-b:a", f"{C['encode']['audio_kbps']}k", out_path])

    print(f"\nwrote {out_path} ({os.path.getsize(out_path)/1e6:.2f} MB, {total:.1f}s)")
    if keep_temp:
        print(f"temp kept: {tmp}")
    else:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
