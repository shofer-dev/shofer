# video-builder — AI presenter avatar + remote GPU (design doc)

**Status:** design / not started. Captures the plan for adding a generated
talking-head **presenter** (2D and personalized "3D" paths) to `build-video.py`,
composited picture-in-picture over the screencast, plus **dynamic remote-GPU
provisioning** so the heavy steps can run when no local GPU is available.

This is a forward-looking design note, not committed work. It complements
[`TODO.md`](./TODO.md) (the editing-feature backlog); the picture-in-picture
overlay listed there is a prerequisite for the compositing step below.

---

## 1. Goal & motivation

Extend the config-driven pipeline so a single YAML can go:

```
text spec ─▶ TTS narration ─▶ generated presenter avatar ─▶ PiP over paced screencast ─▶ final video
```

…fully self-hosted / offline-capable, from a spec an agent could author.

**Why it's interesting (positioning).** The avatar tech itself is commodity
(HeyGen, Synthesia, D-ID do it as closed cloud products; Wav2Lip/SadTalker/
LatentSync are open models with no orchestration). What's uncommon is the
_combination_: open-source + self-hosted + declarative-config + TTS + generated
presenter + screencast pacing, all in one reproducible spec. The selling point
is **"an agent generates its own product demo — voice, presenter, pacing — from a
YAML it writes,"** not "we have avatars too." Lead with reproducible/self-hosted/
agent-authored; do **not** compete with HeyGen on raw avatar quality.

**Keep it modular.** The avatar step must be optional and pluggable (a
`presenter:` block that shells out to a swappable backend), never hard-baked.
The model repos are brittle and move monthly; isolation limits the rot.

---

## 2. The three sub-problems (very different difficulty)

| Step                | Difficulty | Notes                                                                                                     |
| ------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| **PiP compositing** | Trivial ✅ | Pure ffmpeg `overlay` (+ optional circular mask/fade). Already the "PiP video overlay" item in `TODO.md`. |
| **Voice**           | Done ✅    | Existing TTS produces the narration WAV — the input to lip-sync.                                          |
| **Face generation** | Hard ⚠️    | Heavy PyTorch + (realistically) CUDA, multi-GB weights. The real work.                                    |

So "do it with the same deps / Python-only" is **true for compositing**, and
**false for face generation** (adds PyTorch + CUDA + GB-scale weights + a GPU).

---

## 3. Avatar paths

### Route A — 2D talking head (single image in) — _fast, lower effort_

One good photo + narration WAV → animate that photo to lip-sync. **2D image
animation, not 3D.** Extra loose photos don't help — these use one reference.

| Tool           | VRAM (inference)                | Notes                              |
| -------------- | ------------------------------- | ---------------------------------- |
| Wav2Lip        | ~2–4 GB                         | Robust, but low-res/blurry mouth   |
| SadTalker      | ~6–8 GB                         | Adds head motion; ok on 8 GB       |
| MuseTalk       | ~8 GB                           | Near real-time on a strong GPU     |
| **LatentSync** | ~18–20 GB (less at reduced res) | Diffusion; recommended for Route A |
| Hallo2         | ~20–24 GB for hi-res/long       | High quality, heavy                |

**Recommended:** LatentSync (good quality vs. effort) on a 24 GB card.

### Route B — personalized "3D" avatar (short video in) — _"unmistakably me"_

The route that actually yields a personalized, view-consistent avatar. Input is
**not loose stills** — it's a **short clean video of you talking to camera
(~2–5 min, good light, steady framing)**. Trains a person-specific neural head
model (hours on GPU), then inference from new audio is fast. NeRF/3DGS
representations are effectively 3D (novel viewpoints, consistent geometry).

| Tool                                        | VRAM (train) | Notes                                 |
| ------------------------------------------- | ------------ | ------------------------------------- |
| ER-NeRF / RAD-NeRF (NeRF)                   | ~8–12 GB     | Most efficient personalized route     |
| GeneFace++ (NeRF)                           | ~16–24 GB    | Heavier training                      |
| **TalkingGaussian / GaussianTalker (3DGS)** | ~24 GB       | Genuinely 3D; recommended for Route B |

**Recommended:** TalkingGaussian (3DGS) on a 24 GB card; train once, reuse.

### Route C — true riggable 3D model — _out of scope (for now)_

Multi-view capture + FLAME/3DGS animatable head avatars (e.g. GaussianAvatars)
for a re-posable, relightable 3D head. Much heavier capture + pipeline; overkill
for a corner-of-screen narrator. Documented only so the boundary is explicit.

### Input requirements summary

- **Loose photos → not a 3D avatar.** They feed Route A (which uses one anyway).
- **Personalized/"3D" avatar of yourself → a short _video_** of you, then train
  (Route B).
- It's your own likeness (no consent issue), but these produce deepfake-grade
  likenesses — treat the model/weights accordingly.

---

## 4. Config — the `presenter:` block

Optional; absent ⇒ today's behaviour (voiceover only, no face).

```yaml
presenter:
    enabled: true
    backend: latentsync # latentsync | sadtalker | wav2lip | musetalk | talkinggaussian | hallo2
    source: assets/face.png # Route A: a portrait image
    # source_video: assets/me-5min.mp4   # Route B: training clip (personalized)
    model_dir: media/video/avatar # weights cache (git-ignored, like the TTS home)
    # --- placement (composited via the PiP overlay machinery) ---
    position: bottom-right # corner or "x,y" expr (W,H=canvas; w,h=overlay)
    scale: 0.22 # width as fraction of canvas
    shape: circle # circle | rounded | rect (mask)
    margin: 30
    fade: 0.4
    # heavy generation runs on whatever `compute.backend` selects (below)
```

The synthesized presenter clip is just another input to the existing
`overlay`/`alphamerge` graph — once that PiP item from `TODO.md` lands, this is
wiring, not new compositing.

---

## 5. Remote GPU compute

No local GPU here (confirmed: no NVIDIA device, no torch). Heavy steps must be
able to run on a rented GPU. **The API/provisioning is the easy part; the
reproducible remote environment and safe teardown are the hard part.**

### Config — the `compute:` block (generic, not avatar-specific)

Any heavy GPU step (face gen, NeRF/3DGS training) reuses this.

```yaml
compute:
    backend: local # local | ssh | vast | runpod
    image: ghcr.io/arkware/avatar-gpu:latest # baked env (CUDA+torch+model+weights)
    # ssh backend:
    ssh_host: "" # user@host of an already-running GPU box
    ssh_key: ""
    # vast/runpod:
    gpu: "RTX 4090" # selection hint
    max_runtime_min: 30 # watchdog / cost guard
    destroy_on_exit: true # MUST default true — never leak a billed instance
    spend_cap_usd: 5 # hard ceiling
```

### Backend interface

Small abstraction so the core script is provider-agnostic:

```
provision()  -> handle      # local: no-op; remote: create/select instance, wait for SSH
upload(files) -> remote paths
run(cmd)     -> exit/log    # exec the model in the baked image
download(out)-> local paths
destroy()                   # idempotent; called in finally{} on success/failure/Ctrl-C
```

### Backends (recommended order to build)

1. **`ssh`** — _build first._ Point at a box you (or the script) already rented:
   scp inputs, run, scp results back. 90% of the value, ~10% of the complexity,
   **no lifecycle code**. Auto-provisioning later sits on top of this.
2. **`runpod` (serverless)** — lowest-maintenance auto-scaling path: POST a job
   to an endpoint that already has the model loaded, get a result back. No
   instance lifecycle, no teardown races, no idle billing.
3. **`vast`** — full auto-provision (search offers → create → … → destroy).
   Cheapest per-hour (~$0.30–0.70/hr for a 4090), but spot-like: instances fail
   to start, get preempted, SSH races. Most lifecycle code; build last.

### Lifecycle (vast/ssh-create path)

```
detect no local GPU → search/select → create → wait-for-SSH
  → upload(face/video, narration.wav) → run avatar model → download(presenter.mp4)
  → composite locally (ffmpeg PiP) → DESTROY
```

### Hard requirements

- **Guaranteed teardown.** `try/finally` around the whole remote session +
  server-side `max_runtime_min` watchdog. A crashed/Ctrl-C'd run must not leave a
  billed GPU running.
- **Reproducible image.** Bake CUDA + torch + model + weights into a Docker image
  (`compute.image`). Do **not** download gigabytes on every boot.
- **Cost/secrets safety.** API key via env/secret (never in YAML); hard
  `spend_cap_usd`; log the running cost.
- **Privacy note.** Remote backends ship your face video + script to a 3rd-party
  box — the opposite of the self-hosted/offline property. Make it an explicit,
  opt-in choice; keep `local`/`ssh`-to-your-own-box as the private default.

---

## 6. GPU hardware target

VRAM is the binding constraint, not raw speed. **Target 24 GB.**

- **24 GB (RTX 3090 / 4090 / 5090, A5000):** runs everything — LatentSync,
  Hallo2, 3DGS training. The recommended target; removes every VRAM ceiling.
- **12–16 GB (3060 12GB, 4060 Ti 16GB, 4070):** Route A lighter tools + ER-NeRF;
  LatentSync/Hallo2 only at reduced res.
- **≤8 GB:** realistically just Wav2Lip / SadTalker.

Renting (since local is unavailable): RunPod / Vast.ai / Lambda — a 24 GB **RTX
4090 at ~$0.30–0.70/hr** covers all routes. Route A = rent per render session;
Route B = rent once for a few hours to train, then cheap inference.

---

## 7. Recommended phasing

1. **PiP video overlay** in `build-video.py` (the `TODO.md` item) — useful on its
   own, prerequisite for everything here.
2. **`compute.backend: ssh`** — generic remote executor against an existing GPU
   box. Unblocks all GPU work without lifecycle code.
3. **Route A avatar** (LatentSync) behind the `presenter:` block, run via the SSH
   executor. First end-to-end "text → presenter-led demo."
4. **Reproducible GPU Docker image** + **RunPod serverless** backend (no-lifecycle
   auto-scaling).
5. **`vast` auto-provisioning** backend (cheapest, most lifecycle code).
6. **Route B personalized avatar** (TalkingGaussian) — train-once, reuse.

---

## 8. Caveats & risks

- **Differentiator, not a moat.** Components are commoditizing fast; avatar SaaS
  are adding APIs. Treat as a story, not a defensible edge.
- **Quality gap.** Self-hosted avatars trail HeyGen/Synthesia — frame as
  "self-hosted & private," not "best quality."
- **Maintenance liability.** Avatar repos are brittle and fast-moving; keep the
  step pluggable/optional and pinned via the Docker image.
- **Editorial.** A corner talking-head can compete with the screencast it covers;
  the _capability_ matters more than always using it.
- **Privacy.** Remote GPU + face/script egress breaks the offline property; keep
  it opt-in with a private (`local`/`ssh`) default.

## 9. Open questions

- Which Route A model to standardize on first — LatentSync vs SadTalker (quality
  vs VRAM/setup)?
- Generate the face (SDXL/FLUX) or require a user-supplied portrait/clip?
- Where do baked GPU images live (GHCR?) and who maintains them?
- Should `compute` be a video-builder concern at all, or a thin shared helper any
  Shofer GPU task can use?
