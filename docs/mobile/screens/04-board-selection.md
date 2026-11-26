# Mobile board selection and discovery

`packages/mobile/app/boards/index.tsx` hosts the board picker. Its presentation
lives under `packages/mobile/src/components/board-discovery/`; activation,
identity comparisons, follow behavior, and picker analytics live under
`packages/mobile/src/lib/boards/`. The In range slot's state (the scan, the top
it leads with, the Bluetooth asks) is `usePickerInRange` and its buttons are
`useInRangeActions`, both in board-discovery; the screen keeps the picks, Near
you and location.

## Pick an existing board

The picker combines Your boards, nearby results when location is allowed, offline
boards, and boards identified through the shared Bluetooth scan. The first-board
flow offers the gym path without requesting location merely because it opened.
A saved board's UUID identifies the wall; matching catalog geometry alone does
not make two physical boards the same.

`useActivateBoard` owns selection. A pick follows a public board when the climber
neither created nor already follows it. Activation destinations distinguish
first-board entry, an explicit return to Session, and other picker entries.
The detailed ordering, stable scan-result placement, location states, event
properties, and offline-download offers are in [navigation](01-navigation.md)
and [Bluetooth](12-bluetooth.md).

### Friends' boards

Right under Your boards, the picker shows up to five home boards owned by the
climber's friends (`friendsBoards`, `useFriendsBoardsShelf`): the owner and the
climber follow each other ([privacy](../../product/privacy.md#friends-boards)).
A one-way follow, in either direction, lists nothing. A friend always follows
the owner, so a Followers board always opens (`CAN_CLIMB`); only an Invite-only
board its owner opted in comes as an ask. It reads one page of six and never
more: a sixth row covers a board that is also in Your boards,
which the shelf leaves out by uuid (`friendsShelfBoards` in
`src/lib/boards/friend-boards.ts`). The shelf is hidden when it is empty, signed
out, under "Where do you climb?", and on the offline and error layouts. "See
all" opens the wizard's "Whose board?" (`app/boards/add/friend.tsx`) outside the
wizard: no step counter, and leaving it is not a board flow abandoned.

Each row is a `BoardRow` drawn from the board's preview (the server never sends a
slug, serial or location for a board the viewer can't open). The subtitle is the
owner, the board and its angle ("Sam · Kilter Original 12×12 · 40°"). A board
the climber has to ask for carries a lock beside the title, and a waiting
request a "Requested" `StatusPill`; nothing is drawn over the art.

A tap goes through `useFriendBoardAction` (`src/lib/boards/use-friend-board-action.tsx`),
by `viewerAccess`:

- `CAN_CLIMB`: the board is bound as a Your boards tap binds one, with adoption
  off, then followed, so it lands in Your boards (adoption never follows a
  private board). "Saved to Your boards · Undo" shows on the tab the bind lands
  on (`SavedFriendBoardUndoSnackbar`, hosted by the drawer host, because the
  bind closes the boards modal); Undo unfollows it. "Download X?" is offered as
  adoption would (`useAdoptFoundBoard({ follow: false })`). The pick event is
  sent once the save settles, so its `followed` is what happened; it says
  `pickSource: friends`, `section: friends_boards` (or `friend_step`).
- `CAN_REQUEST`: `FriendBoardAccessSheet`, "Ask {{name}} to climb here", which
  says the owner approves each climber on the board, and whose button calls `requestResourceAccess`. The sheet closes on the write; the
  friend lists are then read again (not the app-wide refresh an owner's
  privacy write gets), never set to Requested by hand: the server answers an
  ask for a board the climber can already open with a quiet yes. A
  `RATE_LIMITED` answer whose `retryAfterSeconds` is over an hour is the daily
  cap and reads "Try again tomorrow"; a shorter one (and any limit on Cancel
  request) reads "Wait a moment". Both show inside the sheet (a toast would
  draw behind the modal).
- `REQUESTED`: the same sheet, "Waiting on {{name}}", with Cancel request
  (`cancelResourceAccessRequest`).

`friendsBoards` is network only and never persisted
([offline reads](../../data/offline-reads.md), Bucket 3). When an owner takes a
climber back off a board, it drops out of `myBoards`, and the next complete,
successful `myBoards` read since the screen mounted prunes its offline card
(`offlineBoardCardSync` in `src/offline/use-remember-downloaded-boards.ts`); a
failed or truncated read, or a list hydrated from the persisted cache, prunes
nothing. `friendsBoards` is read again when the climber follows or unfollows
someone (a follow can make a friend, an unfollow ends one), and on a live
`new_follower` or `board_access_approved` notification
(`use-spray-completion-updates.ts`). An unfollow by someone else sends no
notification; the list catches up once the app-wide five-minute stale time
runs out, or on a pull to refresh in "Whose board?".

The owner hears about a request in the inbox: one climber asking shows Approve
and Decline in place (`useAnswerBoardAccessRequest`); a row with several opens
the board's Manage access. The climber's "said yes" row binds the board and
lands on Climbs.

A shared `/b/{slug}` link to a board the climber can't open still ends on
"Board not found": the request card there needs a way to tell slug to
requestable board, and the server deliberately sends no slug for a board the
viewer can't read.

## Create and manage a board

`app/boards/create.tsx`, `edit.tsx`, and `manage.tsx` use the board-discovery
components. Keep board creation separate from selecting an existing saved wall.

### Add a board wizard

Behind the `add-board-wizard` flag, the + on the picker and on Manage boards
pushes one wizard under `app/boards/add/` instead of opening a menu:

- `index.tsx`, "Where's the board?": at a gym, at home, a friend's board, or a
  Spraywall (handed to `/boards/spray/new` unchanged). It has an X and the
  title "Add a board".
- `friend.tsx`, "Whose board?" (step 2 of 2): boards owned by the climber's
  friends (they follow each other), under an owner header each, with a search
  on the board or owner name, one page per end-reach. Either follow may be the
  missing one, so the footer offers both: "Not following them yet? Find
  people" (`app/boards/users/search.tsx`, the climber search inside the
  picker's stack) and "Share your profile so friends can follow you" (the
  profile's share link, `useProfileShareOptions`; hidden for a private
  profile, which has no public link), then the share-link hint. A tap works as
  on Friends' boards above. Empty states: no friends' boards yet (with Find
  people and Share your profile; the app can't tell "no friends" from "friends
  with no boards" without a new field, so one placard covers both), no match,
  offline; signed out it asks for sign-in. Under the search, "Scan a board
  code" pushes `scan.tsx`, the in-app camera (`BoardCodeScannerScreen`,
  expo-camera). It reads QR codes only and follows a code only when it is a
  board or climb link on www or apex boardsesh.com or the app's scheme
  (`parseBoardLinkPath`, the deep-link parser) or a crew `/join/{id}` link
  (`src/lib/routing/scanned-board-code.ts`); it replaces the boards modal with
  that link's route, as a tapped link would open it. Any other code shows
  "That code isn't a Boardsesh board" and the camera keeps looking; the same
  code held in view is refused once, not every frame. Camera permission is
  asked from the screen, and a refusal offers Open Settings. expo-camera first
  ships in a store build, so the JS reaches it only through
  `src/lib/board-code-scanner/camera-module.ts`, which asks
  `requireOptionalNativeModule('ExpoCamera')` before requiring it: on an older
  binary running a newer OTA, and in the browser app (`camera-module.web.ts`),
  the button is hidden and the route says the app needs updating.
- `gym.tsx`, "Which gym?": `GymStep`, the map and search.
- `gym-boards.tsx`, "Boards at {gym}": `GymWallList`, where an existing wall is
  taken before a copy is added.
- `board.tsx`, "Which board?": `BoardTypeStep`, art tiles for MoonBoard, Kilter
  and Tension, then the other types as rows.
- `create.tsx`, Set up, restyled: 200 pt art, Board, Layout and Size as rows
  (`BoardSetupRows`; a menu up to 8 options, else `add/setup-option.tsx`),
  chips for Holds only, the gym locked when the wizard picked it.

From step 2 the bar has a back chevron and no title, and the body says "Step N
of M", counting only the screens the climber sees. Entries that know the
answer skip ahead: a gym page opens on its boards, In range's "It's my own
board" opens Set up, first run's inline At home opens Which board?. The step
counting, the routes per entry and the analytics are in
`src/lib/boards/add-board-wizard.ts`; the full flow is in
[existing-wall check](../../product/existing-wall-check.md), "The app". With
the flag off the + is the menu (Set up a board, Add a Spraywall, Find a gym)
and the builder keeps its chips. `where.tsx` and `find-wall.tsx` redirect into
the wizard for one release.
Spray walls use their own photo, hold-review, and LED setup tasks; see
[spray walls](../../product/spray-walls.md) and [spray LED setup](../../boards/spray-wall-led.md).

A failed active-board restore is not an empty board list. Show loading while a
read is pending and Retry on failure; offer first-board setup only after a
successful read proves there is no selection. Account isolation and offline
availability follow [offline reads](../../data/offline-reads.md).
