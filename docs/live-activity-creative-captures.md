# Native Live Activity capture fixtures

The default iPhone listing and matched iPhone CPPs reuse reviewed physical-device
Live Activity captures. CI reuses those pixels; it does not attempt to start or film
ActivityKit. Their nine framed screenshots still ship on the requested App Store
canvas (1206×2622 or 1320×2868). A card captured on an iPhone 13 Pro is never
described as a native iPhone 16 Pro screenshot.

Fixtures live in `app-stores/apple/live-activity-captures/`. `manifest.json`
records each fixture's SHA-256, original full PNG SHA-256 and measured rectangles,
physical device and native screen size, installed build, board/controller family,
capture surface, actual app and widget languages, and visual review. Only reviewed
full screens with unrelated notifications dismissed enter the repository. Raw
accessibility dumps, credentials and rejected screenshots remain private.

Full-screen fixtures retain the entire original native PNG byte-for-byte,
including its clock, wallpaper, controls and Live Activity. Their source and
fixture hashes must match, and `cropRect` must cover the complete native screen.
`captureFraming: "full-screen"` requires the actual native Lock Screen or
Notification Center, a recorded wallpaper description, cleared unrelated notifications and a separately measured
`liveActivityRect`. That rectangle supports source review; it does not crop the
marketing screen or replace native UI.

Earlier cropped-card proofs use exterior-only alpha and remain separate evidence.
New search videos require full-screen fixtures and reject cropped-card sources.
Their capture surface stays explicit: `lock-screen` uses `lockScreenContext`,
while `notification-center` uses `notificationCenterContext`. Never infer device
authentication from WDA's locked flag: Notification Center can report locked while
covering an already authenticated app. Native pixels are never repainted.

The initial source is TestFlight **2.6.0 (18)** on a real iPhone 13 Pro,
1170×2532 native pixels / 390×844 points, using a real connected development controller presenting as Kilter. Earlier
Notification Center card proofs establish native navigation; new whole-phone
captures retain the native clock, wallpaper, controls and full activity.
The build's source commit is unknown; its provenance does not claim that it is
the recorder's current `main` commit. This proves native queue navigation outside
the app, not physical wall illumination. Native widget controls/counts can remain
English even when the app is in Spanish, French or German. Record the actual
`widgetLocale`; never translate the native pixels or duplicate an English
capture under another app locale.

Record the actual board layout, size, hold sets and angle, matching the preceding
scene wherever its configuration is known. Keep the board family and queued
climbs consistent; do not infer historical settings from catalogue defaults.
The current Kilter/default crew scenes use Kilter
Homewall 10×12 Full Ride: layout 8, size 25, sets 26/27/28/29, at 35°.
Their queue continues from **Lightest Pair of Shorts** to **Guessing Games**.
The default Kilter Original configuration contains a different climb catalogue.
The Tension capture uses the saved High Point Climbing Orlando Tension board:
layout 10, size 6, sets 12/13, at 40°. Its fresh private queue continues from
**Masquerade** to **Putty**; the native card retains its actual grade formatting.

## Future recording runs: one capture per target

Capture Live Activity footage and its full-phone still **once per target**, then
reuse those genuine native pixels across localized creatives. Localize the
surrounding copy and ordinary app scenes; do not repeat the slow physical-device
capture for every output locale. Keep the source app/widget language recorded
honestly and separate from the creative's output language. Never relabel a source
capture as another app locale.

This is the policy for the next recording run. The current run finishes its
already planned separate locale takes. Before the next run, update the fixture
selection and provenance contract to support shared source captures explicitly;
the current renderer still requires a matching fixture for each app locale.

## Regenerate locally

1. Install the supported Boardsesh TestFlight build on a connected iPhone. Use
   the authorized recording account; keep credentials and original screenshots
   in a private temporary directory. Select the intended app language and verify
   it in the app before each locale capture. Set a suitable real photo or native
   stock wallpaper through iOS; never replace the background in an image editor.
2. Verify the recording device's queue before starting a session. Use an empty
   recording queue, obtain explicit permission to replace the recording account's
   local queue, or retain a complete private backup and a verified restoration
   procedure for its ordered items, current item and board. Queue replacement
   does not authorize deleting logged sends or attempts. Select the actual
   target board and start a private recording session. Save its exact session
   reference privately. Add real climbs to the approved recording queue.
   Connect the approved development controller. Previous/Next must appear on
   the genuine Live Activity; a disconnected card is not proof of outside-app
   navigation.
3. Dismiss unrelated notifications and accept Live Activity permission before
   recording. Open the native Notification Center from the authenticated app,
   or record the actual Lock Screen. Save a complete native **PNG** showing the
   clock, wallpaper and full Live Activity. Confirm Next changes the native
   climb, thumbnail and count, and verify the controller receives its LED payload.
   Reject permission prompts, partial redraws and unrelated notifications.
4. Measure the full screen and Live Activity separately in native pixels. A
   two-line climb name may increase the card height, so do not reuse coordinates
   blindly. Record the actual surface, native before/after changes and each app locale
   before supplying the provenance below. Then import it:

   ```bash
   vp exec tsx scripts/import-live-activity-capture.ts \
     --input /private/tmp/native-live-activity.png \
     --provenance /private/tmp/reviewed-live-activity.json
   ```

5. Regenerate the normal screenshot presentation with `vp run mobile:screenshots`
   or `vp exec tsx scripts/frame-screenshots.ts` using that run's raw captures.
   Review the contact sheet and `presentation.json` source provenance. Save the
   capture session's full queue privately before ending it. End only the session
   created for this recording, restore the recording app language and temporary
   Focus settings, and verify any queue retained for restoration against its
   complete backup.

Starting or ending a session can replace or clear the device's saved solo queue.
The Queue sheet's History rows belong to that same queue; logged sends and
attempts are separate records. A displayed total, a saved board selection, or an
active session identifier does not establish that the original queue survived.
If its ordered items and current item cannot be verified, report preservation as
unverified and obtain permission before replacing that queue. Keep queue backups and session
references private; they do not belong in the committed screenshot manifest.

The full-screen importer preserves the original PNG without cropping, resizing,
alpha extraction or re-encoding. It computes the hashes and checks dimensions,
identity and reviewed context. Use `--output-root <private-directory>` to review a
candidate before replacing committed fixtures. A reviewer must verify the review
statements; passing JSON validation cannot establish that a capture is genuine.
The separate legacy card importer only removes exterior wallpaper alpha.

Example provenance for a reviewed English Kilter Notification Center (replace timestamps,
reviewer and measured bounds with the actual capture):

```json
{
  "boardFamily": "kilter",
  "appLocale": "en-US",
  "widgetLocale": "en",
  "captureSurface": "notification-center",
  "captureFraming": "full-screen",
  "device": "iPhone13Pro",
  "sourceBuild": "TestFlight2.6.0(18)",
  "appSourceCommit": null,
  "capturedAt": "2026-10-15T00:12:00Z",
  "nativePixels": { "width": 1170, "height": 2532 },
  "screenPoints": { "width": 390, "height": 844 },
  "cropRect": { "x": 0, "y": 0, "width": 1170, "height": 2532 },
  "notificationCenterContext": {
    "wallpaper": "iOS stock Astronomy Earth",
    "entryFromAuthenticatedApp": true,
    "authenticationState": "not-established",
    "unrelatedNotificationsDismissed": true,
    "liveActivityRect": { "x": 30, "y": 1713, "width": 1110, "height": 438 }
  },
  "content": {
    "climbName": "Lightest Pair of Shorts",
    "grade": "V4",
    "currentIndex": 1,
    "totalClimbs": 2,
    "nextEnabled": true
  },
  "controller": {
    "connection": "real-ble",
    "presentedBoardFamily": "kilter",
    "description": "Development controller presenting as Kilter",
    "physicalWallLightingVerified": false
  },
  "review": {
    "reviewedAt": "2026-10-15T00:35:00Z",
    "reviewedBy": "Actual reviewer",
    "nativePixelsUnmodified": true,
    "unrelatedNotificationsExcluded": true,
    "appLocaleVerified": true,
    "nextNavigationVerified": true
  }
}
```

## Capture and rendering gates

The default campaign no longer requires `17-dynamic-island.png`; the Kilter
phone CPP no longer requires `08-island.png`. Their Live Activity recipes load
the exact reviewed Kilter/app-locale fixture. A missing locale, another board
family, a changed hash, an invalid rectangle or unreviewed provenance stops
framing with an actionable error. The presented sidecar stores the native
fixture identity separately from its output canvas and hash. Full-screen framing
keeps the complete clock, wallpaper and Live Activity visible; no fake Island or
reconstructed lock-screen controls are added.

If a retained default raw directory still contains `17-dynamic-island.png`,
move that obsolete capture outside the input directory before reframing. The
new source contract rejects it as an unexpected image. Likewise, a Kilter phone
raw directory must omit its old `08-island.png`.

The Tension phone CPP's `04-live-activity.png` also requires its own reviewed
Tension fixture in every locale. MoonBoard keeps its logbook story. A Kilter development controller is not proof that
MoonBoard's different BLE protocol works. Spray walls have no native hardware
control capability and receive no Live Activity Next scene. Never substitute a
Kilter card under another family's source identity.

A genuine Tension card can use the approved Kilter-presenting Aurora development
controller after accepting the actual serial mismatch. Keep `boardFamily` as
`tension` and `controller.presentedBoardFamily` as `kilter`. This exception
requires reviewed native Next navigation and received LED payload evidence,
`physicalWallLightingVerified: false`, and explicit controller metadata:

```json
"compatibility": {
  "protocol": "aurora-uart",
  "targetBoardFamily": "tension",
  "serialMismatchAccepted": true,
  "verification": "native-next-and-received-led-payload"
}
```

This describes the controller used to capture Tension's actual native card; it
does not allow a Kilter card to stand in for Tension or MoonBoard pixels. Other
family mismatches and incomplete compatibility evidence remain rejected.

WDA screenshots can contain partial redraws even after an accessibility snapshot
has settled. Reject blank frames and missing title/count/control pixels. Inspect
decoded pixels and contact sheets if an isolated preview appears to lose a header.
For video, select one contiguous reviewed range and resample its original JPEGs
by nearest received timestamp to 30 fps. Preserve genuine transition blur and
the observed timing; never remove interior frames, repair UI or invent state.

The full-phone ending lasts six seconds. Mark the actual first queue change and
the first sharply readable new climb from raw frames as `next-changed` and
`next-settled`. Keep at least 0.4 seconds before the real Next tap and one second
of sharp new state before the final 0.5-second loop transition. A post-stream
accessibility observation or an estimated delay after the tap is not the change
time. CPP videos remain 15 seconds; the default remains 20 seconds.

If Next opens a passcode prompt, reject that take. Authenticate normally outside
the recording and inspect the actual resulting screen and queue before trying
again. A request acknowledgement does not prove a keypad press, an unlock or a
climb change. Stop automated entry if its result is uncertain and ask the device
owner to authenticate; never record the passcode or change security settings to
make a take pass. An authenticated Lock Screen and an unlocked Notification
Centre must retain their actual provenance rather than being labelled as a
continuously locked interaction.
