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

## Converting

```
vp run help:convert-clips -- --allow-partial
vp run generate:static-assets
```

The first command writes, per clip:

| Output | Settings |
| --- | --- |
| `packages/web/public/videos/help/<name>.mp4` | libx264, crf 24, preset slow, yuv420p, 30 fps, 736 px wide, `+faststart`, no audio |
| `packages/web/public/videos/help/<name>.webm` | libvpx-vp9, crf 34, `-b:v 0`, row-mt, same scale, no audio |
| `packages/web/public/images/help/clips/<name>.webp` | first trimmed frame through Sharp — `height: 1600`, `quality: 87`, `effort: 6`, identical to `help:convert-shots` |

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
