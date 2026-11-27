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
   Or tap **Find on my Wi-Fi**: the phone asks each address of its own Wi-Fi
   network (a private /24 only, 32 at a time, 1.5 s each, never its own address)
   for WLED's `/json/info`, and lists the controllers that answer by name and
   address in a list of their own. Tapping one checks and saves it as below. On
   mobile data it asks for Wi-Fi instead of scanning. On a Wi-Fi it cannot sweep
   (an IPv6-only, public or CGNAT address, or a VPN) it says no controller was
   found on this network. On a network wider than /24 it searches only the
   phone's own /24. It needs no new native module: the subnet comes from NetInfo.
2. Tap **OK** to check the connection. A successful check saves the address to
   the wall and shows the device name and LED count. It does not change the
   lighting.
3. If the controller is offline or does not return a WLED response, choose
   **Keep address anyway** to save it. Invalid URL syntax, or an address that is
   not on a local network, must be corrected.
4. After a successful check, **Light all LEDs** sets the entire configured strip
   to solid white at the wall's brightness. **Turn LEDs off** ends the test.
   **Brightness** (5–100 %, stored as WLED's 1–255, 25 % by default) and **Turn
   off automatically** (never, 15, 30, 60 or 120 minutes) save to the wall with
   the rest of the setup (`brightness`, `autoOffMinutes` on
   `spray_wall_led_setups`), so every phone lights it the same way. The server
   accepts only those auto-off values. A phone uploads only the one it changed,
   so a stale copy of the other cannot undo another phone's choice. A change
   applies from the next lighting without switching the wall off; a wall lit
   with **Light all LEDs** shows a new brightness at once. Auto-off uses WLED's
   nightlight in instant mode, so the controller switches the wall off by itself
   even when the phone is asleep or gone, and each new route or test restarts
   the countdown. WLED only restarts a running countdown after its 100 ms
   nightlight handler has seen it off, so the driver switches it off, waits a
   tick, arms it again and checks `nl.rem`. A countdown restarted in the last
   minute is left alone, so a tap within a minute of the last restart does not
   extend it: the wall can go dark up to a minute before N minutes after the
   last tap. If the countdown cannot be armed after three tries, the climb stays
   lit and the app logs that auto-off was not set, rather than switching the
   wall off. Both apply over Wi-Fi; over Bluetooth only the brightness does for
   now, because the BLE usermod accepts `nl.on` but not the duration.

   During the rollout, a phone without this update lights the wall at WLED
   brightness 64 and cancels any auto-off (`nl: { on: false }`) every time it
   lights a climb. At a wall with mixed app versions, the brightness resets and
   auto-off stops whenever an older phone lights it, until every phone has
   updated.
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
   With LEDs on both sides of the hold ("sides"), the two LEDs behind each
   hole are a **pair**. Overlapping rings interlock. If the rings are farther
   apart, a thin dashed yellow line links them in **Adjust LED positions**.
   Paired LEDs move and are removed together. Laying the cable through one adds
   the other straight after it. **Pair LEDs** works in the editor and in
   fullscreen. Tap a pair to separate it or tap two single LEDs to pair them.
   LEDs removed from a pair can move or be deleted on their own.
   Pairs are stored as `ledGroups` (`[id, id][]`); with no list, a "sides"
   placement pairs the LEDs it generated per hole, and an explicit empty list
   keeps every pair separated. Rebuilding the LEDs returns to those defaults.
   **LED strip** is available for grid and offset layouts and uses the approved
   continuous-strip diagram. Custom spacing offers the in/behind/below choices.
   Next asks for horizontal or vertical strips and a default LED count
   (20 initially).
   Vertical starts with one strip per calibrated column, horizontal with one
   per row. Each line extends to the rectified photo's boundaries. The next
   photo editor can move either endpoint, change a selected strip's LED count,
   add/remove strips, and add, move or remove individual LEDs. Its tools start
   inactive and use the usual fullscreen icon rail. The limits are 100 strips
   and 6000 LEDs in total. Removing the last LED removes its strip. Changing
   membership/count asks before resetting an existing cable; endpoint moves
   preserve LED identities and the cable. Undo restores the complete layout.
   Confirming a full strip rebuild clears manual hold and T-nut assignments so
   the new strips use automatic mapping. Individual strip edits still prune
   only references that no longer exist.
   Changing the calibrated grid also requires confirming a strip rebuild,
   even when orientation and LED count stay the same. The new strips follow
   the updated rows, columns and anchors. Cancelling keeps the saved setup;
   an unchanged grid retains edited strips, cable and manual assignments.
8. Next opens **Holds and LEDs**. Switch between **Holds** and **T-nuts** to
   choose what to link, then tap LEDs to add or remove them from that selection.
   Several LEDs can belong to the same hold or T-nut. Dashed lines join the LEDs
   to their hold or nut, and red outlines show missing assignments.
   T-nuts already matched to a hold are dimmed but remain selectable. Editing
   one updates the hold too. Manual assignments for mounted holds are stored
   at their nut positions, so subsequently detected holds inherit the local
   assignments even when hold IDs change. A hold can cover several nuts; an
   explicit whole-hold edit distributes its LEDs among those nuts rather than
   copying the entire list to every nut. Editing one nut keeps its siblings.
   **Next hold without LEDs** becomes **Next T-nut without LEDs** in T-nut mode.
   The unassigned LED picker treats a pair as one stop and lights both wired
   members. The hold count and picker include only holds whose centers appear
   in the rectified photo. **Back to automatic** restores the automatic link for
   the selected role; the undo icon restores the preceding edit, also fullscreen.
   **Below the hold** and **Complementary positions** have two consecutive
   assignment steps: the main LEDs below, then the optional LEDs above. Editing
   or resetting one step leaves the other role alone. Other placements keep one
   step. Before the cable exists the LEDs have no physical index, so the wall
   only lights selections after wiring (when returning to these steps).
   Increasing the grid with the same LED pattern adds unwired positions and keeps
   the existing cable path and physical indices. If manual LED work or unmatched
   wired positions need checking, the setup prompts you to review the LED positions.
   Starting the LED positions over clears the old links. Removing a single LED
   prunes its manual links immediately, so
   adding another LED cannot inherit a deleted position’s links. Undo restores
   the previous positions and links. A failed preview shows an error; select
   the hold again or tap **Try again** to retry.
9. Choose horizontal, vertical or custom cable layout. Horizontal/vertical ask
   for one of four start corners and generate a single serpentine run. Custom
   starts with no cable. Both continue to **Skip the first LEDs** before wiring.
   Enter the unused physical LED count before the first marked position. Zero
   starts at physical index 0. The count is separate from gaps between positions.
   Returning from the cable editor refreshes this field from the current cable,
   including Undo, so Back and Next preserve its physical indices.
10. In the cable editor, choose **Lay cable**, then tap LEDs or drag across them.
   New LEDs append to the existing cable end in stroke order. Revisiting a wired
   LED does not branch, reverse or create another start. After an explicit cut,
   tap the output end of the section you want to extend, then tap new LEDs or
   drag from that end. Either member of an output pair, or any member of an
   output strip, selects that whole unit. A larger purple ring marks the chosen
   output. The final cable end remains the default when no section was chosen.
   To reconnect a cut, tap its upstream output and then the downstream section's
   input, or drag between them. This also works after adding more LEDs before
   reaching that input. The sections join in their saved direction, retaining
   internal skipped LEDs. The new connection has no skipped LEDs until edited.
   Pairs and strips join as whole units; each join has its own Undo step. A tap
   can join a section consisting of only one unit; dragging from that unit
   still chooses its output. The controller input and interior LEDs cannot be
   joined this way, and a later section cannot be routed back into an earlier one.
   **Lay cable** stays available with
   a complete route. To reroute already wired LEDs, choose **Select two LEDs**
   to cut the connection between two selections or reconnect free endpoints.
   Either member selects both LEDs of a pair, and the pair counts as one selection.
   The editor uses physical connections at the boundaries between selections.
   **Light and tap** is available while some LEDs are still unwired. Tapping a
   pair adds its unwired LEDs in sequence after the controller confirms their
   physical numbers. The lit number advances by one per added LED. Skips
   count before the first added LED and respect the gap and total limits.
   If the controller cannot light both LEDs of an unwired pair, the current
   number stays available. Undo removes the entire addition together.
   **Not on the spraywall** counts as its own Undo step, even before the first
   position is assigned. Leading skips update **Skip the first LEDs** immediately
   without drawing a cable segment. Between positions, the pending count stays
   available until the next assignment; the resulting gap is red in **Light and
   tap**, as on **Skipped LEDs**, including after the cable is complete. Undoing
   the assignment restores its pending count; another Undo reverses the skip.
   Cutting off the last LED or unit makes it unwired again, ready to place
   anywhere on the cable. The upstream start stays wired even if it is the only
   position left. An interior cut retains both sections. Extending an earlier
   section preserves section order and gap counts; later physical indices move
   forward by the number of newly inserted LEDs. Undo restores the full edit.
   Purple dots mark LEDs and faint orange
   rings mark holes. Turquoise lines show the cable and arrows show its direction.
   When both members of a pair follow one another on the cable without a skip
   between them, incoming and outgoing lines meet at the pair's midpoint.
   Each LED has its own physical number. New automatic paths visit both
   members consecutively, and saved paths keep their physical order.
   A green ring and green arrow mark the start. A turquoise ring marks the end
   where laying continues. A red ring marks a loose end. Skipped LEDs are shown on
   the next step and still count toward the cable's physical LED numbers.
   A selected LED gets a larger purple ring, and the selection
   is listed below the photo by cable position (for example 3 → 4). Undo
   restores edits, keeping both LEDs of a pair together when laying cable.
   A drag across several pairs can be undone one pair at a time.
   Cable and skip Undo share their history throughout this setup session, so
   Next and Back keep earlier edits reversible, including the first position.
   Rebuilding the cable or changing LED membership starts a new history.
   Open the cable editor fullscreen in portrait or landscape.
   In landscape, the controls sit to the right of the photo.
11. Next opens **Skipped LEDs**, with the cable drawn over the photo. Tap a
    connection to select it. The photo rings the LEDs at both ends, including
    both members of any pair. The page shows the physical LED numbers at the
    connection and its skipped count. **Insert skipped LEDs** sets how many
    LEDs the strip has there off the wall. Type the count or use − and +.
    Zero removes the gap. Selecting the connection lights the wired LEDs at
    both ends so you can check the count against the wall. Use the bulb to
    turn that lighting off or on. Skipped LEDs and their connections appear
    in red on the photo. Undo restores edits.
12. Next opens **Test LEDs**. Switch between **Holes** and **Holds**, then tap
    one position on the photo. Tapping another replaces the selection. Tap the
    same position again to clear it. The bulb starts enabled so selecting a
    position lights it. Tap the bulb to switch selection lighting off or on.
    The page counts holds linked to wired LEDs and flags a selection with no
    LED assignment. These controls also work in the zoomable fullscreen photo.
    In the regular view, **Light all wired LEDs** lights the wired positions
    visible in the photo. The row-by-row test uses the same positions and starts
    every row on the left. LEDs outside the photo, unwired positions, and skipped
    LEDs stay dark. The summary counts the lit positions and the photo rings
    them. During the row test, the ring follows the LED being tested. The bulb
    stops a running test. These controls require enabled LEDs and a saved WLED
    address. The app reports an error when a position uses an index outside
    the controller's configured range.
13. Done saves positions and wiring to the wall. Partial wiring can be saved.
    Its status reports connected LEDs and separate cable sections. The assigned
    zero-based indices include skipped LEDs. The normal wall controls use the
    saved setup to illuminate routes after you deliberately take the wall.

For **LED strip**, the cable tools treat every strip as an indivisible ordered
unit. Tap or trace any member to add the complete strip, entering at the nearer
end. Undo removes the complete addition. Automatic cable paths visit every
member consecutively and may reverse a complete strip to enter its nearer end.
Select two strips (or a strip and a single LED) to cut/connect their boundary;
there is no cut or skipped-LED gap inside a strip. **Light and tap** validates
all consecutive physical indices before saving the unit. If its last index
exceeds the controller's capacity, no part is saved and the starting LED stays
available. The skipped-LED step selects connections between units and highlights
and lights their complete ends. Partial wiring is allowed only between complete
strips; their members cannot be split into separate cable sections.

## Hold mapping and route lighting

Hole positions are normalized in the rectified wall frame. Matching converts
them into canonical pixels, where the detected holds already live. A hold owns
the T-nuts inside its actual outline, or its stored radius when no outline is
available. Several covered nuts can therefore belong to one hold. Overlapping
claims resolve by distance to the hold center in canonical pixels; ambiguous ties can
remain unassigned. The outline still controls tapping the hold. Manual links
can assign several LEDs, including ones outside the automatic choice.

Generated LEDs retain their hole association when moved. Older generated IDs
recover their original positions. Manual LEDs bind to nearby placement slots
within a bounded distance. **In the hold** and **Behind the hold** keep their
center or paired positions. **Below the hold** and **Complementary positions**
each assign one aligned LED below a mounting hole when that slot exists. A
sideways or upper LED never substitutes for a missing lower slot. These two
placements also keep a separate upper reference, independent of manual primary
links. A vertical chain of nuts covered by one hold uses the main indicator
below its lowest nut and the optional upper one above its highest nut. Several
columns can contribute their own outer indicators. Internal indicators do not
multiply merely because the hold covers more rows. Automatic ownership is
exclusive within each role: a worse competing match stays unassigned, while a
main LED for one hold may still be another hold's optional upper reference.
Matching uses the calibrated grid plane, including staggered rows and
perspective, rather than the screen's vertical axis. The references
retain their original positions after movement. Physical indices use
the saved cable order, initial skips and gaps. Unwired positions have no index.

**LED strip** instead partitions each strip along its axis at the midpoints
between neighboring nuts. Empty nuts still bound the intervals; their LEDs do
not get borrowed by a more distant hold. A multi-nut hold receives the union of
its intervals, and end intervals extend to the strip's edited endpoints. All
assigned strip LEDs use the hold's normal role color. The optional dim upper
lighting remains specific to Below/Complementary placement. Actual marker
positions are used after individual edits. Removed/missing lines do not pull
unrelated columns into a strip's assignment.

The mapping exposes primary `ledIds`/`indices` and separate
`aboveLedIds`/`aboveIndices` for both holes and holds. Saved positions retain the
primary `hole`, the original `origin` and the derived `aboveHole` reference.
Upper references are recomputed from durable origins when the geometry or LED
positions change. An older app can drop `aboveHole` without changing the
derived result, because it retains `origin`. Rebuilding or expanding a grid
refreshes the upper references before saving while retaining existing wiring.

Manual nut links are stored as `tnutLeds`:
`{ hole: { x, y }, ledIds?: string[], aboveLedIds?: string[] }[]`.
Each role is independent: an omitted role uses automatic mapping, while `[]`
deliberately assigns no LED. `buildSprayLedMapping` applies these links before
giving a nut's LEDs to its detected hold, so Test LEDs and route lighting follow
them. Nut overrides take priority over older hold-ID links for the same role.
An explicitly assigned LED leaves the other automatic assignments in that role;
its assignment in the other role remains independent.

Legacy `holdLeds` (`{ holdId, ledIds }[]`) remains readable. `holdAboveLeds` uses
the same structure for manual upper assignments to holds with no mounting nut.
Neither field is the durable identity for a mounted hold. The common reader
rejects malformed links and removes references to missing LEDs or nuts. Marker
removal prunes references immediately before a new position can reuse an ID;
moving a nut carries its manual links, and undo restores the whole assignment.
Browsing another wall pattern and returning before committing a change restores
the original holes, manual assignments and cable together.
Photo identity and calibration checks still apply: the later re-photographing
flow must carry the physical nut layout into its new canonical frame.
Confirming an assignment step promotes existing manual hold links to their
unambiguous mounting nuts, without materializing automatic mappings. Converted
hold-ID links are removed so they cannot follow a hold to a different nut.
Existing nut overrides win. Opening the editor or lighting a route never writes
a migration; unmounted or ambiguous legacy links remain unchanged.

`saveSprayWallLedSetup` stores `holdLeds` as the app sends it. Every installed
app knows about these links, and one leaves the key out once its last link is
cleared (this app sends `[]`), so a layout without `holdLeds` clears the stored
links.

New uploads always include `tnutLeds` and `holdAboveLeds`, including empty lists
when cleared. An upload without these keys comes from an older app; the server
preserves the saved links while pruning positions that no longer exist. A
physical-layout rebuild or changed photo identity resets obsolete references.
Persisting these new assignments needs this PR's backend reader as well as the
updated app. Deploy the backend before distributing the new app revision. An
older app can still use the basic LED setup, but cannot interpret these new
manual nut and upper-role overrides. This change does not deploy a backend or
publish an app update.

LED pairs (`ledGroups`) are newer than any installed app, so an app from before
them saves a layout with no `ledGroups` key, which would erase a newer phone's
pairs. `saveSprayWallLedSetup` therefore keeps the stored list
(`keepLedPairsFromOlderApp`), an empty one too, minus pairs whose LEDs are gone.
If the older app rebuilt the LEDs (the placement, holes, corners, rows or
columns changed, and so did the LEDs), the stored pairs would name the wrong
LEDs, so the new layout's default pairs apply. A current app always sends
`ledGroups`, `null` for the default pairs, which the reader treats like no list.

Strips use `ledStripes`: an orientation, monotonically increasing strip/LED ID
counters, and ordered `{ id, start, end, ledIds }` entries. Actual LED coordinates
remain in `ledPositions`. A strict reader checks unique membership, existing IDs,
bounded endpoints/counters, at most 100 strips and 6000 total LED positions. Saved
cables must contain each strip completely and consecutively, in forward or reverse
order, with no internal skipped count. Removing and re-adding an individual LED
allocates a new ID so old manual references cannot attach to a replacement.
Modern uploads always include `ledStripes` (null when switching away). An older
app cannot read the new placement at all: a stale layout write without that
capability marker cannot overwrite an already stored strip setup. The server
returns an upgrade-required error rather than silently acknowledging an ignored
save. Settings-only updates remain independent; a modern confirmed pattern change
can replace the setup. The same board-row transaction lock covers this check.

`saveSprayWallLedSetup` stores `holdLeds` as the app sends it. Every installed
app knows about these links, and one leaves the key out once its last link is
cleared (this app sends `[]`), so a layout without `holdLeds` clears the stored
links.

LED pairs (`ledGroups`) are newer than any installed app, so an app from before
them saves a layout with no `ledGroups` key, which would erase a newer phone's
pairs. `saveSprayWallLedSetup` therefore keeps the stored list
(`keepLedPairsFromOlderApp`), an empty one too, minus pairs whose LEDs are gone.
If the older app rebuilt the LEDs (the placement, holes, corners, rows or
columns changed, and so did the LEDs), the stored pairs would name the wrong
LEDs, so the new layout's default pairs apply. A current app always sends
`ledGroups`, `null` for the default pairs, which the reader treats like no list.

Enable LEDs, finish setup and take the wall through the usual lightbulb control.
Routes illuminate their mapped LEDs using the existing start, hand, foot and
finish colors, including saved color overrides. Route playback and creator
previews use the same wall sender. The route editor shows its lightbulb on a
spray wall only while that wall's LEDs are enabled; there it takes the wall, so
the holds light as they are painted. Holds with assigned primary LEDs need a
wired primary index; a deliberately unassigned hold stays dark.
An incomplete or stale setup produces an error instead of confirming the route.
The setup photo identity must match the current canonical frame and calibration.
Mirrored spray routes are rejected because the wall has no defined mirror map.
Known route holds with deliberately empty/geometrically unmatched LED lists
remain dark while the other mapped holds light. A known assigned hold with no
wired primary index still reports an incomplete cable setup; unknown route hold
IDs remain an error. If every requested position is empty, the sender clears
only its own existing lighting session and never takes another preview's lane.

For **Below the hold** and **Complementary positions**, **Light the hold above**
appears in the lightbulb's control sheet and Settings > Board, in the same places
as the MoonBoard option. It is off by default and stored independently from the
MoonBoard setting. It lights each lit hold's wired upper references in white at
25% brightness (`[64, 64, 64]`), regardless of the hold's role color or overrides.
A primary LED in the same route
always keeps its full role color, even if another hold also uses it as an upper
reference. A missing or unwired upper LED does not prevent lighting the primary
LEDs. Changing the option refreshes only the actual owned route; it leaves an
explicitly cleared wall and another setup preview alone.
If a replacement route fails while the option changes, the last acknowledged
route receives that change only while its original session still owns the lights.
Background failures retain the normal retry on return.

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
top-row inset. Switching to grid or custom clears this offset-only choice.
The in/behind/below choices remain available for every wall pattern. All LED
placement tiles have the same size. The explanation for complementary positions appears
below the selection only while that option is selected. LED positions and cable
paths are stored alongside the placement choice.

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

Route lighting also uses the current viewer's cached published geometry, or the
owner-gated offline wall mirror, when the backend is unreachable. The mirror's
holds stay in canonical coordinates; the photo-coordinate registry is not used
for LED matching. A server access denial never falls back to an older copy.
The denial is retained for that account and wall across cache eviction and
offline restarts; only a valid fresh server response can restore access.
The saved calibration must still match the wall's frame and homography.

Opening LED setup refreshes the saved layout before the editor takes its first
snapshot, including when playback's cached copy is still fresh. Offline reads
and failed refreshes retain the local copy. The refresh wait is bounded, and a
response arriving after that deadline cannot replace the editor's snapshot.
Once editing begins, a background response never resets the climber's edits.
An old pending layout from before strip support needs one verified server read
before the updated editor can open it. Until then, the existing load error is
recoverable by connecting and trying again.

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
Queued legacy layouts retain the capabilities of the app that authored them.
The local-only `_legacyLedCapabilities` provenance is never sent to the backend;
a new editor save atomically replaces it with the current capability keys.
An authoritative strip layout replaces refused legacy geometry without clearing
dirty brightness, auto-off or controller settings. Non-strip reconciliation
preserves newer manual assignments before the editor takes its snapshot.

Changing brightness or auto-off while a full photo test is lit repeats the same
acknowledged LED selection. It does not include skipped or off-photo positions,
and cannot take the wall back from a newer preview or route.

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

Follow [the contributor workflow](../../CONTRIBUTING.md#contributing-to-the-mobile-app-react-native).
The mobile app defaults to the official Boardsesh backend for day-to-day
contributor development, as documented in
[`packages/mobile/.env.example`](../../packages/mobile/.env.example). Use your own
Boardsesh account. A GitHub fork used to submit a contribution does not by itself
require changing those development defaults.

For isolated testing, run the local development stack and set the backend URL
overrides from that template. The seeded `test@boardsesh.com` / `test` account
belongs to the local development database, not the hosted service. Separately
distributed apps remain subject to [the hosted-service policy](../../LEGAL.md#hosted-service--api-access).

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

## Testing without a controller

`vp run dev:wled-sim` starts a fake WLED controller on your computer
(`scripts/wled-simulator.ts`). It answers the parts of WLED's JSON API the app's
driver uses (info, state, individual LED colours) and prints every command as a
coloured strip with the lit LED indices. Options go after `--`: `--leds 120`
sets the strip length (300 by default), `--port 8090` the port (8080 by default)
and `--row 50` the LEDs per printed row; `--verbose` also prints each request.
Enter one of the addresses it prints as the WLED address on a phone on the same
network. On Windows the firewall may need to allow Node.js on that port.
