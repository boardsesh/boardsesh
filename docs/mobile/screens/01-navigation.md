# Mobile navigation

The app uses Expo Router. `packages/mobile/app/(tabs)/_layout.tsx` chooses native
or Material chrome and `packages/mobile/src/components/navigation/TabLayoutView.tsx`
renders the tabs. The website's marketing navigation is a separate surface.

## Library entry and tab variants

The mobile tabs are **Home, Session, Discover, You, Climbs**, in that order:
Climbs is the rightmost tab, like Apple Music's Search tab (HIG Tab bars: the
search tab sits "at the trailing end"). The native iPad bar and its sidebar follow
the same order; the JS tablet rails list Climbs last among the primary rows, with
You pinned at the bottom. Session keeps the `/record`
route; only its visible navigation label changes.
An ordinary launch and untargeted post-login entry select **Climbs**, using the
stored active board, unless the climber chose **Home** under Settings › Home ›
"Open the app on" (#6289; it moved from General to the Home page with #6546). Selecting the initial tab does not reorder the bar.

- **Where it lives:** `startupScreen: 'climbs' | 'home'` in the MMKV settings store,
  default `climbs`, per device. Sign-out does not clear it. An unknown stored value
  opens Climbs, and older bundles ignore the key, so an OTA rollback opens Climbs.
- **Who reads it:** only `getAppEntryTab()` / `getAppEntryHref()` in
  `src/lib/app-entry-route.ts`, synchronously. `app/(tabs)/_layout.tsx` reads it
  once at module load for `initialRouteName`; the launcher (`app/index.tsx`), the
  post-login redirect and the session-unavailable recovery in `auth-provider.tsx`
  read it on render.
- **When it applies:** from the next start. Changing it never navigates, and
  nothing re-reads it on resume, so returning from the background keeps the
  current screen.
- **What still wins:** a deep link resolves to its own route and never renders the
  launcher; a tapped notification pushes its destination after entry; the
  onboarding gate pushes the first-board picker over whichever tab is showing; on
  web a post-login `next=` return is read before the start-up tab. Session joins
  and warm resumes keep their own destinations too.
- **Screenshot mode** always starts on Home to preserve the capture readiness
  contract, whatever the simulator has stored.

The bar itself depends on the device:

- **Native iPhone:** Liquid Glass uses `NativeTabs` (the system UIKit tab bar) on
  every iPhone, iOS 18 included. Climbs is an ordinary labelled tab, like Apple
  Music's Search tab, not `role="search"`: since SDK 58 that role is a
  UISearchTab, which iOS 26 sets apart from the other tabs and which brings a
  search field into the bar. The queue accessory and scroll minimization ride
  the iOS 26 bar. On an iOS 27 iPhone Climbs is also the bar's prominent tab, so
  it stays on screen at the right when the bar collapses, as Music's Search does;
  the collapsed accessory fills the room left between it and the selected tab. On iOS 18 the bar has neither, and the current climb rides
  the floating JS queue bar just above the native bar.
- **Platter controls (iOS 26):** the open platter shows the lightbulb and the tick. The
  collapsed platter has one 44pt slot: the bulb while a board is bound and nobody holds it,
  otherwise the tick. A mark on the thumbnail's top-trailing corner shows who holds the board in
  both placements: amber `lightbulb.fill` (LED board you hold), brand-tone `pin.fill` (board with
  no lights you hold), `person.fill` (a teammate holds it), nothing when it is free. The collapsed
  platter's climb link reads the connection aloud; the open one leaves that to its bulb. The
  platter's bulb and tick send `placement` (`regular` / `inline`) on `Board Connect Tapped` and
  `Quick Tick Opened`.
- **Climbs header (iOS 26 Liquid Glass, where the accessory platter mounts):** while you hold the board and no other climb is lit on the
  wall, the centre slot shows a "You have the board" capsule (brand-tone pin and "You have the
  wall" for a board with no lights). The "On the wall" capsule keeps priority. The tap opens the
  Bluetooth controls sheet when this device holds the radio link and logs `Board Controls Opened
  {surface: 'header_pill'}`; otherwise it is plain text. Both capsules share the
  `HeaderStatusCapsule` glass shell. Material and Android are unchanged: their bar never
  collapses, so its bulb stays visible; neither does the iOS 18 floating bar.
  The header hides the Climbs title by drawing it in a clear colour
  (`HIDDEN_HEADER_TITLE_STYLE`), not with an empty title view: the native stack keeps one
  centre view per screen, and a capsule swapped into an empty one kept its zero size and
  stayed invisible until the tab was left and re-entered.
- **Climbs search, every platform:** the Climbs screen has no search field and
  its header draws no "Climbs" title (`NativeRootHeader` `titleHidden`; the tab
  names the screen). The climb-name search is the first row of the Filters
  sheet, as in the Logbook. A second tap on the Climbs tab with the list showing
  opens Filters without the keyboard (`useTabReselect`, which listens for the tab
  bar's re-press; the JS tablet rails navigate without one, so there the Filters
  chip is the way in). On a collapsed bar that tap also expands the bar. That is UIKit, not
  us: iOS expands a minimized bar on any tab tap, the prominent one included, and offers no API to
  keep it minimized. Checked on iOS 27 with the Filters sheet off and with a programmatic scroll
  after the tap; the bar expanded both times (#6885, closed as platform behaviour). A typed name shows as the first token under the chips and
  counts in the Filters badge.
- **Other phones:** Material, and Liquid Glass forced on Android, use JS `Tabs`
  with `MaterialTabBar`.
- **iPad (Liquid Glass):** the Apple Music layout. `NativeTabs` with
  `sidebarAdaptable`: a sidebar in landscape, a tab bar at the top in portrait,
  the phone tab bar in a narrow Split View. Each tab is one content column, with
  no player pane or wall column beside it. The current climb rides the bottom
  accessory, as on iPhone (Music's MiniPlayer), and tapping it or any climb opens
  the full-screen `/play` player (it slides up, like a climb row). Five tabs, as
  on iPhone (HIG Tab bars: "aim for a default list of five or fewer"): the
  iPad-only On the Wall tab became the **Wall display**, below. One resolver,
  `resolveCurrentClimbSurface`
  (`src/hooks/current-climb-surface.ts`), decides who shows the current climb, so
  the floating JS bar never appears over the accessory; tab content clears the
  accessory through the measured in-tab inset, as on the iPhone Duo. The rest
  timer pill is a root overlay, so it centres on the content column the
  accessory spans, using the in-tab side insets (the sidebar's 280pt in
  landscape, the Duo rail's 84pt), not on the whole window. On every device the
  pill stays off the Session tab's own page while the timer is idle (waiting
  for the first climb), since that page shows the timer's settings inline, and
  reserves no space there either. Once a rest is counting, the pill and its
  space come back, because nothing inline shows the running time outside a
  workout block. Lists pad for the
  expanded tab bar even while it is minimized, so a bar that re-expands at the
  end of a list never covers the last row. Root
  headers use native bar items, as on iPhone, so UIKit places them beside the
  sidebar button and the top tab bar (see "Root header actions are native bar
  items" in `docs/design/mobile-chrome.md`).
  In landscape the player puts the board on the left and Up next / Logbook /
  Beta in a 400 pt panel on the right (`resolvePlayerArrangement`); in portrait
  the board stays on top.
- **Android tablets, Expo web, iPad on Material:** one JS `Tabs` navigator at
  every width (rail at regular width, `MaterialTabBar` in a narrow split), so a
  resize keeps each tab's state. At regular width the shell keeps its
  persistent player pane (`IpadPlayPane`) and, in landscape, the live wall column.
- **Wall display (tablets):** a full-screen kiosk for a tablet mounted at the
  board, read from 3–5 m (`app/wall-display/`). It opens from the board sheet
  and from ⛶ on the MiniPlayer (or the MiniPlayer's ⋯ when ⛶ is switched off),
  on a tablet only; the old
  `com.boardsesh.app://wall` link opens it too (`+native-intent.ts`). A root
  `transparentModal` like `/play`, never `fullScreenModal`
  (`docs/mobile/mobile-sheets-vs-routes.md` rule 2), so it covers the sidebar, the tab
  bar and the bottom accessory while they stay live behind it. The screen stays
  awake while the kiosk is the focused screen. Exit and Settings sit in the top
  corner and fade 4 s after the last touch; any touch brings them back (HIG,
  Going full screen). Faded, they stay in the accessibility tree and a press on
  them only brings them back; with VoiceOver or an Android accessibility service
  on they never fade. Esc and ⌘W exit from a hardware keyboard. The route hosts
  its own Bluetooth device picker, as `/play` does, and marks itself in
  `wall-display-presence.ts` so the shell behind it stays quiet even with a page
  pushed over the kiosk. The kiosk shows the board, the
  grade, the name and the "On the wall now" strip; the setter, the angle badge
  and the Lit-by / Sent-by avatars were too small to read from the mat and are
  not drawn. Its Settings and profile pages push inside its own stack
  (`scoped-navigation.ts`).
- **Session setup:** Browse climbs opens the selected board's library
  directly, without rewriting the board selection.
  Change board is a separate action; its picker returns to Session. First-time
  board selection still finishes on Climbs. Start opens Climbs after creating the
  session and appending any generated workout; a failed start stays on Session.
  The board card uses separate full-width Browse climbs and Change board rows;
  a small selected-board thumbnail leads Browse climbs and board details wrap
  beneath its label. Both rows disappear once the session is running; the Climbs
  tab remains available. During Start, the setup form remains
  visible and Start stays disabled until the native tab leaves Session, so live
  settings never flash during the handoff. Switching tabs manually while creation
  is pending cancels the automatic redirect, while session and queue creation finish.
- **Restoring a board:** local disk reads and bounded retries run independently
  of internet connectivity. Pending reads show loading; failed reads offer Retry.
  Only a successful read returning no board permits setup or a Choose board prompt.
  Existing saved-board and account-isolation rules remain in force. Filters keep
  their existing persistence; scroll position is retained within the running app,
  not restored across process restarts.

The picker emits `Board Picker Opened` once after the active-board read settles
and `Board Picker Selection Completed` after an existing-board selection is
persisted. The opening waits for the picker's "already allowed?" read (a few
milliseconds; not under "Where do you climb?", which reads nothing on open) and
carries `locationStatus` as known then (`idle`, `loading`, `granted`, `denied`
or `unavailable`: `loading` or `granted` for a climber who allowed location,
`idle` for everyone else) and `locationPermission`, the read itself (`ask`,
`blocked`, `granted`, or `unknown` when nothing was read). Before the location
re-ask OTA it fired before that read came back, so `locationStatus` always
said `idle`. The pick carries `nearbyResultCount`,
how many boards the Near you search had returned by then (after a board-type
filter, before boards shown elsewhere in the picker are left out): `0` for "Nothing
within 20 km", `null` when the picker did not search (location not allowed, or
first-board mode before "At a gym"), is still searching, or the search failed.
`First Board Picker Skipped` carries the same count as it stood when the picker
closed. Near you shows only once location is allowed, above Your boards; without
it the foot of the picker has the "See gyms near you" card instead
(`LocationAskCard`, the same card the gym map shows). See "Asking for location"
below. While Near you searches, placeholder cards as tall as its cards
hold its space, so Your boards never moves under a pick that lands as the search
answers: cards keep at least that height, and a quiet line (nothing new within
20 km, a failed search) keeps it too, centred, once the climber has touched the
picker; before any touch it gives the space back. Under "Where do you climb?" location waits for "At a gym": it is
not read on open or when the app comes back. The gym finder opened on its own sends neither. `sameBoard` compares UUIDs;
`sameConfig` compares board type, layout, size and hold sets. A failed
restoration records unknown (`null`) rather than claiming there was no board.
`source` distinguishes onboarding, explicit Session returns, and other picker
entries; `returnTo` records the destination. `pickSource` names the list the
board was tapped in (`your_boards`, `nearby`, `offline`, `bluetooth` for a board
the scan put at the top, `gym_walls` for a wall At {gym} that came from the
board you're on, or `gym_finder`) and `followed` says whether the pick added it
to Your boards. `section` names where the board was drawn (`at_gym`, `hero` for
the one board heard at another gym, `your_boards`, `near_you`, `offline`, or
`map` on the gym finder) and `position` is its 0-based place in that section as
drawn (At {gym} A to Z, Your boards in the server's order, Near you by
distance). `position` is `null` for a wall on the map, and both are `null` for
the active spray wall's own details row, which sits in no section. The gym
finder binds through the same `useActivateBoard` path, so its picks report this event (and close out onboarding when the picker
forwarded `source=onboarding`). Pushed from the picker's "Find gym" (which adds
`from=picker`), it reports no opening of its own, because the picker already
did, and its picks carry the picker's `source`. Opened on its own from Home or
Gyms you run, it reports its own opening, and both events say `source: gym_finder`,
so those picks never count against the picker's openings. Creation
flows retain their existing creation/activation events. Screen-event deduplication
is unchanged, so these events diagnose reselection without restoring a per-screen
navigation stream. They do not establish a retrospective before/after baseline.

### Asking for location

Location is never needed: searching works without it. A climber who said no,
or was never asked, still gets a clear second ask, without being nagged.

- **Nothing asks on open.** The picker, the gym map (`/gyms`) and the gym
  picker sheet call `requestIfAllowed`: they use an earlier yes and read the
  permission, and the system prompt only follows a tap. The gym map used to
  show the prompt on every open, and the onboarding handoff to the picker
  showed it on arrival. The gym map and the gym picker sheet read the
  permission again when the app comes back, so a grant made in Settings from
  their buttons takes effect with no second tap.
- **One card** (`src/components/location/LocationAskCard.tsx`): "See boards
  near you" in the picker (its Near you lists boards), "See gyms near you" on
  the gym map, then "Sorts by distance. Search works without it.", with Allow
  and Not now. Allow shows the system prompt while it can still ask, and is
  disabled until the prompt answers. Once only Settings can turn location on
  (`blocked`: iOS after one no, Android "Don't ask again"), the button reads
  Open Settings, and the permission is read again when the app comes back to
  the foreground, so a grant there fills Near you or centres the map with no
  second tap. In a browser nothing can open the site's settings, so the line
  says where to turn it on and only Not now shows.
- **One snooze.** Not now on any surface hides the card on every surface for
  14 days (`lib/location-ask.ts`, the `locationAskSnoozedUntil` setting, per
  device). A stored time further out than 14 days means the clock went back,
  and reads as expired. The gym map's panel then says to search a town, with a
  quiet Use my location under it: the climber opened the map on purpose, so
  that tap asks (or opens Settings) whatever the snooze says. In a browser that
  has said no it is left out, as it could do nothing.
- **Never while allowed**, and never before the permission is read, so it
  never flashes.
- **Events:** `Location Ask Shown` `{ surface: board_picker | gym_finder,
  permission: ask | blocked }`, once per card per screen visit (on the gym
  map the card stays up while its own prompt is out, so a no does not show it
  twice), and `Location Ask Answered` `{ surface, answer: allow |
  open_settings | not_now, permission }`, the permission after the answer.
  `allow` is sent as the prompt closes, not after the fix. `open_settings` is
  sent when the app comes back to the foreground, so a climber who never comes
  back sends nothing. The gym map's quiet Use my location sends neither.

A pick follows the board unless the climber built it (`ownerId` matches them) or
already follows it. `UserBoard.isOwned` plays no part: it is the creator's "a
real wall" flag and is true for almost every board built in the app, which is
why, before #5654, a gym or community board someone else built was bound but
never followed, and the picker said "No boards yet" on the next open. Someone
else's private board is never followed, because the server refuses it, and a
signed-out climber follows nothing.

Because nearly every board someone else built now counts as new to the climber,
adoption's "Download X?" dialog only appears on picks from the picker and the
gym finder. The onboarding bind (which makes its own offer) and the play
drawer's wall switch pass `offerOffline: false`: they still follow the board,
and the "keep boards offline" setting still downloads it, but they never ask.

The app also follows the board it launched on, once per account and board
(`Active Board Follow Healed`), when the server says it is neither the climber's
nor followed. It started as the repair for picks made before #5654, but it is a
lasting rule: it covers every board the app launches on, including boards bound
without a pick at all (a party session join, a `/b/` or climb deep link, the
Bluetooth mismatch switch, the drawer's board switch). So a friend's wall you
joined a session on shows up in Your boards after the next launch. The
`active-board-follow-heal-kill` mobile flag turns it off fleet-wide; the heal
waits for flags to resolve, so the switch holds from the next launch.

## Routes, sheets, and authentication

Use the scoped navigation helpers in `packages/mobile/src/lib/routing/` when
opening a shared screen inside a tab, account stack, or Wall display. Shared
screen implementations have thin route exports in each owning stack; Back must
return to the stack that opened them.

The player is `/play`, a root `transparentModal` with its own queue and Bluetooth
sheet hosts. Wall display uses the same presentation rule. Secondary tasks use
managed sheets; see [sheets versus routes](../mobile-sheets-vs-routes.md) for
presentation, dismissal, keyboard, and native tab-bar constraints.

`packages/mobile/src/providers/auth-provider.tsx` owns authentication redirects.
Browser return links are validated by the anonymous-auth gate; native entry uses
the startup tab unless a deep link or pending destination takes precedence.
See [mobile authentication](../../auth/mobile-auth-flow.md), [mobile chrome](../../design/mobile-chrome.md),
and [large-screen layout](../../design/mobile-large-screen-layout.md).
