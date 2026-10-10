# Help page clips

Short silent screen recordings for the `/help` topic pages, for the gestures a
still cannot teach: a long press that raises a sheet, a swipe that reveals row
actions, a drag across the board. Everything else stays a
[still](help-screenshots.md) — a still costs the reader nothing to look at and
carries a caption just as well.

`scripts/lib/help-clips.ts` holds the whole contract: the clip table, the
directories, the encoder settings, and the size budget. Nothing else should
hardcode a clip name.

## What the operator records

One clip per gesture, portrait, on an iPhone simulator, **5–12 seconds**:

```
xcrun simctl io <udid> recordVideo --codec h264 --force .boardsesh/help-clips/raw/<name>.mov
```

Then SIGINT (Ctrl-C) to stop — `simctl` finalises the file on the interrupt, so
killing it any harder leaves an unplayable container.

- `<name>` is a name from `HELP_CLIPS`, exactly: lowercase, hyphenated, `.mov`.
  The converter refuses anything else, because the name becomes a public URL
  segment.
- `.boardsesh/` is gitignored. Raw recordings are 1–8 MB and never get committed.
- Start recording a beat **before** the gesture and stop a beat after. A clip
  that opens mid-swipe teaches nothing; the trim in `HELP_CLIPS` can tidy the
  ends afterwards, but it cannot invent a frame nobody shot.
- Silent by definition — the audio track is dropped in conversion, so simulator
  sound does not matter.
- Capture at the same device and appearance as the help stills (iPhone 16 Pro
  Max, dark) so a clip and a still in one row look like one session. See
  [iOS simulator screenshots](ios-simulator-screenshots.md).

The operator can deliver incrementally; the converter takes what has arrived.

## Re-recording one

Every clip has a Maestro flow in `packages/mobile/.maestro/help-clips/`, named
after the clip, whose header says what it records, which deep link the caller
must already be on, and what each coordinate targets. The boot command, the
lease-token and whole-percentage gotchas, the per-clip traps and what a session
leaves on the account are all in
[that directory's README](../packages/mobile/.maestro/help-clips/README.md).

## Converting

Needs `ffmpeg` and `ffprobe` with `libx264` and `libvpx-vp9` (`brew install ffmpeg`
on a Mac; the distro package on Linux). The converter looks on PATH, then in the
Homebrew and `/usr/local` prefixes; set `FFMPEG_BIN` / `FFPROBE_BIN` to point it
somewhere else.

```
vp run help:convert-clips -- --allow-partial
vp run generate:static-assets
```

The first command writes, per clip:

| Output | Settings |
| --- | --- |
| `packages/web/public/videos/help/<name>.mp4` | libx264, crf 24, preset slow, yuv420p, 30 fps, 736 px wide, `+faststart`, no audio |
| `packages/web/public/videos/help/<name>.webm` | libvpx-vp9, crf 34, `-b:v 0`, row-mt, same scale, no audio |
| `packages/web/public/images/help/clips/<name>.webp` | first trimmed frame (or the entry's `poster` offset) through Sharp — `height: 1600`, `quality: 87`, `effort: 6`, identical to `help:convert-shots` |

Both encodings ship because no single container plays everywhere, and the poster
comes out of Sharp rather than ffmpeg because this ffmpeg has no libwebp encoder.
736 × 1600 is the same box as a help still, so a clip and a still sit in one row
without either one shifting the layout.

Flags:

- `--allow-partial` converts what has arrived and names the rest. Without it a
  missing recording is fatal: a page that references a clip nobody shot renders
  a broken player.
- `--only <name>` re-converts one clip after a re-shoot.
- `--input <dir>` points at a directory other than `.boardsesh/help-clips/raw`.
- `--dry-run` lists the conversions and writes nothing.

The run prints a table of duration and bytes per file. **Always run
`vp run generate:static-assets` afterwards and commit the regenerated catalog** —
the videos are content-addressed and uploaded exactly like the images, and a
stale catalog fails `vp run check:static-assets` and the upload job.

## Size budget

**1.5 MB per file**, warned on rather than enforced — an over-budget clip is a
judgement call for the person committing it, and failing the run would leave
them nothing to look at while they decide. A 6-second portrait recording lands
around 200–600 KB. Past the budget, the usual causes are a take that should have
been trimmed, or a full-screen board render animating through the whole clip.

## Using one on a page

```tsx
import { HelpClip, HelpShots } from '../help-clip';
import { HelpScreenshot } from '../help-screenshot';

<HelpShots>
  <HelpClip
    name="long-press-climb-actions"
    alt={t('help.climbActions.menu.clipAlt')}
    caption={t('help.climbActions.menu.clipCaption')}
  />
  <HelpScreenshot
    shot="climb-actions"
    alt={t('help.climbActions.menu.shotAlt')}
    caption={t('help.climbActions.menu.shotCaption')}
  />
</HelpShots>;
```

`HelpShots` is the same grid either component sits in, re-exported from
`help-clip.tsx` so one import gives a page both. `alt` and `caption` arrive
already resolved by the caller's `t()`, exactly like `HelpScreenshot`'s.

The component autoplays muted, looping and inline — but only after the client
has confirmed the reader has **not** asked for reduced motion. Where they have
(or where the browser refuses the autoplay), the clip shows its poster with
native controls and a line telling them to press play. The server renders
neither: just the poster in its frame, which is why the caption has to say what
the clip shows rather than rely on the motion.

## Adding a clip

1. Add it to `HELP_CLIPS` in `scripts/lib/help-clips.ts` — name, source stem,
   one-line description, optional trim.
2. Add the same name to the `HelpClipName` union in
   `packages/web/app/lib/help-clips.ts`. A browser file cannot import from
   `scripts/`, so the union is declared twice;
   `scripts/__tests__/help-clips.test.ts` holds the two copies together.
3. Have it recorded, convert, regenerate the catalog, and reference it from a
   page.

Prune an entry nothing uses. An unused entry costs the operator a recording
session, so it is cheaper to remove it than to keep it in case.

## The spray wall walkthrough

`/help/spray-walls` carries a longer walkthrough rather than a gesture clip.
Phones get the 720 x 1280 portrait cut; wider screens get a 1280 x 720 chapter
layout with the same app footage and the owner-supplied photo. Neither version
autoplays. These are rendered, not converted, so they stay out of the clip table.

- **Stage:** `marketing/spray-walkthrough/`. The photo-tip scenes (portrait vs
  landscape, side-on, phone upright under an overhang, why skew costs holds) are
  HTML/SVG animations over the owner-supplied `wall-photo.jpg`. A WebP copy at
  `packages/web/public/images/help/spray-wall-photo.webp` appears in the guide.
  `copy.en-US.json` holds every caption; `edit.json` holds the
  cuts into the app takes (frames at 30 fps) and when each caption starts;
  `holds.json` places the rings in the "why it matters" scene.
- **Footage:** current-app iOS simulator takes in `.boardsesh/help-clips/raw/`
  (`spray-create`, `spray-create-rest`, `spray-review`, `spray-edit-later`).
  Record on a signed-in dev client attached to Metro from the current branch.
  Set `SPRAY_WALKTHROUGH_SIMULATOR` to the device UDID, run
  `scripts/spray-walkthrough-takes.sh import-photo`, and select that photo in
  the wizard. Run `record create|create-rest|review|later` for each stage and
  stop each recording with SIGINT. Run `assemble` to trim the long waits into
  compact 30 fps clips; `edit.json` cuts those again for the final scenes.
- **Render:** `vp run video:spray-walkthrough` writes the master to
  `.boardsesh/spray-walkthrough/`, then `packages/web/public/videos/help/spray-walls-walkthrough.{mp4,webm}`
  and the poster `packages/web/public/images/help/clips/spray-walls-walkthrough.webp`.
  `-- --stills` writes a contact sheet of every scene; `-- --frame <n>` writes one frame.
- **Landscape:** run `vp run video:spray-walkthrough:landscape` after the portrait
  render. It composes that checked-in MP4 with five chapter panels, writes
  `spray-walls-walkthrough-landscape.{mp4,webm}` plus a matching WebP poster,
  and checks both videos against the 2 MB asset cap. Its chapter timings follow
  the approved portrait cut; update them if that cut changes. Run
  `vp run generate:static-assets` after either render.

**Record from the current app source.** Note the commit and capture date with the
walkthrough, then check that the same controls have reached production before
publishing the guide. Record from a clean checkout; Metro may need a restart
after source changes.

The current takes were captured on 2026-10-10 (Sydney) from `d669419a6b`,
rebased on main `5992ed8e8005d0256c96637d00c42369b6eb0e8f`, on an
iPhone17,2 simulator at 1320 x 2868 with Metro on port 8093.

**Re-record after spray UI changes.** Verify every caption against the visible
controls in the final cut, especially Add mode, ghost rings, Reset this wall,
and the separate background and hold-look steps. The iOS capture used a
1320 x 2868 simulator; re-measure any fixed taps on another device.
The over-budget size is deliberate: two minutes of footage does not fit 1.5 MB.

## The hold editor walkthrough

The setup walkthrough now points to the separate editor tutorial below it on
`/help/spray-walls`. `marketing/spray-editor/edit.json` contains its captions,
source filenames, trims and playback speeds. The editor tutorial follows the
same silent, captioned format: portrait on phones and a landscape chapter layout
on wider screens. The written guide translates the instructions into all four
supported locales; captions embedded in the video are English.

The editor footage and three stills were captured on 2026-10-10 from the current
app source at `2f84c1cb27`, using the same iPhone simulator and owner-supplied wall
photo as the setup walkthrough. They show Select, Add → Draw, Add → Corners,
Trace, Refine, Join, reopening Edit holds, and publishing added holds. Removal
consequences and iPad Pencil behavior are explanatory chapter cards over the
real wall photograph, not recordings of a removal confirmation or an iPad.
No demonstration climb was saved or used hold removed for those cards.

To reproduce:

1. Use an isolated development wall and confirm the app's backend URL before
   recording. Screenshot mode stabilizes presentation; it does not isolate
   server writes. Opening Edit holds can create a draft, and Publish holds can
   save immediately when no published climb uses the changed holds.
2. Record the source clips named in `marketing/spray-editor/edit.json` into
   `.boardsesh/spray-editor/raw/`. Start before each gesture and stop with
   SIGINT. Capture `select.png`, `draw.png` and `corners.png` at the corresponding
   tool states. The long Draw take has a trim near its end; update that trim
   when replacing the recording.
3. Run `vp run video:spray-editor -- --check` to verify inputs, then
   `vp run video:spray-editor -- --shots` for the page stills and
   `vp run video:spray-editor -- --stills` for chapter previews.
4. Run `vp run video:spray-editor` for both aspect ratios and their posters,
   then `vp run generate:static-assets`. Review playback and every caption
   against the actual controls before publishing.

The renderer uses Sharp and ffmpeg, exports silent 15 fps MP4 and WebM versions,
and enforces the 2 MB limit per video. Outputs are
`spray-holds-editor{,-landscape}.{mp4,webm}` under `public/videos/help/`,
matching posters under `public/images/help/clips/`, and three
`spray-editor-*.webp` stills under `public/images/help/`. Raw takes remain
untracked, as with the main walkthrough. The guide's existing release gate also
applies to this tutorial: the demonstrated editor must reach store users first.
