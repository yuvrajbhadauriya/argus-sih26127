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

## Tests

```bash
cd pipeline && python3 -m pytest tests/test_prepare_videos.py -q
```

The tests mock `subprocess`, so they need neither ffmpeg nor network access.
