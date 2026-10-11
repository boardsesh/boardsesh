# Instructional videos

Tracking: [parent #6330](https://github.com/boardsesh/boardsesh/issues/6330), [Android #6331](https://github.com/boardsesh/boardsesh/issues/6331), [iOS #6332](https://github.com/boardsesh/boardsesh/issues/6332), [human voice #6333](https://github.com/boardsesh/boardsesh/issues/6333), [music/subtitles #6334](https://github.com/boardsesh/boardsesh/issues/6334), [publication and 2.6.0 #6335](https://github.com/boardsesh/boardsesh/issues/6335).

## What a build produces

The evergreen episode teaches advanced app features in five chapters: crew queues, generated workouts and rest, hold/region/similar/heatmap search, spray walls, and personal grades with progress across boards. It skips standard climb CRUD. Twenty short human recordings are shared between a 149-second master, a 55-second overview Reel and five 31-second chapter Reels. Recorded voice length can extend these timings, within the episode's duration limits.

All videos are portrait 1080 × 1920, 30 fps, H.264 with stereo AAC and MP4 fast-start. Each cut has a WebP cover, WebVTT subtitles, chapter timestamps and Instagram caption copy. Narration is also burned into the picture for muted playback. The stage shares the marketing videos' Inter Tight, Instrument Serif, Geist Mono, violet palette and deterministic motion helpers. Labels and measured highlights follow actual recorded app pixels. Overlay text is checked against the existing marketing Reel safe margins.

Large footage, tool downloads, recordings and outputs live in ignored `.boardsesh/tutorial-videos/`; do not commit MP4s or credentials. Recipes, capture flows and presentation code are versioned. These are internal production tools, with no new public route or sitemap entry.

## Android prerequisites

Use `vp install --frozen-lockfile`. The host needs Docker Compose, the repository Android SDK/JDK setup, Maestro CLI, ffmpeg, ffprobe and Playwright Chromium. `FFMPEG_BIN` and `FFPROBE_BIN` can select explicit media binaries; these overrides also reach the isolated capture environment. The latest compatible cached dev-client APK is resolved automatically; use `--apk-path` to select an explicit APK. The APK loads this worktree's JS through Metro.

Snapshot export needs temporary space as well as output space. On hosts with a small `/tmp` filesystem, create a directory on the workspace filesystem and set `TMPDIR` to its absolute path before running the command. Keep that path short enough for `tsx`'s Unix sockets; deeply nested worktree paths can exceed the system limit. The isolated demo preserves that setting.

The recorder creates a dedicated `Boardsesh_Tutorial` AVD, checks its identity before installing, and selects it explicitly with an ADB serial. It never uninstalls or clears an existing app. A machine without KVM uses software emulation, which can take several minutes to boot. Stop another capture before starting a second capture against the same work directory. Linux cannot capture iOS; that edition is tracked separately.

The local demo uses its own Docker Compose project, persistent Postgres volume, Redis and a pinned Moto S3-compatible service. Its first start clones the baked development catalogue into `boardsesh_tutorial`; later starts reuse it. Repository migrations run against that database only. It seeds Alex, Sam, four demo walls, progress, published spray climbs and the existing real spray-wall photo with manually traced holds. Startup refreshes database planner statistics before the app reads progress. Backend startup bypasses dotenv and production background workers, binds to loopback, and uses an explicit environment allowlist. No production account, R2 upload or shared development database is needed. Stopping retains the demo volume.

Before Metro starts, the standard snapshot exporter builds genuine Kilter layout 1 catalogue and grade SQLite artifacts from the same isolated primary database. It uses gzip, the existing row normalization and watermark contract, and `--no-prune` behavior. A separate `tutorial-snapshots` Moto bucket permits anonymous reads only under the tutorial snapshot prefix; uploads send no ACL. The manifest URL is derived from the owned local port and forwarded to Android. Local artifact caches are reused only when catalogue row counts/cursor extrema, seed, runtime sources and stored file hashes agree. Restored objects are checked through their actual public URLs, with the manifest published last. Cache files and the database volume are retained. Artifact hashes join the capture fingerprint, so a changed snapshot invalidates affected footage rather than silently changing its catalogue.

## First draft

1. Inspect the plan and generate the human recording prompts:

   ```sh
   vp run video:tutorial -- --dry-run --draft
   vp run video:tutorial -- --recording-pack
   ```

2. Capture and render the Android edition:

   ```sh
   vp run video:tutorial -- --draft
   ```

   The command writes QA notes before starting the local services, prints the backend URL, starts Metro, records Maestro flows, extracts full-resolution JPEG frames and renders the seven cuts. Drafts are silent and visibly marked; the publisher rejects them.

3. Open `.boardsesh/tutorial-videos/out/android/evergreen/overview.mp4`. Check every label against the app, zoom positions, narration readability, rest advancement and crew attribution. Android selectors must pass against the installed APK; a missing UI control fails capture instead of substituting footage.

4. Change one chapter without regenerating everything:

   ```sh
   vp run video:tutorial -- --draft --only spray --recapture
   vp run video:tutorial -- --draft --render-only
   ```

   `--only` emits chapter cuts only. A complete build emits the master and overview. Capture cache keys cover the demo revision, APK, measured screen, tracked and untracked runtime sources, assets, dependency/configuration files and nested flows. Modified app sources bypass capture reuse. Editorial copy and voice changes reuse app footage. Segment cache keys additionally cover actual frame bytes, fonts and renderer code; cached encodes are probed before reuse.

5. Record the named sentences in `audio/evergreen/recording-pack.md` as WAV, M4A or MP3, one format per beat. Then supply the separate music file:

   ```sh
   vp run video:tutorial -- --render-only --music /path/to/music.wav
   ```

   `--audio-dir` selects another recording directory. No synthetic voice or generated images are supplied. Final exports require every selected recording and the music file. The mixer normalizes speech, ducks the music under it, fades the bed, and limits peaks. Review listening volume and subtitles before publishing.

## Capture evidence and timing

Each take's `manifest.json` records source commit, native APK SHA-256, dependency fingerprint, measured pixel/dp screen, 30 fps frame count, named marks and normalized anchor samples. The renderer stops a beat before the next marked action; a short demonstration can pause while its sentence finishes. It does not stretch the rest countdown to imply automatic advancement. The workout capture waits for the live session's current climb to change after logging, without a manual Next gesture. The crew uses a second authenticated WebSocket participant against the local backend and checks its queue contribution.

Crew sessions stay private. Alex activates the current climb in the app; Sam requests access through the existing API and Alex approves it before Sam joins over the persistent WebSocket. The capture then checks Sam's real queue contribution and avatar. It does not bypass session access checks or make the session public.

Similar climbs and heatmaps require a completed local download. Signing in again or approving private access can trigger the app's normal catalogue revalidation, which clears download checkpoints and hold indexes while retaining manufacturer rows. Crew access finishes before search; the search setup waits for genuine download completion and index rebuilding. Missing required marks, anchors, frames or download completion fail capture/render. Session takes are accepted only after the app ends the exact captured session and the authenticated API confirms its persisted end state. Recorded automation flows have a ten-minute deadline. Download preparation alone permits thirty minutes for the real index, bounded by a thirty-five-minute host deadline including navigation. The genuine cold snapshot contains about 383,000 climbs, 367,000 stats and 351,000 grades; its privacy-safe watermarks require an authenticated replay. In the measured run, stats and grades remained incomplete after the original five-minute readiness deadline. This exception waits for actual nonempty heatmap data and does not skip readiness failures. The encoder is finalized explicitly so slow native checks cannot truncate a valid take. A real Home transition after the final hold supplies the last timestamp for Android's variable-frame recording; the edit ends before that transition.

Ctrl-C or SIGTERM cancels capture, ends its active session and stops the owned process groups and Compose services. Database volumes and emulator storage remain intact. Interrupted takes are not accepted or rendered. Native crashes and automation failures leave diagnostic logs under the work directory. Do not bless a partially completed take by editing its manifest.

## R2 publication

Use the existing named static-assets contract from [static-assets.md](./static-assets.md): `STATIC_ASSETS_S3_BUCKET_NAME`, `STATIC_ASSETS_AWS_ENDPOINT_URL`, `STATIC_ASSETS_AWS_REGION`, `STATIC_ASSETS_AWS_ACCESS_KEY_ID`, `STATIC_ASSETS_AWS_SECRET_ACCESS_KEY`, and `STATIC_ASSETS_PUBLIC_BASE_URL`. Keep secrets in the shell environment; the bundle contains only media and provenance.

```sh
vp run video:tutorial:publish -- --bundle-dir .boardsesh/tutorial-videos/out/android/evergreen --dry-run
vp run video:tutorial:publish -- --bundle-dir .boardsesh/tutorial-videos/out/android/evergreen
```

The publisher checks all local file hashes and complete final deliverables before using credentials. Content-hashed objects are immutable under `tutorials/v1/<episode>/<platform>/objects/`. An immutable edition manifest links the assets; `latest.json` is written last, after public checksum, MIME/cache and video byte-range checks. It uses standard S3 APIs without ACLs, object deletion or bucket configuration. Older editions remain available. Instagram posting is manual: upload the overview/chapter MP4 and use its caption and cover. R2 hosting does not post to Instagram.

## Every minor or major release

Use the checklist in [instructional-release-checklist.md](./instructional-release-checklist.md). Add a small recipe with only the changes a climber gets; reuse existing takes only when their source belongs to the reviewed release. Keep the evergreen recipe current independently. Pin `--source-ref` to the full shipped commit, run from that checkout, and use the same short human-recording workflow and publication command.

The `release-2.6.0` recipe is an authoring template, not a completed episode. Its crew-notes take is intentionally absent until the release is reviewed and captured. Screenshot mode currently suppresses following-climber logs, so that segment needs an appropriate real-app capture mode. A dry-run and recording pack work now; capture/render must fail until the required flow and pinned source are supplied. Do not publish evergreen footage as evidence of a release feature.

## Validation

```sh
vp check
vp run typecheck
vp test run --project scripts --reporter=agent instructional-video
```

Unit checks cover environment isolation, capture identities, mark/anchor handling, duration limits, source-frame boundaries, CLI validation, final-audio gates and publication ordering/failure paths. Real Android capture and a visual/audio review are separate checks; passing unit tests alone does not prove selectors or the finished video.
