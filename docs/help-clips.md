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

## Capturing the wall controls

Use a dedicated iPhone 16 Pro Max simulator in dark appearance, at 1320 × 2868,
with the release checkout's cached dev-client and local backend:

```sh
BOARDSESH_METRO_PORT=8191 vp run mobile:ios-shots -- --backend local --device "Boardsesh Help 7208" --app-path <cached dev-client .app>
```

This command uses the store-capture environment even without `--flow`, setting
`EXPO_PUBLIC_SCREENSHOT_DRIVING=1` and `EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=1`. The
existing pair enables the actual wall-button gesture in screenshot mode. Do not
add a separate feature override or change the production rollout for a capture.
The full `mobile:screenshots --flow help` capture now opts into the same pair:
it records the driving player first, opens its real Board controls by holding
the wall button, then stops driving before the preview screenshot. Screenshot
names stay unchanged even though 10-board-view precedes 09-board-sheet.
The fake adapter represents an available board on a simulator with no Bluetooth;
the footage verifies the app's controls, not physical BLE delivery.

For `wall-swipe-to-drive`, open a tracked climb and leave `screenshotDrive`
unset. Start with Put on board or Disconnect board and visible chevrons. Record
swiping the **button** left until Let go to light every climb, releasing into
You are driving the wall, swiping the **board** to another climb, and tapping
**You are driving the wall** to stop. The final label is Disconnect board,
with a plain background: the link stays up. Put on board and non-driving
Disconnect board stay plain. During the gesture the button shows flat amber
progress; bokeh appears only when driving is confirmed. Review the release
label, frosting and climb change together. Before recording, check Settings ›
Board: Disconnect Bluetooth when driving ends off (a simulator that once had
Auto-disconnect on was migrated to on, and the take then ends on Put on board),
and Stop driving after at its default. On a linked board the take opens with the
preview chrome (the arrow back chip, Preview · not on the wall), which clears
when the swipe lights the climb.
`screenshotDrive=1` is for a driving **still**; it starts driving before the
gesture and would skip the lesson this clip teaches.

For `preview-browsing`, stop any drive first (tap You are driving the wall; a
timed one shows a clock), and leave Always drive the wall off in Settings →
Board (the default since #7218). Tap a row to establish its list track, then swipe the
board once. Check for the arrow + face back chip, Preview · not on the wall in
the top bar and a plain Put on board, without pressing it. Close the player and
hold on the MiniPlayer, which keeps the previewed climb while the Climbs header
capsule keeps the wall's. A standalone preview (a deep link or the Home
new-climb card) can have no swipe track; do not use one for this take.

For `put-on-board-timed-drive`, open a tracked preview with no drive active,
then tap **Put on board**. Hold long enough to show its clock and shrinking
frost, swipe the board once to refill the timed window, then tap the driving
button to stop. Do not use `screenshotDrive=1`: it starts the drive before the
take and skips the tap being taught.

### Refresh provenance: 2 November 2026 (#7208)

The refreshed takes use application source
`3b1d9be90cf99517947b5622618df7533864708c` from `main`, captured on
2026-11-02 (Athens) in `Boardsesh Help 7208`: iPhone 16 Pro Max, iOS 27.0,
dark appearance, 1320 × 2868. A cached Debug dev-client loaded current Metro
JavaScript against the local Docker database's seeded test user. The existing
fake Bluetooth adapter exercises the actual controls; it does not verify
physical Bluetooth delivery.

The refreshed takes are `long-press-climb-actions` (hold and ⋯),
`swipe-row-queue-playlist`, `remove-from-playlist`, `preview-browsing`
(including the last-look MiniPlayer ending), `wall-swipe-to-drive`, and the new
`put-on-board-timed-drive`. The playlist removal take restores the local
membership it changed. `start-playlist-queue` uses the compatible local
Aurora Circuit 5 list with Up next already filled and the playlist-loading
switch verified on. Its header **Play** uses the same first-climb activation
callback as a row tap, opens the three-way prompt, and **Cancel** opens the
preview. Repeated coordinate row taps did not activate on this cached client;
the native header worked. Five Stars can select a MoonBoard list while
Tension is active, so use a list compatible with the active board. The setup
flow targets the native switch itself: matching its text label had left it off.

All seven refreshed clips are converted with posters. Each final clip is
12.0 seconds; the largest encoding is 717 KB, below the 1.5 MB file budget.
The original movies were normalized to constant frame rate before editing.
Every retained segment plays at 1×; gaps between segments are cuts, not
speed changes. The timed-drive clip cuts idle countdown time without speeding
up the clock. The playlist-start clip ends with a 1.5-second hold of its actual
final preview frame, with no UI compositing or speedup; its poster is taken at
5 seconds into the edited clip. Final visual QA passed, including the timed stop and Cancel opening the fully painted preview.

`preview-browsing` verifies the last-look MiniPlayer ending but does not show
a simultaneous comparison with the wall-header capsule. That comparison is
deliberately omitted; the preview still's back chip provides the wall reference.
There is no duplicate standalone MiniPlayer clip.

#### Source cut log

These reviewed source windows are copied from the local
`.boardsesh/help-clips/edited/cuts.json`. Times are seconds into each original
constant-frame-rate movie, before these cuts. Normalized edited inputs are
copied into `.boardsesh/help-clips/raw/`, so the default conversion command
can be rerun. Original recordings remain locally under
`.boardsesh/help-clips/uncut/`, their CFR originals under
`.boardsesh/help-clips/cfr/`, and the working edits under
`.boardsesh/help-clips/edited/`. The source commit, date and simulator for every
row are the refresh provenance above.

| Clip | Retained original-CFR windows (seconds, 1×) |
| --- | --- |
| `long-press-climb-actions` | 8–16.5; 19.5–23 |
| `swipe-row-queue-playlist` | 7–13; 13.7–19.7 |
| `remove-from-playlist` | 7.5–19.5 |
| `preview-browsing` | 6.5–18.5 |
| `wall-swipe-to-drive` | 4–13; 15–18 |
| `put-on-board-timed-drive` | 4.5–9.5; 24–31 |
| `start-playlist-queue` | 6.5–8.5; 11–19.5; 1.5-second hold of the actual final preview frame |

The [capture disposition table](help-screenshots.md#help-refresh-2-november-2026-7208)
records all requested media and deliberate omissions.

The previous wall-control takes used `3c4fd3702d` on 2026-10-31 in
`Boardsesh Release Help 20261031`, with Metro on port 8191. They predated #7170
and #7188. The previous long-press and playlist-removal takes showed the old
reaction card replaced by #7205 (`2315895fb5`); the previous playlist-start
take predated the three-way prompt. These are historical provenance, not the
source of the refreshed takes. Review each replacement's button label, frost,
back chip and unchanged/changed wall climb against its caption before
converting or publishing.

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
