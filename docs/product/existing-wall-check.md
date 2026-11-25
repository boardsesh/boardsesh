# Existing-wall check: one record per physical wall

Issue #8151. Before this, nothing stopped a climber from adding a second copy of a gym wall that someone else had already added. The duplicate guard (`findOwnedBlockingDuplicate`) only compares a climber with their own boards. The serial guard only works for a board with a controller serial, and older MoonBoards have none. The result was several records for one wall: a seeded 2016 record, a 2019 record missing its feet, other climbers' copies, and listings split across merged or nearby gyms.

The fix has two halves that share one rule:

- `existingWallCandidates`, a query the app calls to show a gym's walls before the climber adds one.
- An opt-in recheck inside `createBoard` that refuses a create that would add a copy of one of those walls.

Both read the same walls with the same visibility rule, so a create is only ever refused over a wall the climber could have been shown.

Code: `packages/backend/src/graphql/resolvers/social/existing-wall-check.ts` (the shared core), `board-wall-candidates.ts` (the query), `boards.ts` (`createBoard`), and `packages/shared/board-config/src/wall-match.ts` (the match rules both clients use).

## What counts as the same wall

`classifyWallMatch(draft, wall)` in `@boardsesh/board-config`:

| Kind                     | Rule                                                      | Blocks a create?                  |
| ------------------------ | --------------------------------------------------------- | --------------------------------- |
| `EXACT`                  | Same board type, layout, size and hold sets               | Yes                               |
| `SETS_DIFFER`            | Same layout and size; sets are a subset, superset or overlap | Only under `REJECT_IF_FOUND`   |
| `LAYOUT_OR_SIZE_DIFFERS` | Same board type, another layout or size                   | Never. Shown as advisory only.    |

Set order and repeats are ignored (`normaliseSetIds`). Angle is never compared: an adjustable board's angle is a setting, not a different wall. Another board type is never a match.

`compareWallCandidates` ranks: match kind, then source (chosen gym, merged listing, nearby listing), then nearest gym, then oldest wall, then uuid. The uuid makes it a total order, so a list never reshuffles between refetches.

`likelySetupOmissions` flags a MoonBoard Masters 2017 (layout 4) or Masters 2019 (layout 5) entered without its Screw-on Feet (set 15 and set 20). It is a nudge for the form; partial setups stay allowed.

## Which walls are searched

For a chosen gym:

1. The gym itself. A merged listing's uuid resolves to the gym it merged into.
2. Listings an admin merged into it (`collectMergedTwinGymIds`). Boards can be left behind on a merged twin. Their walls show under the chosen gym's name, never the old listing's own name.
3. Public, listed gyms within 150 m of the gym, nearest first, at most 10 (`findGymsWithin` with `publicListedOnly`). A private or unlisted gym nearby is never searched, whoever owns it. A gym with no coordinates has no "nearby".

Only boards of the requested type, not deleted, that the caller can see count:

- the caller's own boards, private or not, and
- boards that are public and not unlisted, and that pass the resource-privacy override (`resourceAccessCondition` without the unlisted-link allowance).

Gym staff get no wider view. A staff member adding a board is a climber like any other, and the check must never block on a wall a stranger would not see.

One check reads at most 100 rows. The chosen gym's walls are read first, then its merged listings, then walls on the draft's layout, then oldest, so a busy neighbour can't push the chosen gym's own wall out. The `createBoard` recheck reads only walls on the draft's layout and size, since no other wall can block it.

## The query

```graphql
existingWallCandidates(input: ExistingWallCandidatesInput!): ExistingWallCandidates!
```

- Auth-optional, so a signed-out climber can browse a gym's walls. Rate limit: 20 per minute (`existingWallCandidates`).
- A private gym the caller can't edit throws `NOT_FOUND`, like `gymBoards`.
- Spray walls are refused at validation: they have their own setup.
- `layoutId`, `sizeId` and `setIds` describe the climber's draft. Send all three or none. Without them `matchKind` is null and the list is just the gym's walls.
- `limit` defaults to 20, max 40. `truncated` is true when more walls matched than were returned.
- Each candidate's board goes through `enrichBoards`, so every per-board read rule still applies.
- A failed lookup throws. It never answers with an empty list, because the app reads "no walls" as "go ahead and add yours".

## The createBoard recheck

Two new `CreateBoardInput` fields:

- `existingWallCheck: ExistingWallCheck` (`REJECT_IF_FOUND` or `CONFIRMED_SEPARATE`)
- `acknowledgedWallUuids: [ID!]`, at most 40

**Absent field: no check.** A client that never sends `existingWallCheck` gets exactly the behaviour from before. This keeps old binaries working.

**When it runs.** Only for a board with no serial (the serial guard settles those), not a spray wall, and only once the board lands on a gym:

- an explicit `gymUuid`;
- a gym `resolveAutoGymForBoard` auto-attaches from a typed location (if that gym is deleted or merged in the moment between, the create fails rather than skipping the check);
- a gym being minted from a typed location. Here the search is the public, listed gyms within 150 m of the typed coordinates. A name-only mint has nothing nearby to search.

**Order.** After the same-owner duplicate guard. For an explicit `gymUuid` it runs once before `requireBoardGymLinkAccess`, so a refused create never spends the 5-per-minute `linkBoardToForeignGym` bucket. That early run is skipped for a gym the caller can't see, so a hidden private gym still answers "Gym not found" exactly as before. The authoritative run is inside the insert's transaction, under the gym-wall lock.

**Modes.**

- `REJECT_IF_FOUND` refuses on any `EXACT` or `SETS_DIFFER` wall.
- `CONFIRMED_SEPARATE` with acknowledged walls refuses only on an `EXACT` wall missing from the list. The walls the climber saw and called different no longer block.
- `CONFIRMED_SEPARATE` with an empty list is honoured only when there is no `EXACT` or `SETS_DIFFER` wall at all. Otherwise a client whose lookup failed, or a script, could send the confirmation blind and skip the check. A list naming none of the walls the server found counts as empty, so one made-up uuid can't get round this.

A confirmed create next to a wall the climber saw logs `createBoard: existing walls acknowledged as separate` once, from the run inside the transaction, as the duplicate-config bypass does.

**The refusal.** `BOARD_EXISTING_WALLS`, with `extensions.candidates: [{ boardUuid, matchKind }]` and nothing else: no names, owners or places. An error's extensions are a read channel. The client refetches `existingWallCandidates` to show the walls, which applies the full read rules. `readExistingWallsError` in `@boardsesh/graphql` reads it.

A refused mint creates no gym. Any failure of the recheck on the mint path, a refusal or equally a lookup or lock query that failed, fails the whole create with no board and no gym. The mint path's fallback (create the board with no gym) skips the check, so it is kept for gym-creation failures only.

The per-gym caps in `requireBoardGymLinkAccess` (`MAX_BOARDS_PER_FOREIGN_GYM`, `MAX_FOREIGN_GYM_LINKS`, the 150 m proximity rule) still apply after the check. Acknowledging a wall gets past the check, not past the caps.

## Concurrency: the gym-wall lock

Two climbers adding the same wall at the same moment could both read "no wall yet" and both insert. Inside the insert's transaction the recheck takes `pg_advisory_xact_lock(0x4757414c, key)` (ASCII "GWAL") for every live gym in the search, in ascending key order, before it reads the walls. The second create waits, then reads after the first commits and sees its board. Two creates at neighbouring gyms lock the same set, because each gym is in the other's search.

The search scope (the merged listings and nearby gyms) is read on the pool BEFORE the transaction opens. Inside the transaction only the locks, one look for nearby listings, and the wall read run, all on the transaction's own connection. A transaction that waited on a second pool connection would hold its own while it waited, and the pool has 5: five concurrent creates would wedge the backend.

After taking the locks the recheck reads the nearest public, listed gyms again, on the transaction, and replaces the first read's nearby list with it (still at most 10, nearest first). A gym another create minted and committed while this one waited can then displace a farther one even when the first read was already full. Any gym new to the list is locked too before its walls are read, so a create still in flight at it is waited for. Those locks come after the first set and can be out of ascending order; in that rare overlap Postgres detects the deadlock and fails one create with an error the climber can retry. It never lets a duplicate through.

- `lockGymWallWrites` in `packages/db/src/queries/boards/gym-wall-write-lock.ts`, beside the serial lock.
- Taken first in the transaction, before the board-serial lock (`lockBoardSerialWrite`). The check only runs for boards without a serial, so in practice the serial lock is a no-op there, but the order is fixed.
- Ascending order means two creates whose first scopes overlap take their shared locks in the same order. Only the extra locks for a gym found after the wait can deadlock (see above).
- Gym ids are bigserial and the two-int form takes int4 keys, so the id is folded modulo 2^31 and the keys are sorted after folding. A fold collision only serializes two unrelated gyms.
- Merged listings are soft-deleted and nobody adds a board to them, so they aren't locked.

Limits of the mint path, by design:

- Two mints at the same spot serialize only through a public, listed gym that was already within 150 m when they started (both lock it). With no such gym nearby there is nothing to lock, and both can mint.
- A minted gym is public only when its board's audience and location are both public. A home wall with a hidden location mints a private gym, which never enters anyone's search, so it never blocks another mint, as a private wall never blocks anything.

The namespace is new. Other two-int namespaces in the repo: `0x4253524c` board serials ("BSRL"), `0x47594d4f` / `0x47594d4e` gym creates per owner and per name ("GYMO" / "GYMN", see "Creating a gym" in `gym-board-governance.md`), `(8043, 1)` gym-claim auto-approve, `0x434c4942` climb duplicates, `0x46415653` favourites, `0x70757368` push tokens, `0x46524551` follow requests, `0x434e5354` analytics consent, `0x454d4b59` / `0x50535542` auth email and provider keys, `6975` the auth authority gate. Pick another for a new lock family.

`createGym` has the same kind of check for gyms (`GYM_SIMILAR_EXISTS`), with two differences: it runs on every create, not only when asked, and its refusal carries the gyms whole rather than uuids. See "Creating a gym" in `gym-board-governance.md`.

There is no unique constraint. Two walls with one setup at one gym are real (a gym with two identical MoonBoards), and `CONFIRMED_SEPARATE` is how a climber adds the second.

## Catalogue refusals name the field

`UNKNOWN_BOARD_CONFIG` (`assertKnownBoardConfig`) now also carries `extensions.field` (`boardType`, `layoutId`, `sizeId` or `setIds`, the first refused in that order) and, when the sets were the problem, `invalidSetIds`. Both are additive; older clients read only the code. For an Aurora board the layout and size are told apart by two one-row probes that only run after the main check has failed.

## The app

The mobile app (native and Expo web) uses both halves. Screens: the add-a-board wizard under `app/boards/add/` (`index.tsx` Where's the board?, `gym.tsx` with `GymStep`, `gym-boards.tsx` with `GymWallList`, `new-gym.tsx` with `NewGymStep`, `board.tsx` with `BoardTypeStep`) and the builder, `app/boards/create.tsx`. `app/boards/where.tsx` and `app/boards/find-wall.tsx` are now redirects into the wizard, kept for one release.

**The builder always opts in.** Every create sends `existingWallCheck`, whatever the flag says. The first Save is always `REJECT_IF_FOUND` against the climber's real setup; nothing earlier in the flow acknowledges a wall, because the gym's wall list has no setup to compare against and `CONFIRMED_SEPARATE` never blocks on `SETS_DIFFER`. On `BOARD_EXISTING_WALLS` the builder looks every named wall up by uuid (the gym may be one the server auto-attached, which the app never learned) and shows `ExistingWallsSheet`, keeping the form. "Use this board" follows and binds the wall. "Keep setting up mine" resends as `CONFIRMED_SEPARATE` with the walls the climber was actually shown, newest first so the 40-wall cap drops older ones. A wall that couldn't be loaded is never acknowledged: the sheet says some couldn't load, offers Try again, and the server names it again on the next Save. A refusal naming no walls is shown as a plain error.

**The add-a-board wizard** sits behind the PostHog flag `add-board-wizard` (fail closed, rolled out by percentage). It replaced `create-board-gym-first`, which only about one real climber ever saw; that flag and its hook are gone. With the flag off the + is the old menu (Set up a board, Add a Spraywall, Find a gym) and the builder keeps its chips.

```
+ ─► /boards/add  "Where's the board?"   (X, no counter: the path isn't chosen yet)
       ├ At a gym   ─► Which gym? (map + search) ─► Boards at {gym} ─► Set up
       │               └ Add my gym ─► Add your gym ─► (Which board?) ─► Set up, gym locked
       ├ At home    ─► Which board? (art tiles) ─► Set up
       └ A Spraywall ─► /boards/spray/new (unchanged)
```

1. **Where's the board?** Three `ChoiceCard`s. Every + opens it (the picker's, Manage boards', the picker's empty state). From step 2 on the bar has a back chevron and no title; the body says "Step N of M" (`StepCounter`), counting only the screens the climber sees (`wizardStepPosition`, `src/lib/boards/add-board-wizard.ts`): the gym path is 4 steps, the home path 3. A gym that isn't listed is 4 steps with a type chosen on the map (Add your gym, then Set up) and 5 without (Add your gym, Which board?, Set up); Which gym? can't know that in advance and says 2 of 4, and every screen from Add your gym on agrees on the total.
2. **Which gym?** is `GymStep`: one page inside the Boards sheet, never a second sheet. A pinned block under the bar holds the step counter, the title "Which gym?" and the search field; on iOS it starts below the transparent glass bar (`useTransparentHeaderInset`), so the back chevron covers nothing. Under it is `MapCardList` (`src/components/gym-directory/`), built from the /gyms parts (`GymMap`, `GymSearchField`, `GymLocationPrompt`): one scrolling list whose header is the map as an inset card (30% of the page, 150 to 240 pt, a locate button top-right), then the "Any board" capsule, which sticks once the card has scrolled away, then the rows. The card's frame ends where the rows begin, so Apple's Maps / Legal link is never covered (expo-maps has no inset prop). There is no grabber and no second panel: the list is the page's one vertical gesture. On Android the same order sits under the opaque bar. In a browser there is no map, so the page is the list alone, at most 672 pt wide.
   - Location is never asked on open. The step reads a permission already given (`requestIfAllowed`); otherwise the map shows the whole world and the list shows the location prompt, whose button asks (or opens Settings once refused for good). The locate button flies back to the climber (dropping a picked town), or asks for location when there is no fix yet.
   - Typing filters gyms by name (`searchGyms`, 2+ characters, once the text is still) and suggests up to five towns (`searchPlaces`), listed as a "Places" section at the top of the list (`suggestionsPlacement="inline"`), not floating over it. Focusing the field folds the map card away, and it stays folded while anything is typed, so a drag of the results never regrows it under the finger; a town pick, Clear or the locate button bring it back. New results start from the top. Picking a town flies the map there and lists the gyms within 50 km, with no location needed; editing it clears it. Panning the map from a real centre re-runs the search around the new centre, and so does zooming the world view in to a region (zoom 8 or closer).
   - Each gym row shows its name, the distance from the climber (only when their location is known) and the address (the line is left out with neither), an "N boards" pill, and "Run by the gym" for gyms their staff run. Listings that share a name are not folded: the address tells them apart.
   - A failed lookup says so with Try again, never "no gyms".
   - One "Any board" capsule menu narrows the gyms to a board type and carries that type on.
   - A pin tap only selects its row, scrolling only as far as it takes to show the row whole, so the map stays in view. A row tap opens that gym's boards (step 3). "Add my gym" is pinned at the bottom of the page, above the home indicator, and moves to the end of the list while the keyboard is up (sign in first when signed out): it opens Add your gym (step 3a below), carrying the type chosen on the map.
   - Telemetry (`gym-finder-events.ts`, surface `wizard_gym_step`): `Gym Finder Gym Picked` with `section` list or map_pin (the row a pin had selected), `Gym Finder Add My Gym Tapped`, `Gym Finder Search Used` (town or name, once each per visit) and `Gym Finder Locate Tapped`. The gym map (/gyms) sends the first and third with surface `gyms_map`.
3a. **Add your gym** (`/boards/add/new-gym`, `NewGymStep` in `src/components/board-discovery/new-gym-step/`) creates the gym before its board, with `createGym`. Same shape as Which gym?: a pinned block (counter, "Add your gym", the name field, a town-or-address search), then `MapCardList` with Save pinned at the bottom.
   - **Name**, required, trimmed, 1 to 100 characters. **Location**, required: the map card's centre, marked with a fixed dot the climber moves the map under. It starts at the device fix when location was already allowed (no prompt on open; "Use my location" and the card's locate button ask), or at a typed address geocoded on submit (`useGeocodePlace`). A town picked from the search's suggestions only flies the map there (zoom 13): its centre is rarely the gym, so Save waits until the climber has moved the map under the dot. Zoomed out past 11 the centre means a region, so there is no pin and the line says to zoom in. A location read again when the app comes back to the front only starts a pin nobody placed or follows a pin that is still the device fix; it never moves a map the climber panned, zoomed out or searched. **Address**, optional, seeded from a typed address search (never from a town) until the climber edits it. Save stays disabled until there is a name and a savable pin. The gym is created public and listed; its owner is the climber, so it reads "Added by a climber" (`CLIMBER_LISTED`) and the board link check passes.
   - **Camera reports.** Every report counts: it is applied once the camera has been still for 250 ms. A report away from a move the app made (a fix, a town, an address), inside that move's 1.5 s window, may be a frame of the flight, so it is held and applied as the climber's pan if nothing nearer the target came by the window's end. A report that settles within about 50 m of the target ends the move and keeps the pin's source. iOS reports once at a move's end, Android every frame; both land the same way. Save applies a pan that ended a moment ago, and keeps the last good pin while one of the app's moves is still flying.
   - Where the map can't draw (a browser, a broken native map) the card folds away, towns are not offered, and the location is the device fix or a geocoded address; the line says "We'll put your gym …".
   - **"Is it one of these?"** As the name (2+ characters) and pin settle (500 ms), `findSimilarGyms` runs (`useSimilarGyms`, `src/lib/graphql/hooks/use-create-gym.ts`). Matches show above the address as "Already listed nearby", in the Which gym? row style. A tap opens that gym's Boards at {gym}, as a pick on Which gym? would; Claim (only where `isClaimable`) opens the gym's page in the Boards stack, where the claim lives. "No, add a new gym" adds them to the acknowledged list for that question only: the name (trimmed, any case) and the pin where they were dismissed. A new name, or a pin more than 150 m from there, starts the list over, so a gym dismissed 3 km away is asked about again once the pin is on it.
   - **Save** (`useCreateGym`) sends `REJECT_IF_FOUND`, or `CONFIRMED_SEPARATE` with the gyms dismissed so far (most recent 50). A `GYM_SIMILAR_EXISTS` refusal puts its gyms in the same list, scrolled into view; "No, add a new gym" then saves again at once, naming every gym dismissed. `GYM_LIMIT_REACHED` says so under the form. Any other failure says it couldn't add the gym, with the form kept.
   - **While a save is out** the screen can't be left: `usePreventRemove` holds the back chevron and Android's back, and the iOS swipe is off. A save that lands after the screen went anyway (the whole Boards sheet closed) moves nothing; the gym exists and Which gym? lists it. Leaving mid-save is not `Board Builder Abandoned`, so one flow never reports both that and `Gym Created`.
   - **Hand-off.** The new gym's screen REPLACES itself (`router.replace`): Set up with the gym locked when the type is known, else Which board? carrying `gymUuid` on to Set up. Back from either lands on Which gym?, where the new gym is now listed, never on a filled-in form whose Save would add a second copy; a guard in the form also refuses a second Save while the first is out. The locked gym's hint says it was just added. `focusLocation` is no longer sent.
   - Telemetry: `Add Board Wizard Step Viewed` with step `new_gym`, and `Gym Created` (`gymCreated` in `gym-finder-events.ts`) with `surface: wizard`, `similarShown`, `confirmedSeparate`, `hasAddress` and `locationSource` (device, map or address; never town, which can't be saved).
3. **Boards at {gym}** is `GymWallList`, named in the body instead of the bar. It calls `existingWallCandidates` with no draft, so its walls go on an "At {gym}" shelf, with "Listed nearby" for the 150 m listings and the gym's other board types collapsed under "Other boards here". A tap is "Use this board" (`useTakeExistingWall`): follow unless already followed or owned, then bind.
4. **"My board isn't listed"** opens a confirm when walls are listed, as a speed bump; it acknowledges nothing. With no walls it goes straight on; when the lookup failed it reads "Add it anyway". It opens Set up with the type chosen on the list and the gym locked (the gym row shows it with a lock; going back is how to pick another, and from a gym page the hint says the gym came from that page). The type is already known here, so Which board? is skipped. A gym board opens on its type only, with no layout or size preselected: the wall is shared by everyone at the gym, so it never saves a guessed setup, and `Board Created.preset` is false. The builder's Save is then checked as above. A gym with no coordinates (and not the viewer's to edit) would fail the 150 m link check, so it offers Report a problem instead. Save waits until the prefilled gym has loaded, so a board never saves without its gym; a gym that turned out to be gone unlocks with "Choose another gym".
5. **Which board?** (`BoardTypeStep`) is three art tiles for MoonBoard, Kilter and Tension (95% of created boards), each the board's real art at the setup Set up opens on (`boardTypeArt`), then an "Other boards" list of the other types by name. Below 340 pt or with text over 130% every type is a row. On the home path a tap opens Set up on that type's most used layout and size (`presetBoardConfig`); on the gym path (after Add your gym, with no type chosen on the map) on the type only, as above, with the new gym locked.

A step that opens as the first screen of its stack (a gym page pushes Boards at {gym} into a fresh boards modal) gets an X instead of the missing back chevron. Back from one step to the step under it is not reported as `Board Builder Abandoned` (`use-stepped-back-in-wizard.ts`); leaving the wizard is, once, from the step the climber left.

Entries that already know the answer skip ahead:

- A gym page's Set up a board opens Boards at {gym} as step 1 of 2.
- The picker's In range "It's my own board" (a box it heard but couldn't name) opens Set up directly with the type and, when exactly one box of that type was heard, its serial (`heard-serial-offer.ts`). It is the flow's only screen, so it shows no counter.
- First run ("Where do you climb?") keeps its inline At a gym carousel (it binds 90% of first boards in a median 10 s) and shows step 1's words on its cards; At home opens Which board? as step 2 of 3.
- An old `/boards/where`, `/boards/find-wall` or bare `/boards/create` link lands on the matching wizard step (`legacy-board-routes.ts`), counted as `entry: link`.

**Set up with the wizard on** (`BoardForm` `setupStyle="rows"`). The art is 200 pt tall (260 before) with no tile behind it. Board, Layout and Size are inset-grouped rows (`BoardSetupRows`): a native menu (`AppMenu`) for up to 8 options, or a pushed checklist (`/boards/add/setup-option`, handed back through `setup-option-handoff.ts`) for more, which today is only Kilter Homewall's 10 sizes. Picking the value already ticked changes nothing (the builder's selects are no-ops for it), so a menu tap on the current layout no longer resets the size and sets. Holds keep their chips, restyled for everyone, flag or not, to the grade rail's look: a fill capsule with a transparent 1 pt border at rest, the selection wash with a visible 1 pt ring when picked, so a label never moves. Angle, Name and Gym follow; More options stays collapsed. The existing-wall check, the serial-reuse check, `ExistingWallsSheet`, the duplicate sheets and the heard-serial line all work as before.

A failed lookup is never drawn as "no boards".

**Near misses on the "already has" sheet.** The gym's wall list has no setup to compare against, so near misses are sorted out in the builder, where the climber's setup is known. `arrangeExistingWalls` (`src/lib/boards/near-miss-walls.ts`) puts the sheet's walls on three shelves, in order:

1. Same setup: the refusal's `EXACT` walls.
2. Set up differently: its `SETS_DIFFER` walls, each with what differs in catalogue words ("Missing Screw-on Feet", "Also has Hold Set C").
3. Possible setup mismatch: walls on another layout or size ("2016 layout. Yours: Masters 2019").

A refusal never names the third kind, since they never block. When the sheet opens, the builder calls `existingWallCandidates` once with the draft (the gym it sent, or else the gym a named wall is on) and keeps its `LAYOUT_OR_SIZE_DIFFERS` walls. A wall from a public listing within 150 m keeps that listing's name and distance on its row ("Boulder Space Annex · 82 m away"), since a second listing of the same gym is where copies hide. The sheet's title counts every wall it shows. That lookup is advisory: if it fails, the shelf is left out and nothing else changes. These walls are never acknowledged on "Keep setting up mine". The shelf follows the app's own `classifyWallMatch` of the draft against each wall. A named wall neither side can place goes on Set up differently, so it is never acknowledged unseen.

The lower shelf only appears alongside a refusal. If a gym's only copy is on another layout (a seeded 2016 record, and the climber sets up a Masters 2019), Save is not refused and this sheet never opens. The wizard's Boards at {gym} still shows that wall under "At {gym}".

A same-setup row takes the wall as before. A near-miss row asks "Is this your wall?" inside the same sheet, not in a second sheet stacked on it:

- **Use it as it is.** Same path as Use this board.
- **Use it and fix its setup.** Offered only where Report a problem is (`directory-reports` on, and not a wall the climber can edit). The wall is followed. Then the sheet dismisses and waits to settle, and the wall is bound. The bind's `onBound` opens `ReportDirectorySheet` through `useReportProblemHost` on "Set up wrong", with the climber's setup in the setup fields (`initialReason`, `initialSetup`). With `directory-setup-suggestions` off, the setup is written into the note instead. Nothing is sent until the climber taps Send. The builder leaves once the report sheet has fully slid away (`closeAfterDismissed`), or once the claim sheet it hands over to has closed. `onClosed` always fires, even if no sheet could open or its host went away mid-handoff, so the builder never waits forever. A report nobody has touched closes without asking to discard it. If the setup fields appear late (the flag resolving), the generated note is dropped, unless the climber has edited it. The report's own "Climb it now" is hidden (`climbNowOffered: false`): the wall is already active, and a fix that applies reaches it there.
- **No, it's a different wall.** Back to the list.

`Board Wall Candidate Used` carries `match: near_miss` for both near-miss shelves, and `fixSetupStarted`. `Board Wall Candidates Shown` fires once the follow-up lookup has settled, with `mismatchCount` and `mismatchLookup`.

**Setup clarity in the builder.** The hold sets moved out of More options into the main form, under "Holds: 3 of 4 sets" (`BoardHoldsSummary`). Change opens the set chips. On a Masters 2017 or 2019 without its Screw-on Feet, `likelySetupOmissions` adds "Missing Screw-on Feet?" with a one-tap Add. Partial setups stay allowed.

**Catalogue errors on the right row.** Before Save goes out, `findUnknownSetupField` (`@boardsesh/board-config`) checks the setup against the bundled catalogue in the server's order: layout, size, then sets. A server `UNKNOWN_BOARD_CONFIG` is read with `readUnknownBoardConfigError` (`@boardsesh/graphql`). Either way the error is drawn under the board type, layout, size or holds row, and the form keeps its state. Refused sets open the set chips, with a one-tap remove for the ones still picked. The error goes away once the setup changes. An older server that names no field gets one line of our own at the top of the form. Both report `Board Create Failed` with `error_reason: unknown_config`.

## Out of scope

- Spray walls. They have their own setup wizard.
- Implicit creates: deep links, session join and `board-path-to-user-board`. They send no gym.
- Relinking after a create (`linkBoardToGym`) and config edits (`updateBoard`). A follow-up issue.
- Old binaries and clients with the feature flag off, until the server makes `REJECT_IF_FOUND` the default.
- Production merges and ownership transfers. The global-admin MCP repair tools cover those (see `gym-board-governance.md`).

## Rollout

The backend must be in production before the app's OTA that sends `existingWallCheck`: an unknown input field fails GraphQL validation on an older backend. The PostHog flag `add-board-wizard` (which replaced `create-board-gym-first`) gates only the app's new screens. The app always sends `existingWallCheck`, so the server check runs whether or not the flag is on.

Analytics: each wizard screen sends `Add Board Wizard Step Viewed` (`step`, `path`, `entry`); step 1 sends `Board Kind Chosen` with `surface: where` (kind `spray` for a Spraywall); `Board Created` and `Board Builder Abandoned` carry `wizardPath` and `wizardEntry`, so builder completion (69% of 1,058 before the wizard) compares by entry with the flag on and off.

Tests: `packages/backend/src/__tests__/existing-wall-check.test.ts`, `packages/shared/board-config/src/__tests__/wall-match.test.ts`, `packages/shared/graphql/src/__tests__/existing-walls-error.test.ts`, and the `UNKNOWN_BOARD_CONFIG detail` block in `board-catalog-validation.test.ts`. The app's near-miss and setup half: `near-miss-walls.test.ts`, `ExistingWallsSheet.test.tsx`, `BoardHoldsSummary.test.tsx`, the hold-set block in `BoardForm.test.tsx`, the builder prefill block in `ReportDirectorySheet.test.tsx`, the near-miss and catalogue-error blocks in `app/boards/__tests__/create.test.tsx`, `setup-validation.test.ts` and `unknown-board-config-error.test.ts`. The wizard: `add-board-wizard.test.ts` (step counting and routes per entry), `new-gym-step-state.test.ts` and `NewGymStep.test.tsx` (Add your gym), `board-type-tiles.test.ts`, `setup-option-rows.test.ts`, `add-wizard-routes.test.tsx`, `BoardTypeStep.test.tsx`, `BoardSetupRows.test.tsx`, the rows block in `BoardForm.test.tsx`, the wizard blocks in `create.test.tsx`, `GymWallList.test.tsx` and `layout.test.tsx`, and the `where.test.tsx` / `find-wall.test.tsx` redirects.
