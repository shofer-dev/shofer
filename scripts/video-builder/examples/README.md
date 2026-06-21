# video-builder examples

Runnable example configs for [`build-video.py`](../build-video.py). Each one uses
media already in the repo (`extensions/shofer/media/`), so they render without a
TTS environment or any extra downloads. Voice is disabled in every example
(the screencast has no audio); example 05 uses a clip that _does_ carry audio.

Run any of them from this directory:

```bash
cd extensions/shofer/scripts/video-builder/examples
python3 ../build-video.py 01-basics.yaml
```

Outputs are written next to the config (and are git-ignored).

| File                    | Demonstrates                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `01-basics.yaml`        | Cuts (`trim`), generated titles, `fade`/`wipe`/`cut` transitions, fade in/out.                                                         |
| `02-effects.yaml`       | Effect gallery — blur, glow, sepia, vignette, sketch, oldfilm, pixelate, negate, zoom; upper titles.                                   |
| `03-color-grade.yaml`   | Colour grading — `white_balance`, `eq`, 3-way `colorbalance`, `curves`; `stabilize`.                                                   |
| `04-compositing.yaml`   | `generator` card, animated title, clip `transform`, picture-in-picture video, text overlays, keyframed (motion-path) overlay. MP4 out. |
| `05-audio.yaml`         | Source-clip audio (`use_source`), `loudnorm`, `bass`, `compress`, audio crossfade.                                                     |
| `06-subtitles-mp4.yaml` | Burned-in `.srt` subtitles (`captions.srt`) + H.264 MP4 output.                                                                        |

See the [main README](../README.md) for the full config reference, and
[`TODO.md`](../TODO.md) for the OpenShot/Shotcut feature-gap status.
