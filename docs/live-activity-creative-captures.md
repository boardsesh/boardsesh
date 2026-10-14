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
`captureFraming: "full-screen"` requires a genuine locked capture, a recorded
wallpaper description, cleared unrelated notifications and a separately measured
`liveActivityRect`. That rectangle supports source review; it does not crop the
marketing screen or replace native UI.

Earlier cropped-card proofs use exterior-only alpha and remain separate evidence.
New search videos require full-screen Lock Screen fixtures and reject those
cropped or Notification Centre sources. Native pixels are never repainted.

The initial source is TestFlight **2.6.0 (18)** on a real iPhone 13 Pro,
1170×2532 native pixels / 390×844 points, using a real connected development controller presenting as Kilter. Earlier
Notification Centre card proofs establish native navigation; new whole-phone
captures must separately prove the actual Lock Screen.
The build's source commit is unknown; its provenance does not claim that it is
the recorder's current `main` commit. This proves native queue navigation outside
the app, not physical wall illumination. Native widget controls/counts can remain
English even when the app is in Spanish, French or German. Record the actual
`widgetLocale`; never translate the native pixels or duplicate an English
capture under another app locale.

## Regenerate locally

1. Install the supported Boardsesh TestFlight build on a connected iPhone. Use
   the authorized recording account; keep credentials and original screenshots
   in a private temporary directory. Select the intended app language and verify
   it in the app before each locale capture. Set a suitable real photo or native
   stock wallpaper through iOS; never replace the background in an image editor.
2. Verify the recording device's queue before starting a session. Use an empty
   recording queue, or retain a complete private backup and a verified restoration
   procedure for its ordered items, current item and board. Select the actual
   target board and start a private recording session. Save its exact session
   reference privately. Add real climbs without clearing an existing queue.
   Connect the approved development controller. Previous/Next must appear on
   the genuine Live Activity; a disconnected card is not proof of outside-app
   navigation.
3. Dismiss unrelated notifications and accept Live Activity permission before
   recording. Lock the phone, keep its screen awake, and save a complete native
   **PNG** showing the clock, wallpaper and full Live Activity. Confirm Next
   changes the native climb/thumbnail/count while the phone remains locked.
   Reject permission prompts, partial redraws and unrelated notifications.
4. Measure the full screen and Live Activity separately in native pixels. A
   two-line climb name may increase the card height, so do not reuse coordinates
   blindly. Verify locked state, native before/after changes and each app locale
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
   Focus settings, and verify any pre-existing queue against its complete backup.

Starting or ending a session can replace or clear the device's saved solo queue.
The Queue sheet's History rows belong to that same queue; logged sends and
attempts are separate records. A displayed total, a saved board selection, or an
active session identifier does not establish that the original queue survived.
If its ordered items and current item cannot be verified, report preservation as
unverified and stop further queue changes. Keep queue backups and session
references private; they do not belong in the committed screenshot manifest.

The full-screen importer preserves the original PNG without cropping, resizing,
alpha extraction or re-encoding. It computes the hashes and checks dimensions,
identity and reviewed context. Use `--output-root <private-directory>` to review a
candidate before replacing committed fixtures. A reviewer must verify the review
statements; passing JSON validation cannot establish that a capture is genuine.
The separate legacy card importer only removes exterior wallpaper alpha.

Example provenance for a reviewed English Kilter Lock Screen (replace timestamps,
reviewer and measured bounds with the actual capture):

```json
{
  "boardFamily": "kilter",
  "appLocale": "en-US",
  "widgetLocale": "en",
  "captureSurface": "lock-screen",
  "captureFraming": "full-screen",
  "device": "iPhone13Pro",
  "sourceBuild": "TestFlight2.6.0(18)",
  "appSourceCommit": null,
  "capturedAt": "2026-10-14T06:30:00Z",
  "nativePixels": { "width": 1170, "height": 2532 },
  "screenPoints": { "width": 390, "height": 844 },
  "cropRect": { "x": 0, "y": 0, "width": 1170, "height": 2532 },
  "lockScreenContext": {
    "wallpaper": "iOS stock Astronomy Earth",
    "deviceLocked": true,
    "unrelatedNotificationsDismissed": true,
    "liveActivityRect": { "x": 30, "y": 714, "width": 1110, "height": 435 }
  },
  "content": {
    "climbName": "Orestes",
    "grade": "7b+/V8",
    "currentIndex": 261,
    "totalClimbs": 262,
    "nextEnabled": true
  },
  "controller": {
    "connection": "real-ble",
    "presentedBoardFamily": "kilter",
    "description": "Development controller presenting as Kilter",
    "physicalWallLightingVerified": false
  },
  "review": {
    "reviewedAt": "2026-10-14T06:35:00Z",
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

Tension and MoonBoard retain their existing capture contracts until matched
native footage is reviewed. A Kilter development controller is not proof that
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
has settled. Reject blank frames and missing title/count/control pixels. For
video, preserve timestamps and document any rejected captures and nearest clean
native-frame holds during conversion to 30 fps. Keep the observed Next action
and resulting native climb change; do not repair UI pixels or invent state.
