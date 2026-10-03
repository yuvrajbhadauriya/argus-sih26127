# Video tools

Scripts that turn the candidate traffic clips in `pipeline/data/candidate_clips/`
into files a browser can stream and the ANPR model can read. All outputs land in
`pipeline/data/`, which is gitignored.

## One-time setup

There is no system ffmpeg on the dev machines. `imageio-ffmpeg` ships a static
binary, so a small venv is enough:

```bash
python3 -m venv pipeline/.venv-tools
pipeline/.venv-tools/bin/pip install imageio-ffmpeg
```

To use a different ffmpeg, set `FFMPEG_BINARY=/path/to/ffmpeg`.

## 1. `prepare_videos.py`: transcode

```bash
pipeline/.venv-tools/bin/python pipeline/tools/prepare_videos.py            # all clips
pipeline/.venv-tools/bin/python pipeline/tools/prepare_videos.py --only <slug>
pipeline/.venv-tools/bin/python pipeline/tools/prepare_videos.py --force    # rebuild everything
```

For each `candidate_clips/<slug>.mp4` it writes:

| Output | What it is |
|---|---|
| `data/videos_720p/<slug>.mp4` | Web rendition. 720 px on the short side (landscape `scale=-2:720`, portrait `scale=720:-2`, portrait stays portrait), H.264 High, yuv420p, CRF 24, `-maxrate 2500k -bufsize 5000k`, 2 s GOP, at most 30 fps, no audio, `+faststart`. |
| `data/videos_720p/<slug>.jpg` | Poster frame from about 1 s in, same size as the web rendition. |
| `data/videos_1080p/<slug>.mp4` | Analysis rendition for ANPR inference. 1080 px on the short side, CRF 20, native fps, no audio. Built only when the source is at least 1080p (never upscaled). A source that is already 1080p H.264 is remuxed (stream copy) instead of re-encoded, so plate detail is not lost twice. Pass `--analysis-landscape-only` to skip portrait clips, or `--skip-analysis` to skip this step. |
| `data/videos_720p/manifest.json` | One entry per clip: `slug`, `file`, `width`, `height`, `duration_s`, `fps`, `bytes`, `orientation`, `poster`, `source` (file, size, fps, bytes) and `analysis` (file, size, bytes, or `null`). |

`<slug>` is the source filename without `.mp4`. Keep the names stable: camera
codes are mapped to these slugs elsewhere.

The script is idempotent. An output is skipped when it exists, is newer than its
source, and the manifest says it was made with the current encode profile
(`PROFILE` in the script; bump it when you change settings). Encodes write to a
hidden `.partial` file first, so an interrupted run never leaves a truncated
output behind.

## 2. `upload_videos.py`: push the 720p set to Supabase Storage

Uploads `videos_720p/*.mp4`, the `*.jpg` posters and `manifest.json` to bucket
`videos` under `mumbai/720p/`. Media gets `Cache-Control: max-age=31536000`
(one year; the names are content-stable), the manifest gets 5 minutes. Every
object is upserted with the correct Content-Type.

Credentials are read from the environment or the repo-root `.env`:
`SUPABASE_URL` (or `VITE_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY`. The
service-role key must never go into client code or a `VITE_` variable.

```bash
python3 pipeline/tools/upload_videos.py                                  # dry run (default)
python3 pipeline/tools/upload_videos.py --execute --create-bucket        # first upload; makes a public `videos` bucket if missing
python3 pipeline/tools/upload_videos.py --execute                        # later uploads
python3 pipeline/tools/upload_videos.py --execute --only <slug>          # one clip (manifest is always included)
```

Public URLs then look like:

```
$SUPABASE_URL/storage/v1/object/public/videos/mumbai/720p/<slug>.mp4
$SUPABASE_URL/storage/v1/object/public/videos/mumbai/720p/<slug>.jpg
```

The 1080p analysis files are not uploaded; the inference pipeline reads them
from disk.

## 3. `link_local_videos.py`: play the clips in `npm run dev` without Supabase

```bash
python3 pipeline/tools/link_local_videos.py          # symlinks into public/videos-local/
python3 pipeline/tools/link_local_videos.py --copy   # real copies instead
python3 pipeline/tools/link_local_videos.py --clean  # remove public/videos-local/
```

Vite serves them at `/videos-local/<slug>.mp4`, `/videos-local/<slug>.jpg` and
`/videos-local/manifest.json`. `public/videos-local/` is gitignored. Run
`--clean` before `npm run build` if you do not want the clips copied into
`dist/`.

## 4. `replace_camera_clip.py`: give one camera a new clip

Does the whole swap for one camera on the machine that has the video file.
Needs OpenCV (`python3 -m pip install opencv-python-headless`), `ffmpeg`
(`brew install ffmpeg`; on a Mac without it the built-in `avconvert` H.264 preset is used and the
script says so) and, for the detection step, `DETECTION_API_URL` + `DETECTION_API_KEY` in `.env`
(team network / Tailscale).

```bash
python3 pipeline/tools/replace_camera_clip.py --camera KR-01 --source ~/Downloads/12974288_3840_2160_30fps.mp4 --dry-run   # plan only
python3 pipeline/tools/replace_camera_clip.py --camera KR-01 --source ~/Downloads/12974288_3840_2160_30fps.mp4
python3 pipeline/tools/replace_camera_clip.py --camera AN-01 --source ~/Downloads/13270133_3840_2160_30fps.mp4
# options: --slug mumbai_<desc>_pexels<id>  --start S --duration D  --force  --no-detect  --from-cache  --upload
```

1. Validates the source with OpenCV (opens, size, fps, length, frames decode) and refuses what it cannot decode.
2. Transcodes with the `prepare_videos.py` profile (720p web rendition + poster in `data/videos_720p/`,
   1080p analysis rendition in `data/videos_1080p/`, H.264 + yuv420p + faststart, no audio) and copies the
   web files to `public/videos-local/`. Default length: the whole clip up to 45 s (the other clips run 10-71 s,
   median ~44 s), so a 20 s clip stays whole and a 57 s clip keeps its first 45 s; `--start/--duration` pick
   another window. Each output is re-read and checked (codec, size, length, moov atom first).
3. Runs `pipeline/detect/run_remote_detection.py` with its defaults on the analysis rendition into a staging
   folder. Only if that succeeds: the old `detections_/events_<code>.json` and `manifest.json` are copied to
   `pipeline/data/backups/<code>_<old slug>/`, the new files are installed in `public/detections/`, and the
   camera is pointed at the new slug in `src/config/cameraClips.json` and `pipeline/camera_config.json`.
4. `--upload` only: uploads the clip + poster to the private `videos` bucket (`mumbai/720p/`) and **prints**
   the `insert_detections.py` commands for the production database; it never runs them.
5. Prints old vs new slug, frames, duration, reads and the next commands.

The default slug is `mumbai_<camera name>_pexels<id from the file name>`. Re-running is safe (finished steps are
skipped, finished GPU responses are cached) and nothing of the old clip is ever deleted.

## Tests

```bash
cd pipeline && python3 -m pytest tests/test_prepare_videos.py tests/test_replace_camera_clip.py -q
```

The tests mock `subprocess`, so they need neither ffmpeg nor network access.
