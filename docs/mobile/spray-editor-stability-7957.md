# Spraywall hold-editor stability: issue 7957

This change protects consecutive strokes, bounds native SVG path updates, and
checkpoints completed work during continuous editing. The wall dimensions,
eight-times zoom limit, stored outlines and explicit publication flow stay the
same.

## Why these paths changed

Sentry captured an iPad hang after navigation into Edit holds, native SVG parser
and CoreGraphics drawing stalls, and two watchdog terminations preceded by
low-memory warnings. The sampled configuration was iPad14,2, iOS 18.7.8, app
2.8.0 build 2, production OTA
`2b51345e-b8df-3dd1-2942-4286b835bc6f`. Matching configuration does not identify
one physical device or link the events to the reporter.

- [Editor hangs, BOARDSESH-CV](https://boardsesh.sentry.io/issues/7659636505/):
  the November 22, 2026 10:22:53 UTC event followed entry into
  `/boards/spray/holds` and reported 36.8–37.6 seconds fully blocked.
- [Native SVG parsing, BOARDSESH-XN](https://boardsesh.sentry.io/issues/7822270497/):
  the stack enters `RNSVGPath setD` and `RNSVGPathParser`.
- [Watchdog terminations, BOARDSESH-8B](https://boardsesh.sentry.io/issues/7583297108/):
  retained low-memory notifications support memory pressure, but do not prove
  the OS termination was caused by this editor or by an out-of-memory condition.

The code investigation independently reproduced an older stroke's delayed
JavaScript completion clearing the newer stroke's preview buffer.

## Behavior and implementation

1. Each stroke carries its own identity and starting context. Only its owner
   can clear the live preview. Tool, selection and editor-generation changes
   fence callbacks from the older context. Hold insertion and capacity checks
   run against the current synchronous editor state.
2. Spray Trace uses owned raw-pointer input, with the same short-outline refusal
   as before. A drawing contact does not become a tap or two-finger Undo.
   The catalogue editor keeps its existing recognizer.
3. Committed rings and live previews use separate sibling SVG roots. Committed
   paths use stable chunks of at most 32 holds; unchanged geometry and native
   props are reused. Role ordering and the selected ghost remain intact.
4. Inactive magnifier artwork is unmounted. When shown, its spatial index picks
   nearby outlines using their full geometry bounds. Overscan keeps adjacent
   movement visible; live UI-thread coverage prevents stale geometry after a
   fast jump. The immutable wall's grid survives magnifier remounts.
5. Completed work still saves after 500 ms idle. During uninterrupted edits, a
   checkpoint starts within two seconds of the first unsaved eligible edit
   while JavaScript can run. Storage completion may take longer. The same
   serialized writer handles backgrounding, leaving and publishing.

## Device QA

1. Draw consecutive holds quickly; each outline stays intact.
2. Refine a hold, tap Done, then Redraw; the Pencil draws.
3. Draw continuously, lock the iPad, then reopen; checkpointed work returns.
4. Zoom fully and pan; outlines and live strokes stay aligned.
5. Switch between finger and Pencil input; the magnifier behaves correctly.

Use a physical Release build on an iPad comparable to the reported roughly
4 GB configuration. Compare baseline `7ddf587ee0941ec5960cb0b94724568e79ae1897`
with the candidate, using the same wall photo and outlines. Exercise 530+
holds for ten minutes, then stress a 1,500-hold wall. Capture frame time,
gesture-onset latency, peak/retained memory, low-memory notifications, and
termination reports. Include 1×, 4× and 8×, with the full-resolution photo
loaded and with the magnifier active.

Automated geometry, scheduler and mocked-native-prop tests establish bounded
updates and ownership. Browser previews and Linux bundle checks do not establish
native frame time, peak memory, palm rejection, or freedom from OS termination.
Keep those claims open until physical-device evidence is available. Deep-zoom
line disappearance also needs a native reproduction; the zoom limit has not
been reduced to hide it.

[Phone and tablet browser rendering captures](screens/images/spray-editor-stability-7957/README.md)
record the real component previews and their verification limits.
