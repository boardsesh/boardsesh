# Spray wall LED setup (MVP)

Edit an existing spray wall and expand **LEDs**, immediately above **More options**.
Enable LEDs to show the WLED address and setup controls. This first version supports
one surface with one WLED controller. The saved setup links detected holds to
holes and their wired LEDs for the app's normal route lighting controls.

Anyone who can edit the wall sets this up once and it is saved to the wall, so
every signed-in climber who can open the wall lights it from their own phone. See
[Where the setup lives](#where-the-setup-lives).

## Using it

1. Enable LEDs and enter the controller's base address, such as `http://wled.local`.
2. Tap **OK** to check the connection. A successful check saves the address to
   the wall and shows the device name and LED count. It does not change the
   lighting.
3. If the controller is offline or does not return a WLED response, choose
   **Keep address anyway** to save it. Invalid URL syntax, or an address that is
   not on a local network, must be corrected.
4. After a successful check, **Light all LEDs** sets the entire configured strip
   to solid white at 25% brightness. **Turn LEDs off** ends the test.
5. **LED setup** opens the T-nut setup: choose grid, offset grid or custom spacing.
   For offset grids choose whether the top row starts inset. Match four rings to
   the grid's outer corners, then set rows and columns (8 × 8 initially, 1–50 rows and up to 99 offset columns). The preview updates as the rings move. Count every distinct vertical position for offset columns: 8 + 7 holes means
   15 columns. Existing saved counts migrate without moving any holes. Missing
   outer corners remain imaginary grid positions.
6. Continue to correct the holes. Choose **Add**, **Move** or **Remove** before
   editing. No editing tool is active when this screen opens. Move drags an
   existing mark without changing its identity. Custom spacing starts here with
   an empty image. Undo reverses manual edits.
   Returning to the grid preserves manual edits unless its parameters change.
7. Continue to save the holes to the wall and choose LEDs in, behind or below
   the hold. Next opens the LED editor: choose Add, Move or Remove to edit
   individual positions with the same full-width, zoomable, fullscreen photo.
   Adding or removing a position asks before clearing existing cable paths and
   skipped counts; cancel keeps the layout, and Undo restores confirmed edits.
   Its tools also start inactive. Orange rings mark holes and purple
   dots mark LEDs, including coincident positions. Below shifts by half a row in
   the calibrated grid plane, then projects through its homography. Behind the
   hold uses two positions one tenth of a column spacing to either side. Custom
   hole layouts estimate spacing from the median nearest-neighbor distance
   (single-hole fallback: 10% of the normalized frame). Generated
   positions outside the image are omitted. Manual edits stay within the image.
8. Choose horizontal, vertical or custom cable layout. Horizontal/vertical ask
   for one of four start corners and generate a single serpentine run. Custom
   starts with no cable. Both continue to **Skip the first LEDs** before wiring.
   Enter the unused physical LED count before the first marked position. Zero
   starts at physical index 0. The count is separate from gaps between positions.
9. In the cable editor, choose **Lay cable**, then tap LEDs or drag across them.
   New LEDs append to the existing cable end in stroke order. Revisiting a wired
   LED does not branch, reverse or create another start. After an explicit cut,
   drawing extends the last cable section. Choose **Select two LEDs** to cut a
   connection, reconnect free endpoints or edit the skipped LED count between
   adjacent positions. Set that count to zero to remove the gap. Orange marks
   show holes, purple marks LEDs, turquoise lines the cable and red markers the
   skipped LEDs. Direction arrows, numbered positions and highlighted selections
   make the order visible. Undo restores edits. **Light selected LEDs** is an
   optional physical preview of the selected positions using their assigned
   WLED indices, including initial and intermediate skips.
10. Next opens **Test LEDs**. Switch between **Holes** and **Holds**, then tap the
    photo to select positions. **Light selection** tests their assigned LEDs.
    Tap a selected position again to remove it. The page reports holds linked
    to wired LEDs and selected positions with no LED assignment. These controls
    also work in the zoomable fullscreen photo. Light the full strip or start a quick
    row-by-row test of wired positions from the upper left. Every row starts on
    the left, regardless of the cable's serpentine order. Unwired positions do
    not participate. **Stop lighting** ends the test. These controls require
    enabled LEDs and a saved WLED address. Indices outside the controller's LED
    count produce an error rather than addressing a different LED.
11. Done saves positions and wiring to the wall. Partial wiring can be saved.
    Its status reports connected LEDs and separate cable sections. The assigned
    zero-based indices include skipped LEDs. The normal wall controls use the
    saved setup to illuminate routes after you deliberately take the wall.

## Hold mapping and route lighting

Hole positions are normalized in the rectified wall frame. Matching converts
them into canonical pixels, where the detected holds already live. Every hole
inside a hold outline belongs to that hold. Without a valid outline the stored
hold radius is used. Overlaps resolve by normalized center distance, then hold
ID. A large hold can own several holes. Holes outside a hold remain unassigned.

Generated LEDs retain their hole association when moved. Older generated IDs
recover their original positions. Manual LEDs bind to nearby placement slots
within a bounded distance. Complementary positions use the nearest opposite-phase
slots and retain their original positions after movement. Physical indices use
the saved cable order, initial skips and gaps. Unwired positions have no index.

Enable LEDs, finish setup and take the wall through the usual lightbulb control.
Routes illuminate their mapped LEDs using the existing start, hand, foot and
finish colors, including saved color overrides. Route playback and creator
previews use the same wall sender. All used holds must have wired LED mappings.
An incomplete or stale setup produces an error instead of confirming the route.
The setup photo identity must match the current canonical frame and calibration.
Mirrored spray routes are rejected because the wall has no defined mirror map.

Spray LEDs follow the Bluetooth boards: locking the phone or backgrounding the
app leaves the climb lit, and a write that fails while away is retried on
return. Releasing the wall, another climber taking it and switching boards let
go without touching the lights. Clear, account changes and access withdrawal end
the owned lighting session and turn the LEDs off. Changes to the saved layout or
controller settings clear the old session and refresh the next route write. A
controller acknowledgement
is required before the existing wall-presence flow reports a successful write.
The setup test remains white and can take control of the same serialized lane.

Offset grids also offer **Complementary positions**: LEDs occupy the opposite
phase of the staggered hold grid, as in CRUX. The diagram follows the chosen
top-row inset. Switching to grid or custom clears this offset-only choice;
the three common placement choices remain available for every wall pattern.
LED positions and cable paths are stored alongside the placement choice.

## Wall image and coordinates

The alignment photo fills the available editor width. Use two fingers to pan and
pinch to zoom in every editing mode. When zoomed, dragging blank space with one
finger pans without moving a point or extending the cable. The expand icon opens
the same editor across the whole screen.
Fullscreen follows device rotation, and closing it preserves all corner edits.
Its compact tool rail keeps editing controls and legends beside the photo.
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
identity is the canonical dimensions and homography. A hold edit publishes a new
wall version on the same photo and mapping, so it keeps the LED setup; hole-to-hold
mapping is recomputed on each send. A changed identity starts a new setup while
preserving the previous saved setup until the user explicitly continues. Layout
data is saved separately from the WLED connection settings, so neither editor can
overwrite the other. LED and cable work is written as each step from LED positions
onward closes, so a killed app keeps it. Earlier steps wait until the holes are confirmed, and unsaved changes are
protected on leaving the flow. Rebuilding LEDs asks first when it would replace
hand-placed LEDs or a cable path.
The generated LED offsets remain editable estimates.

These settings save immediately, separately for each wall. Turning the setting
off hides the remaining controls and retains the saved controller URL.
An unconfirmed address draft is not saved on leaving the screen. Disabling LED
support stops an owned route-lighting session. Use **Turn LEDs off** to turn off
a running setup test.

## Where the setup lives

The server is the source of truth and the phone keeps a copy. A wall has one
row in `spray_wall_led_setups`, keyed on `user_boards.id` (`board_id`, cascade),
holding the controller type, the controller address, the enabled switch, the
T-nut layout JSON and `updated_at`. It has no column that names a user, so it is
not in the account-deletion or user-reference catalogs, and it is not in the
public board snapshot export. GraphQL: `sprayWallLedSetup(boardUuid)` and
`saveSprayWallLedSetup(input)`.

**Who can do what.** A signed-in climber who can read the wall gets its setup,
by the same rule as `sprayWall(uuid)` (`sprayBoardRowIsReadable`, with the uuid as
a capability: the owner, a gym member, or anyone on a public or unlisted wall).
Signed out is refused with an error rather than null, because the phone reads null
as access withdrawn and erases its copy. Saving follows Edit board (`canEditBoard`:
the owner, a gym admin, or a community leader), on an unarchived wall. The edit
screen shows the section and the setup route opens for those people. Anyone else
who can read the wall still gets the setup, so the usual lightbulb lights it for
them too.

**Local addresses only.** Until now an address was only typed on the phone that
used it. Now one person's value reaches other climbers' phones, so an address
must be on a local network: private or link-local IPv4 (`10/8`, `172.16/12`,
`192.168/16`, `169.254/16`), IPv6 unique-local or link-local (`fc00::/7`,
`fe80::/10`), or a `.local`,
`.lan`, `.home`, `.home.arpa` or `.internal` name. `normalizeLocalControllerUrl`
in `@boardsesh/led-controller` is the one check. The server runs it on every save,
and the WLED driver runs it again before contacting anything, so an address from
the server never gets further than this check. Public addresses, public hostnames,
credentials, queries and fragments are refused.

**Offline.** A read answers from the copy when there is one and refreshes behind
it, so a phone on a wall's Wi-Fi with no internet lights the wall without waiting
for the backend to give up. With no copy it waits for the backend. One request
per wall covers every reader, with a 10 minute freshness window (30 seconds after
a failure). When the server's copy really differs from the phone's, the copy is
replaced and `notifySprayLedConfiguration` blanks and relights the wall; a no-change
refresh fires nothing. Reading the setup only ever touches the backend. The first
LAN request still has to follow a climber's press.

**Saves** write the copy, then upload. One upload runs per wall at a time and it
reads the newest copy when it goes, so step saves collapse and cannot land out of
order. A failed upload shows the normal save error, stays marked unsent on the
phone, and retries on the next load; while unsent the phone's copy wins over the
server's. A setup that exists only on this phone (from before this shipped) is
uploaded once if the wall has no row and this viewer owns the wall. Server
merges, local saves and upload acknowledgements share a cache write lane.
A newer save keeps its unsent marker until its own upload succeeds. The cached
copy is cleared at sign-out and when wall access is withdrawn; erasure waits
for outstanding disk writes and prevents old saves from uploading afterwards.

## Controller boundary

`@boardsesh/led-controller` owns URL validation and transport, with a driver registry
and `probe`, `lightAll`, `turnOff` and `createPreview` operations. The preview
transport accepts physical LED indices and optional RGB colors through `show`, plus full-strip and off
commands. Serialized preview sessions prevent overlapping animation commands, including the
settings screen’s full-strip test and explicit off command. A deliberate off
command clears the controller even when that screen has not lit it; cleanup
only stops lighting still owned by that screen.
Add future systems as drivers,
then extend the versioned settings discriminator and provider selection UI. The
editor does not contain WLED request payloads. No backend proxy is needed: requests
originate on the phone/browser in the controller's LAN. Controller URLs are stored
only in the wall's LED setup: never in shared board metadata or analytics, and the
server never contacts them.

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
controller-specific mapping is embedded in the UI. Shared geometry owns the
hold-to-hole-to-LED associations, while the driver owns the physical transport.

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
component with a story wall id that stays on the device and sends nothing to the
server, without needing an existing wall.
Open `dev/stories/spray-wall-led-section--setup` in a development build after
signing in; the native app's authentication gate also applies to stories. It can
contact a real WLED device only when you enter its address and press a control.
Use **Edit spray wall** to check full form placement. Testing lights does not
update shared wall metadata.

WLED serves plain HTTP only. Android release builds permit it through
`plugins/with-android-lan-http.js`: on for every host, because Android cannot
allow-list private IP ranges, and off for `boardsesh.com` and its subdomains.
iOS permits local HTTP through ATS local networking and asks for Local Network
access the first time the app contacts the controller. That contact must always
be a climber's press (confirming an address, a test light, taking the wall): never
add a request to app launch or to opening a screen. Android apps targeting SDK 36
get LAN access through the internet permission and must not declare
`ACCESS_LOCAL_NETWORK`. At target SDK 37 it becomes a runtime permission, to be
requested at that same press; a test fails when the target moves. Both platforms
need a native build. Browser mixed-content, CORS
and local-network restrictions can make a reachable controller inaccessible to
the app; a failed test never prevents retaining the address.

All visible strings are in the `boards.sprayLed` and `boards.sprayLedSetup` catalogs for English, German,
Spanish, French and Italian. Validate the driver, storage and component tests,
then the mobile typecheck, mobile suite and native bundle check. Verify on a phone
in light/dark mode and with large text, including offline retention and disabling
then re-enabling after reopening the editor. Run the
`spray-wall-led-setup` backend tests and the `spray-wall-led-sync` mobile tests;
a real run needs a second account to check that a non-owner lights the wall.

The Android pinch guard ignores focal updates after one finger lifts and rebases
on pointer-count changes; the gesture handler can stay active until the final
finger lifts. Canvas gestures never commit point edits per frame. The existing
photo renderer follows the stored photo-to-canonical homography; Android uses an
affine mesh with a 0.5 fitted-pixel error target and a bounded subdivision count.
Higher magnification can expose that existing approximation. No unverified photo
warp correction was introduced.
