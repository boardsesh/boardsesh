# Spray wall LED setup (MVP)

Edit an existing spray wall and expand **LEDs**, immediately above **More options**.
Enable LEDs to show the WLED address and setup controls. This first version supports
one surface with one WLED controller. It does not illuminate climbs or map holds yet.

## Using it

1. Enable LEDs and enter the controller's base address, such as `http://wled.local`.
2. Tap **OK** to check the connection. A successful check saves the address and
   shows the device name and LED count. It does not change the lighting.
3. If the controller is offline or does not return a WLED response, choose
   **Keep address anyway** to save it. Invalid URL syntax must be corrected.
4. After a successful check, **Light all LEDs** sets the entire configured strip
   to solid white at 25% brightness. **Turn LEDs off** ends the test.
5. **LED setup** opens the T-nut setup: choose grid, offset grid or custom spacing.
   For offset grids choose whether the top row starts inset. Match four rings to
   the grid's outer corners, then set rows and columns (8 × 8 initially, 1–50 rows and up to 99 offset columns). The preview updates as the rings move. Count every distinct vertical position for offset columns: 8 + 7 holes means
   15 columns. Existing saved counts migrate without moving any holes. Missing
   outer corners remain imaginary grid positions.
6. Continue to add missing holes or remove unwanted ones by tapping the wall.
   Custom spacing starts here with an empty image. Undo reverses manual edits.
   Returning to the grid preserves manual edits unless its parameters change.
7. Continue to save the holes on this device and choose LEDs in, behind or below
   the hold. Next opens the LED editor: add/remove individual positions with the
   same full-width, zoomable, fullscreen photo. Orange rings mark holes and purple
   dots mark LEDs, including coincident positions. Below shifts by half a row in
   the calibrated grid plane, then projects through its homography. Behind the
   hold uses two positions a quarter of a column spacing to either side. Custom
   hole layouts estimate spacing from the median nearest-neighbor distance
   (single-hole fallback: 10% of the normalized frame). Out-of-image generated
   positions are omitted rather than clamped onto an edge; manual edits stay valid.
8. Choose horizontal, vertical or custom cable layout. Horizontal/vertical ask
   for one of four start corners and generate a single serpentine run. Custom
   opens an empty cable editor directly. Drag across LEDs to join free cable ends;
   use Move image for panning and pinch in any mode. Select two connected LEDs to
   cut their edge or insert skipped physical LED numbers; select free endpoints
   to reconnect sections. The preview shows direction arrows, highlighted
   selections and dashed gap segments with diamond markers. Undo restores edits.
9. Done saves positions and wiring on this device. Partial wiring can be saved;
   its status reports connected LEDs and separate cable sections. The assigned
   zero-based indices include skipped LEDs. No climb illumination or automatic
   hold-to-hole associations are activated by this setup.

Offset grids also offer **Complementary positions**: LEDs occupy the opposite
phase of the staggered hold grid, as in CRUX. The diagram follows the chosen
top-row inset. Switching to grid or custom clears this offset-only choice;
the three common placement choices remain available for every wall pattern.
LED positions and cable paths are stored alongside the placement choice.

## Wall image and coordinates

The alignment photo fills the available editor width. Pinch to zoom and drag the
zoomed image to pan; the expand icon opens the same editor across the whole screen.
Fullscreen follows device rotation, and closing it preserves all corner edits.
The shared `SprayPhotoStage` is the default for setup-photo editors, backed by
`SprayPhotoCanvas` for gestures. Use it for future setup images. Zoom changes only
the viewport. Dashed, translucent guides and fixed-size handles
keep the holes visible at higher magnification. Rotation refits the viewport
without changing wall coordinates.

With one row only the two upper anchors are active; with one column only the two
left anchors are active. A 1 × 1 grid uses the upper-left anchor alone. Hidden
anchors retain their positions when rows or columns are restored. A single offset row uses endpoints of the complete column grid; either
endpoint may be imaginary depending on parity and the selected first-row phase. A single column has no offset.

Fullscreen is an authenticated root `transparentModal` with an opaque canvas,
avoiding `fullScreenModal` over the iOS native tabs. Its temporary session stays
in memory and closes with the owning editor; route parameters never contain the
photo URL. iPhone landscape support requires a native build with the updated
orientation mask; ordinary iPhone screens keep their portrait orientation.

Both the grid calibration and the manual editor use the existing **Wall only**
photo transformation (`FlattenedSprayPhoto`), with no hold outlines or generated
background. The published photo-to-wall homography rectifies the photo into its
canonical frame. Android uses the existing affine mesh approximation; iOS/web
use the perspective matrix. The photo comes from the managed private-wall cache.
This reuses the wall's stored calibration; it cannot recover missing calibration
from an uncalibrated photograph (an identity homography remains identity).

T-nut coordinates are normalized in that same rectified frame, never in the raw
photograph. The grid uses a second projective transform from the unit grid to the
four selected anchors, and updates on the UI thread while dragging. The saved
identity includes the immutable wall version, canonical dimensions and homography.
A changed identity starts a new setup while preserving the previous saved setup
until the user explicitly continues. Layout data has a separate local storage key
from WLED connection settings. Unsaved changes are protected on leaving the flow;
the setup does not yet associate detected holds with holes. Generated LED offsets
are editable estimates, not recognition results.

These settings save immediately on this device, separately for each wall. Turning
the setting off hides the remaining controls and retains the saved controller URL.
An unconfirmed address draft is not saved on leaving the screen. Disabling LED
support is a configuration change; it sends no hardware command. Use **Turn LEDs
off** to turn off a running test.

## Controller boundary

`@boardsesh/led-controller` owns URL validation and transport, with a driver registry
and `probe`, `lightAll` and `turnOff` operations. Add future systems as drivers,
then extend the versioned settings discriminator and provider selection UI. The
editor does not contain WLED request payloads. No database migration or backend
proxy is needed: requests originate on the phone/browser in the controller's LAN.
Controller URLs do not enter shared board metadata, analytics or server requests.

The WLED implementation uses the official
[JSON API](https://kno.wled.ge/interfaces/json-api/): read-only `GET /json/info`
for checks and `POST /json/state` for explicit lighting commands. Requests are
bounded by timeouts and cancelled on edits, collapse, disable and unmount.
Manufacturer-branded WLED firmware, including Athom, is supported; the connection
check validates the API fields rather than requiring the default WLED brand name.
Success requires a valid WLED response or command acknowledgement. A physical
light change still needs device QA.

The design follows the separation used in
[CRUX WLED Bridge](https://github.com/Spikeystrike/cruxwledbridge): a hold, a wall
hole and a physical LED are different things. No CRUX source was copied, and no
mapping is guessed in this MVP. Later setup can add those layers without changing
the controller transport.

The lighting test requires a **1D WLED strip configuration**. It covers the
configured LED count, resets segment 0 to the full cable, and puts existing
segments into solid white with no grouping, spacing, offset or freeze. This
replaces live effects, segment transforms and brightness; it does not restore the
previous light state. It does not save/delete presets or write `/json/cfg`.
Firmware-level LED maps and 2D matrices are outside this MVP.

Existing spray-wall BLE capabilities and `user_boards.has_leds` remain unchanged.
This is independent LAN setup, not a claim that spray walls speak Aurora BLE.

## Testing a contribution on Android

Follow [the contributor workflow](../CONTRIBUTING.md#contributing-to-the-mobile-app-react-native).
The mobile app defaults to the official Boardsesh backend for day-to-day
contributor development, as documented in
[`packages/mobile/.env.example`](../packages/mobile/.env.example). Use your own
Boardsesh account. A GitHub fork used to submit a contribution does not by itself
require changing those development defaults.

For isolated testing, run the local development stack and set the backend URL
overrides from that template. The seeded `test@boardsesh.com` / `test` account
belongs to the local development database, not the hosted service. Separately
distributed apps remain subject to [the hosted-service policy](../LEGAL.md#hosted-service--api-access).

The dev-only component story `spray-wall-led-section--setup` exercises this same
component with a separate local settings key, without needing an existing wall.
Open `dev/stories/spray-wall-led-section--setup` in a development build after
signing in; the native app's authentication gate also applies to stories. It can
contact a real WLED device only when you enter its address and press a control.
Use **Edit spray wall** to check full form placement. LED settings stay on the
current device; testing lights does not update shared wall metadata.

Android development clients allow HTTP traffic for Metro/local development.
Verify the actual installed build with the controller: a release build may
restrict cleartext HTTP. Supporting arbitrary local HTTP controllers in release
builds needs a deliberate native network policy and a new binary; this change
does not silently relax that policy. On iOS, local-network permission and ATS
configuration likewise need a native-build check. Browser mixed-content, CORS
and local-network restrictions can make a reachable controller inaccessible to
the app; a failed test never prevents retaining the address.

All visible strings are in the `boards.sprayLed` and `boards.sprayLedSetup` catalogs for English, German,
Spanish, French and Italian. Validate the driver, storage and component tests,
then the mobile typecheck, mobile suite and native bundle check. Verify on a phone
in light/dark mode and with large text, including offline retention and disabling
then re-enabling after reopening the editor.

The Android pinch guard ignores focal updates after one finger lifts and rebases
on pointer-count changes; the gesture handler can stay active until the final
finger lifts. Canvas gestures never commit point edits per frame. The existing
photo renderer follows the stored photo-to-canonical homography; Android uses an
affine mesh with a 0.5 fitted-pixel error target and a bounded subdivision count.
Higher magnification can expose that existing approximation. No unverified photo
warp correction was introduced.
