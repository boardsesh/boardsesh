# Changelog

User-facing changes to Boardsesh, newest first. Auto-generated from the "Release
Notes" section of merged pull requests — do not edit by hand (a CI check rejects
manual changes). See docs/mobile-ota-updates.md.

## 2026-08-30

### New

- Board previews now load without waiting on the old image-function cold start. ([#4821](https://github.com/boardsesh/boardsesh/pull/4821))
- Your work in the climb creator is kept on your phone now, in every mode — editing a draft, remixing a climb, or picking up after you've already saved once. Kill the app mid-build and it's all still there when you come back. ([#4770](https://github.com/boardsesh/boardsesh/pull/4770))
  A line under the Save button always tells you where your climb is: on this phone, in your account, or waiting on edits you haven't saved yet.
  The trash button clears holds and nothing else. Starting a fresh climb is its own button, and it asks first if the one you're on isn't saved anywhere.
  Undo stays put on the row instead of sliding off once a climb has more than one frame.
  Publishing now asks for a start and a finish hold. Drafts save with whatever you've got.
- One Boards page instead of two. "Change board" and "My Boards" were the same list with different buttons — now it's one place to switch, edit, and clear out boards. ([#4736](https://github.com/boardsesh/boardsesh/pull/4736))
  Every board in "Your boards" says whether it's yours or one you follow, and the board you're on now reads "Active" instead of a bare tick.
  Tap Edit to delete a board you own or stop following someone else's, straight from the card. Swiping a row to delete is gone — the Edit button replaces it.

### Fixed

- Connecting over Bluetooth identifies your board correctly instead of naming someone else's Kilter board ([#4864](https://github.com/boardsesh/boardsesh/pull/4864))
  You can register a Kilter and a Tension controller that share a serial number without one being rejected as a duplicate

## 2026-08-29

### New

- Woods boards stop glowing in dark mode — the white wall drops away and the holds sit ([#4778](https://github.com/boardsesh/boardsesh/pull/4778))
  straight on the dark background, in the app and on the site.

### Fixed

- Filter the gym map by Woods and MoonBoard boards for real — picking Woods now offers Original plus the 8×10 and 12×12 sizes instead of an empty row ([#4775](https://github.com/boardsesh/boardsesh/pull/4775))
- Filter Woods climbs by board region — draw a box on the wall and keep only the climbs that stay inside it, or the ones that reach into it ([#4777](https://github.com/boardsesh/boardsesh/pull/4777))
  Search Woods climbs by hold, including the bottom row that used to be ignored
- Email sign-in now works when your account email contains uppercase letters. ([#4846](https://github.com/boardsesh/boardsesh/pull/4846))
  The old Android split-screen sign-in warning is gone.

## 2026-08-28

### App update

A new version shipped to the App Store and Play Store.

## 2026-08-27

### New

- Tap a hold in the climb editor to cycle through its role (hand, start, finish, foot) instead of needing a long press to change it once it's set. ([#4830](https://github.com/boardsesh/boardsesh/pull/4830))
- Tag climbs as "no kickboard" or "campus" (no feet) right in the climb editor, alongside no-matching. ([#4831](https://github.com/boardsesh/boardsesh/pull/4831))

## 2026-08-26

### Fixed

- Read toast messages clearly in light and dark mode. ([#4815](https://github.com/boardsesh/boardsesh/pull/4815))
- Board images now refresh when we improve the renderer, instead of showing you last month's version for up to a year. ([#4780](https://github.com/boardsesh/boardsesh/pull/4780))
  Every board photo, hold overlay and share card on the site now carries a version stamp, so a fix to how holds are drawn reaches you on the next page load.
- Gym TVs and website embeds light up straight away — no login check standing between the screen and the wall. ([#4589](https://github.com/boardsesh/boardsesh/pull/4589))
- Starting a big playlist no longer dies on one dropped page: a flaky page retries on its own, and backing out of a playlist actually cancels the load. ([#4713](https://github.com/boardsesh/boardsesh/pull/4713))
- Kilter playlists that got cloned when you re-linked your account are merged back into one. Your edited version is the one that survives, with its pins and follows intact. ([#4747](https://github.com/boardsesh/boardsesh/pull/4747))
- Similar climbs, climb details, board-presence live sends, playlists, and the setter filter now all work on boards set to a negative tilt ([#4677](https://github.com/boardsesh/boardsesh/pull/4677))

## 2026-08-25

### New

- Woods Board owners can add their 12×12 or 8×10 board and browse 5,400+ climbs ([#3306](https://github.com/boardsesh/boardsesh/pull/3306))
  Light up any Woods climb over Bluetooth straight from the play view
  Grades, setters and angles come straight from the Woods app, so the problem you are projecting is the one you will find here
- Play back routes up to 5x slower (down to 0.1x) ([#4708](https://github.com/boardsesh/boardsesh/pull/4708))
- The queue now shows who put each climb up while you're in a session with your crew. ([#4727](https://github.com/boardsesh/boardsesh/pull/4727))
  A small face sits on every row someone else added — upcoming, current, and the ones you've already worked through. Your own adds stay clean.

### Improved

- Say thanks to xprem, the update server that gets fixes to your phone without an app store wait ([#4784](https://github.com/boardsesh/boardsesh/pull/4784))
- Tapping and swiping through climbs in a shared session puts them on the wall again, the way it did before the last update. ([#4745](https://github.com/boardsesh/boardsesh/pull/4745))

### Fixed

- Room for real beta when you log a send: the note box opens two lines tall and grows to hold a full paragraph, so what you're writing stays on screen instead of scrolling out of sight. ([#4718](https://github.com/boardsesh/boardsesh/pull/4718))
- Re-linking your Kilter account no longer clones every playlist you already had — your existing lists get linked back up instead of sprouting a stale twin at the top of the list. ([#4746](https://github.com/boardsesh/boardsesh/pull/4746))
  Playlists you've edited in Boardsesh keep your version. Kilter's older copy no longer overwrites them.

## 2026-08-23

### New

- Browsing with your crew is now free: in a session with more than one climber, swiping and tapping around never touches the queue or the wall. One button — "Put on the wall" — makes the change, and if someone just lit a climb, the app checks before taking it. ([#4683](https://github.com/boardsesh/boardsesh/pull/4683))
  Changing the angle mid-browse keeps your spot instead of kicking you back to the live climb.

### Fixed

- Fixed the Send/Save button being cut off below the screen when logging or editing a tick on Android ([#4684](https://github.com/boardsesh/boardsesh/pull/4684))
  Fixed note text appearing cut in half when typing a note on Android
- Climbers with very large Kilter histories now sync completely instead of giving up partway. ([#4690](https://github.com/boardsesh/boardsesh/pull/4690))
- Your Kilter ratings, ticks and circuits sync again — a bad rating could jam the whole sync, and for some climbers it had been stuck for over a month. ([#4686](https://github.com/boardsesh/boardsesh/pull/4686))

## 2026-08-22

### New

- The user-visible half of #4583 — tier-2 climbs actually reaching Google — shipped in #4661 and was verified in production there. What is left here is observability: nothing a climber sees, and a "What's New" line about a sitemap response header would be noise. ([#4676](https://github.com/boardsesh/boardsesh/pull/4676))
- The play view now shows at a glance whether the climb on your screen is the one lit on the wall — a pill in the header reads "On the wall", "Live", or "Browsing". ([#4666](https://github.com/boardsesh/boardsesh/pull/4666))
  Previewing a climb got cleaner: a proper "Put on the wall" button replaces the old orange banner, and the board art gets the space back.

### Fixed

- Ending a session is now a labelled button — "Stop" if you started it, "Leave" if you joined — instead of a bare flag icon. ([#4660](https://github.com/boardsesh/boardsesh/pull/4660))
- Shared climb links open the climb again instead of a not-found page, on the web and in the app. Every MoonBoard link was affected, and so were about 48,000 Kilter climbs. ([#4576](https://github.com/boardsesh/boardsesh/pull/4576))
  MoonBoard links now light exactly the hold sets named in the URL. Masters 2017 and Masters 2019 links were quietly dropping Screw-on Feet, and a single-hold-set link lit the whole layout.
- Only affects a climb view URL that was already broken (an infinite-redirect 500-adjacent error page); nothing a climber would describe as a feature getting better. ([#4592](https://github.com/boardsesh/boardsesh/pull/4592))

## 2026-08-21

### New

- Added two settings to control when the board lights up automatically: on swipe between climbs, and on tapping a climb in a list (both on by default). When off, the climb opens as a preview you can light with one tap. ([#4640](https://github.com/boardsesh/boardsesh/pull/4640))

### Fixed

- Fixed the long-press climb preview showing a see-through board on Android ([#4639](https://github.com/boardsesh/boardsesh/pull/4639))
- Scrolling by touch (finger drag) now works everywhere in the browser app — climbs list, queue, and logbook. It was completely stuck before if you weren't using a mouse wheel or trackpad. ([#4641](https://github.com/boardsesh/boardsesh/pull/4641))

## 2026-08-20

### New

- Find a climb on Google, tap through, and you see the climb — board, grade, community stats and beta — before anyone asks you to sign in. ([#4605](https://github.com/boardsesh/boardsesh/pull/4605))
  Sign in from there and you land straight back on the climb you came for.
- Nothing is reachable yet — the user-facing note ships with the stacked routing PR. ([#4604](https://github.com/boardsesh/boardsesh/pull/4604))

### Fixed

- Tell your boards apart in the picker: cards now show the gym or location under the name, fall back ([#4541](https://github.com/boardsesh/boardsesh/pull/4541))
  to the layout and size, and add the size, angle or serial when two boards would otherwise read the
  same
  Long board names get two lines instead of being cut off mid-word
- Your circuits keep syncing when a circuit lists the same climb twice — one repeat used to quietly stall every sync for that board account, ticks included. ([#4285](https://github.com/boardsesh/boardsesh/pull/4285))
  Importing an Aurora export no longer drops a circuit that names the same climb more than once.
- The Kilter 12 x 14 now reads "Commercial" instead of "Commerical" in the board picker and in board links. ([#4610](https://github.com/boardsesh/boardsesh/pull/4610))
  Links you shared before the fix still open the same board.
- A climb picked during a busy party session no longer goes missing for the rest of the crew when the app is pacing itself — including a climb you'd cleared off your queue earlier in the session and queued back up. ([#4289](https://github.com/boardsesh/boardsesh/pull/4289))
- Hold shape, marker size and brush thickness now work in the browser app — picking a shape or ([#4587](https://github.com/boardsesh/boardsesh/pull/4587))
  resizing your markers no longer wipes the holds off every climb.
  Brush thickness actually changes how thick the outlines are drawn.
- Gym embeds and kiosk screens no longer sit blank when the backend is slow — a cold render gives up after 3 seconds and shows the retry screen, which reloads itself. ([#4627](https://github.com/boardsesh/boardsesh/pull/4627))
- Sharing a reel into Boardsesh shows the wall for every climb again, so you can spot the right send ([#4620](https://github.com/boardsesh/boardsesh/pull/4620))
  instead of reading down a list of names.
- Managing your own playlist works again on Android: the ⋯ menu's edit row now actually opens edit mode, so you can reorder and pull climbs out. ([#4621](https://github.com/boardsesh/boardsesh/pull/4621))
  Rename a playlist, change its colour or icon straight from the ⋯ menu — no more hunting for the cog.
  Empty playlist? There's a button that takes you to the climbs list instead of a dead end.

## 2026-08-19

### New

- Setter's notes now show up on a climb — the description whoever set it wrote in the create form, right under your logbook in the play drawer and on the climb's web page. ([#4540](https://github.com/boardsesh/boardsesh/pull/4540))
- The gym directory is open to everyone now — browse every gym with a board at /gyms, or filter to just Kilter, Tension or MoonBoard. ([#4534](https://github.com/boardsesh/boardsesh/pull/4534))

### Fixed

- The zoom reset button in the Play drawer says "Reset zoom" again instead of showing raw code ([#4543](https://github.com/boardsesh/boardsesh/pull/4543))
  The gym directory wall finder now has a proper "Clear" on its filter row, and the ascents feed shows its Mirrored and Benchmark tags and who set the climb
- Pages now always render in the language you asked for, even when the site is busy serving several languages at once ([#4545](https://github.com/boardsesh/boardsesh/pull/4545))
- Fixed the gyms map crashing in the browser when location access is blocked — you'll now see a note pointing you to the search box instead. ([#4546](https://github.com/boardsesh/boardsesh/pull/4546))
- Log a tick while a board is downloading and it sticks — the app now waits its turn for the database instead of quietly dropping the send. ([#4557](https://github.com/boardsesh/boardsesh/pull/4557))
- Adding a climb to a playlist from another board now fails cleanly instead of ([#4304](https://github.com/boardsesh/boardsesh/pull/4304))
  leaving a ghost entry you can't tap off again.
- Dragging a climb in a playlist now drops it exactly where you let go, even when the playlist holds a climb the catalog has lost track of. ([#4294](https://github.com/boardsesh/boardsesh/pull/4294))
- Queues you share with your crew stop losing climbs: when someone adds a climb while you're activating a playlist or reseeding the queue, their climb now sticks around instead of vanishing. ([#4296](https://github.com/boardsesh/boardsesh/pull/4296))
- Signing in with Google or Apple on the web now brings you back to Boardsesh instead of dumping you on a dead localhost page. ([#4264](https://github.com/boardsesh/boardsesh/pull/4264))
- Downloading a board for offline use no longer drops out partway through the grade sync when the servers are busy. ([#4538](https://github.com/boardsesh/boardsesh/pull/4538))
  Your logbook and stats load reliably during peak hours instead of erroring out.
- Fixed the Save button getting pushed off-screen when editing a multi-frame route/circuit in the climb editor ([#4530](https://github.com/boardsesh/boardsesh/pull/4530))

## 2026-08-16

### New

- Admin-only tooling; no user-facing surface. ([#4520](https://github.com/boardsesh/boardsesh/pull/4520))
- Your Progress tab now shows how this period's sends stack up against the last one — flip between "vs. last period" and "vs. same time last year" to see your trend. ([#4482](https://github.com/boardsesh/boardsesh/pull/4482))
- Print a QR poster for your gym straight from the manage console — one page, A4 or Letter, in English, Spanish, French or German. ([#4516](https://github.com/boardsesh/boardsesh/pull/4516))
- Find the boards near you — the gym directory now has a map and a "use my location" search, with a city search to fall back on if you'd rather not share it. ([#4517](https://github.com/boardsesh/boardsesh/pull/4517))
- Claimed a gym? Your page now says it's under review, and we email you either way once we've looked at it — approved or not. ([#4515](https://github.com/boardsesh/boardsesh/pull/4515))
- Flag-gated and noindex; Tier 2 launches it publicly. ([#4512](https://github.com/boardsesh/boardsesh/pull/4512))
- Scan a gym's QR code and the app knows which poster or kiosk sent you — so gyms can finally see what their signage is actually doing. ([#4510](https://github.com/boardsesh/boardsesh/pull/4510))
- Owners can put a real photo of their wall on their gym page — upload it from the manage console and it becomes the header image and the preview when someone shares the link. ([#4509](https://github.com/boardsesh/boardsesh/pull/4509))
- Own a gym? You can start a claim straight from its page now, without signing in first — log in when prompted and you'll land right back where you were, ready to claim it. ([#4506](https://github.com/boardsesh/boardsesh/pull/4506))
- Backend fields only; the directory that consumes them ships flag-gated and noindex in a later PR. ([#4505](https://github.com/boardsesh/boardsesh/pull/4505))
- Pure instrumentation: no UI, copy, or behaviour changes. ([#4503](https://github.com/boardsesh/boardsesh/pull/4503))
- Gyms can post their opening hours, and the page shows the date the owner last confirmed them — so you know the hours are current before you drive over. ([#4502](https://github.com/boardsesh/boardsesh/pull/4502))

### Fixed

- Analytics identity wiring; no user-visible change. ([#4526](https://github.com/boardsesh/boardsesh/pull/4526))
- Sitemap caching and post-deploy smoke; no user-facing change. ([#4522](https://github.com/boardsesh/boardsesh/pull/4522))
- CI and test-fixture typing only. ([#4521](https://github.com/boardsesh/boardsesh/pull/4521))

## 2026-08-15

### New

- No user-visible change: this ships the contract module only, and nothing calls it until the wiring PR lands. ([#4501](https://github.com/boardsesh/boardsesh/pull/4501))
- En español, un gimnasio ahora es un rocódromo en toda la app — una sola palabra en cada pantalla, en vez de dos. ([#4500](https://github.com/boardsesh/boardsesh/pull/4500))
- Popular climbs that resolve to a stable board setup start showing up in Google under the same link the page itself uses. ([#4483](https://github.com/boardsesh/boardsesh/pull/4483))
  Search results say something useful: setter, grade, stars and the board a climb lives on, instead of a bare title.
  Star ratings only show where the number behind them is honest — a climb whose ratings haven't been converted to the 5-star scale ships without one rather than with a wrong one.
- Boardsesh pages are easier to find from search — every board setup and public playlist now tells search engines where to look. Gym and setter pages are wired up and land next. ([#4464](https://github.com/boardsesh/boardsesh/pull/4464))
- Expo web now starts dark and uses the roomy tablet layout on desktop. ([#4471](https://github.com/boardsesh/boardsesh/pull/4471))
  Open a climb without losing the full action bar, queue, logbook, beta, community, or similar climbs.

### Improved

- Settings on the web now keeps what only the web can do — your ESP32 board controller, and setting a password if you signed in with Google or Apple. Your profile, connected apps and account deletion live in the app, and the page links you straight there. ([#4491](https://github.com/boardsesh/boardsesh/pull/4491))
- Notifications live in the app now — who followed you, who commented, whose proposal landed. The old web page hands you straight over. ([#4490](https://github.com/boardsesh/boardsesh/pull/4490))
- Climb and board pages now stay up when the database is slow, and stop turning a bad moment into a "page not found". ([#4481](https://github.com/boardsesh/boardsesh/pull/4481))
  MoonBoard board pages load from cache instead of running a fresh search every time.
- These endpoints have had no in-repo caller since the GraphQL migration and nothing climber-visible changes. If the new counter shows real third-party traffic, W-25b writes the climber-voice note instead. ([#4489](https://github.com/boardsesh/boardsesh/pull/4489))
- Your feed, your stats and your profile live in the app now. Share links you've already sent keep working — www still opens every session, join link and climb page. ([#4479](https://github.com/boardsesh/boardsesh/pull/4479))
- Installing the browser app now works. Open `app.boardsesh.com` in Chrome or Safari and you'll get the "Add to Home Screen" prompt, launching straight into the app instead of a browser tab. ([#4480](https://github.com/boardsesh/boardsesh/pull/4480))
- The website is now the fast front door — browse and share climbs there, and do your climbing in the app. ([#4467](https://github.com/boardsesh/boardsesh/pull/4467))
- Board pages slim down to the essentials — browsing and climbing live in the app now. ([#4448](https://github.com/boardsesh/boardsesh/pull/4448))
  Every old board link still works: liked climbs, logbooks and playlists send you to the right place, and creating or remixing a climb opens the app on the board you were already looking at.
  Importing MoonBoard screenshots moved to its own page — pick your board and drop the shots in.

### Fixed

- [x] This change is internal-only and needs no release note. ([#4484](https://github.com/boardsesh/boardsesh/pull/4484))
- Download several boards for offline use without getting stuck after the snapshot finishes. ([#4469](https://github.com/boardsesh/boardsesh/pull/4469))
  Pocketing your phone now resumes the download cleanly, and a slower fallback shows real progress instead of an interrupted spinner.
- Similar climbs and offline board stats keep loading during busy sessions. ([#4468](https://github.com/boardsesh/boardsesh/pull/4468))
- Keep every climber's sends and sessions together when the same wall was registered more than once ([#3422](https://github.com/boardsesh/boardsesh/pull/3422))
  Saved walls now switch to the surviving board automatically after a merge
  When a wall is already on Boardsesh, join the existing board or deliberately create a separate one
- Grouped notifications open climbs with the correct board layout and angle, even across back-to-back releases. ([#4455](https://github.com/boardsesh/boardsesh/pull/4455))
- Claiming a gym with your work email now auto-approves only when the gym's owner is the one who put that website on the listing. Anything else gets a quick human check first, so nobody can hand themselves the keys by editing the website field. ([#4058](https://github.com/boardsesh/boardsesh/pull/4058))
  Fixes #3431
- Offline board downloads recover automatically and keep bulk catalog updates on the fast CDN download instead of crawling through hundreds of 500-climb batches. ([#4456](https://github.com/boardsesh/boardsesh/pull/4456))

## 2026-08-14

### New

- Notifications now live in the app — see who liked your sends and follows your climbing without opening the website. ([#4432](https://github.com/boardsesh/boardsesh/pull/4432))
- Climb pages load fast and clean — see the problem, the grades, and one tap into the app to climb it. ([#4430](https://github.com/boardsesh/boardsesh/pull/4430))
  Every climb on your board is now one page away, and findable in search.
- Build routes and circuits, not just single-frame boulders — duplicate a frame, edit the copy, and step through your sequence as you build it. ([#4422](https://github.com/boardsesh/boardsesh/pull/4422))
  Forking or editing an existing route no longer collapses it into one frame.
- Climb lists are real links now — open a climb in a new tab, share it straight from the list, or land on it from a search. ([#4421](https://github.com/boardsesh/boardsesh/pull/4421))
- We now measure how fast every board download actually runs, so we can chase the slow ones instead of guessing, and we check each downloaded board is complete before using it. ([#4405](https://github.com/boardsesh/boardsesh/pull/4405))
  Faster download paths for iPhone are behind a switch we'll turn on once we've timed them on real phones.
- Set up any MoonBoard at more than the usual 25° and 40° — grade and log it there like any other angle, on web or in the app. *(Rolling out gradually — ask if you don't see it yet.)* ([#4419](https://github.com/boardsesh/boardsesh/pull/4419))
- No user-visible native change. The gate relaxation and the `?next=` return are web-fork-only, asserted inert on native by the two suites above. What does reach the store fleet is one additive analytics capture per board-route open — no navigation, no copy, nothing on screen — so there is nothing for the "What's New" screen. The user-visible copy for this flow ships with the www front door in #4369. ([#4418](https://github.com/boardsesh/boardsesh/pull/4418))

### Improved

- Session share pages load lighter — the climb list and comments, without the whole queue stack. ([#4423](https://github.com/boardsesh/boardsesh/pull/4423))
  Every climb in a shared sesh is a real link, pointing at the board it was actually climbed on. Paste one to a mate or open it in a new tab.
- The homepage board rail is real links now — open any board in a new tab or straight from search. ([#4424](https://github.com/boardsesh/boardsesh/pull/4424))
  Playlists open in the app with one tap.

### Fixed

- Internal-only fix to a connection-scoped in-memory flag with no shipped ([#4284](https://github.com/boardsesh/boardsesh/pull/4284))
  user-visible consumer (mobile only reads it for a drift-telemetry signature).
- Editing a board's or gym's location saves cleanly on self-hosted setups without PostGIS, instead of erroring out on a save that already went through. ([#4269](https://github.com/boardsesh/boardsesh/pull/4269))
- Moving the last board off an auto-generated gym listing now folds that listing into your gym instead of leaving an empty duplicate in gym search — old links still land on the right place. ([#4277](https://github.com/boardsesh/boardsesh/pull/4277))
  The Boards tab tells you when a board is the last one on its listing, and asks before it merges.
- Switching a board off and straight back on no longer leaves it stuck on "waiting to download" — the download starts again as soon as the old copy finishes clearing out. ([#4450](https://github.com/boardsesh/boardsesh/pull/4450))
- The playlists page shows loading placeholders and gives you somewhere to go when it is empty. ([#4431](https://github.com/boardsesh/boardsesh/pull/4431))
- Fixed: holds can be tapped again when creating or editing a climb on Android. ([#4425](https://github.com/boardsesh/boardsesh/pull/4425))
- Clearing one board out of storage no longer stops your other boards downloading — remove a wall you're done with and the rest keep coming down. ([#4404](https://github.com/boardsesh/boardsesh/pull/4404))
- Log a send while your phone's storage is tied up — mid board download, or right after you clear a board out — and it no longer disappears. Boardsesh retries the save, queues it for the next sync if the storage is still busy, and if it truly can't stash it offline it tells you plainly, in your own language, instead of swallowing the send. ([#4402](https://github.com/boardsesh/boardsesh/pull/4402))
- Feed thumbnails now open the board the send actually happened on. ([#4417](https://github.com/boardsesh/boardsesh/pull/4417))

## 2026-08-13

### New

- Paste a Boardsesh climb link into the app and it opens the climb — the long board URLs the web app hands out now work in the app itself, including localized links and boards like a 12x12 Kilter without a kickboard that previously couldn't be linked at all. Deep links to downloaded boards now open offline too, and a link opened with no signal picks itself up when the connection returns. On the web side, sharing, forking, or switching to that 12x12-without-kickboard now keeps you on the right wall instead of its look-alike. ([#3823](https://github.com/boardsesh/boardsesh/pull/3823))

### Fixed

- MoonBoard sends now land on the angle the problem is graded at, so your send turns up on the page everyone else is looking at instead of vanishing into an angle nobody browses ([#4054](https://github.com/boardsesh/boardsesh/pull/4054))
  The trade: the send lands on the problem's canonical angle, so it stops reading as ticked at the angle your board was physically set to. It still counts, it still shows in your logbook — it just lives at the angle the problem is graded at
  Your recommended climbs stop handing you MoonBoard problems you've already done. A send filed at the angle your board sat at read as unsent to the recommender, so the same problem kept coming back around
  Cleared out the ghost entries that wrong-angle sends had been leaving in MoonBoard search results
  Fixes #3529
- Lock your phone mid-download and the board keeps downloading. Before, the transfer was thrown away the moment the app went in your pocket and started again from zero next time you opened it — on a slow connection the big Kilter board could never finish. ([#4400](https://github.com/boardsesh/boardsesh/pull/4400))

## 2026-08-12

### New

- Your board cards now show at a glance which ones are on your phone, and tapping the download icon grabs one right there. ([#4344](https://github.com/boardsesh/boardsesh/pull/4344))
- When you're out of signal and the board you're on isn't downloaded, the empty screen now offers to grab it — it starts the moment you're back online. ([#4343](https://github.com/boardsesh/boardsesh/pull/4343))
- Finish a session at a board you haven't downloaded yet and Boardsesh now offers to keep the whole catalog on your phone — one tap, and every climb is there next time the gym wifi isn't. ([#4342](https://github.com/boardsesh/boardsesh/pull/4342))
- Boards stuck on the slow download now have a button to try the fast one again, and tell you how big it is before you commit. On mobile data, a board won't quietly start a big download on its own. ([#4333](https://github.com/boardsesh/boardsesh/pull/4333))
- Logging out now asks first, and tells you what it clears — the boards you downloaded, your offline logbook, and any sends still waiting to sync, including the ones that already failed to send. The Log out button in the side menu used to do all that on the first tap with no warning at all. The downloaded boards actually come off the phone now instead of sitting there invisible, and the space comes back. A dropped connection that signs you out on its own leaves your downloads alone. ([#4328](https://github.com/boardsesh/boardsesh/pull/4328))
- Watch your board actually come down. Enabling a board offline now shows the megabytes, a percentage and whether it's downloading or unpacking, instead of a spinner that looked like the app had hung. Kilter takes about three minutes on a good connection — now you can see it happening. ([#4355](https://github.com/boardsesh/boardsesh/pull/4355))

### Improved

- Kilter and Tension downloads finish much faster — Boardsesh grades now arrive with the catalog instead of being fetched a page at a time. Boards you already downloaded pick them up on the next sync too. ([#4347](https://github.com/boardsesh/boardsesh/pull/4347))
- Downloading a board no longer starts over when you lock your phone — a finished download is kept and picked up on the next sync instead of being thrown away. ([#4345](https://github.com/boardsesh/boardsesh/pull/4345))

### Fixed

- Share previews for setters, profiles, playlists and sessions can now be picked up by search engines, which they were silently blocked from before. Boards you've shared as unlisted stay out of search results, and filtered climb lists no longer compete with the clean board page for ranking. ([#4167](https://github.com/boardsesh/boardsesh/pull/4167))
- Removing a downloaded board could fail to hand its space back while the app was busy reading, and stop with a database error instead of just leaving the file a little larger. It now waits for the app to finish and reclaims the space properly. ([#4357](https://github.com/boardsesh/boardsesh/pull/4357))
  Downloads that get interrupted — by locking your phone, or by removing another board mid-download — are now recorded instead of vanishing, so we can see how often a board download stops short and why.
- The freshness fix is real but not observable on any surface that ships today; the surfaces that make it visible are PRs 2-4 in this stack. ([#4341](https://github.com/boardsesh/boardsesh/pull/4341))
- A phone that's out of space no longer burns battery re-drawing board art it can't save — Boardsesh backs off, frees what it can, and keeps the wall photo on screen. ([#4339](https://github.com/boardsesh/boardsesh/pull/4339))
- Board art no longer piles up during a long session — Boardsesh trims it as you browse instead of only at app start. Removing a downloaded board now clears the art it drew for that board, too. ([#4338](https://github.com/boardsesh/boardsesh/pull/4338))
- Offline board downloads now survive a launch with no signal. The app used to check with our servers whether offline mode was switched on for you, and if that check never came back, offline mode switched itself off. Now it stays on unless we deliberately turn it off, so a send logged in a basement gym still gets saved and syncs when you're back on data. ([#4323](https://github.com/boardsesh/boardsesh/pull/4323))
- Tapping "Download" on a board right after opening the app used to do nothing at all if the app was still finishing its local setup — the download quietly never started. Now the tap is held and the download begins the moment storage is ready. Offline data also stops being written against a half-built database on a busy launch, so a board you downloaded shows up as downloaded instead of vanishing. ([#4324](https://github.com/boardsesh/boardsesh/pull/4324))
- A dropped connection while downloading a board no longer condemns it to the slow download path. Boards that got stuck partway through the slow crawl now finish on the fast one by themselves. ([#4326](https://github.com/boardsesh/boardsesh/pull/4326))
- Manage Storage now shows what the board art and photos on your phone actually take up, with a Clear cached images button for when you need the space back. Boardsesh also stops letting downloaded photos pile up without a ceiling, and cleans up board downloads that got interrupted halfway. ([#4334](https://github.com/boardsesh/boardsesh/pull/4334))
- Sharing a phone? Your sends stay yours. The offline database now records who's signed in and checks it before serving anything from your logbook — so if a sign-out ever gets interrupted, the next climber sees their own ticks, not yours. ([#4351](https://github.com/boardsesh/boardsesh/pull/4351))
- Your playlists, likes and logbook now refresh on their own once a background sync lands new rows, instead of waiting for you to pull-to-refresh or reopen the screen. ([#4350](https://github.com/boardsesh/boardsesh/pull/4350))
- Screens that need a connection now say so instead of showing an endless spinner or an empty list. Your progress, sessions, logbook, playlists, gyms and the activity feed all tell you when there's no signal — and remind you that boards you've downloaded still browse, search and log fine. ([#4354](https://github.com/boardsesh/boardsesh/pull/4354))
- Downloaded boards keep their "Your boards" and "Following" sections when you ([#4309](https://github.com/boardsesh/boardsesh/pull/4309))
  open My Boards with no signal.
  JS-only, no native deps, no fingerprint movement — rides OTA.

## 2026-08-11

### New

- Claim a gym that's auto-approved and you'll get a "Set up your gym" ([#4270](https://github.com/boardsesh/boardsesh/pull/4270))
  button straight from the confirmation screen — no more hunting for the
  setup page yourself.
- Talk beta on public playlists — every playlist now has a discussion thread, shared with the web app. ([#4245](https://github.com/boardsesh/boardsesh/pull/4245))
  Signed out? You can still read the thread; sign in to join it.
- Queue climbs from more than one board in the same session. Tap a climb that's set on ([#4250](https://github.com/boardsesh/boardsesh/pull/4250))
  another board and you get the choice: add it anyway, switch over to that board, or
  back out.
- Filter the climb list by the stars you gave: set a minimum, or show only the climbs you've rated ([#4255](https://github.com/boardsesh/boardsesh/pull/4255))
  Works offline on a downloaded board, and re-rating a climb updates what the filter shows

### Fixed

- Fixed dark-mode MoonBoard playlist tiles showing the light-mode board art ([#4282](https://github.com/boardsesh/boardsesh/pull/4282))
  (near-black coordinate lettering) instead of the readable dark variant.
- MoonBoard setter search now shows setters and counts, matching Kilter/Tension. ([#4286](https://github.com/boardsesh/boardsesh/pull/4286))
- Android phones on version 11 or older now get a clear "Location is switched off" message with a one-tap fix when Bluetooth scanning finds nothing, instead of being told to check their board. ([#4283](https://github.com/boardsesh/boardsesh/pull/4283))
- Grasshopper climbs now light up on the browser app instead of showing a blank board. Outlines draw at the standard thickness for now. ([#4261](https://github.com/boardsesh/boardsesh/pull/4261))
- Admin access scoped to a single board no longer opens the site-wide admin tools; those pages now say plainly that they need full admin access instead of loading a page where nothing works. ([#4266](https://github.com/boardsesh/boardsesh/pull/4266))
- Open the app offline and your board downloads stay on the fast path — two launches without signal no longer drop a board to the slow catalog crawl. ([#4259](https://github.com/boardsesh/boardsesh/pull/4259))
- Add to playlist now only shows playlists for the board you're climbing on ([#4268](https://github.com/boardsesh/boardsesh/pull/4268))
- Purely a crash-reporting/observability fix — no user-visible behavior change. The subscription callback bodies (`next`/`error`/`complete`) are unchanged; only the transport wrapper they're routed through changed. ([#4258](https://github.com/boardsesh/boardsesh/pull/4258))
- MoonBoard problems keep their grade in the new-climbs feed and in setter notifications, even when the problem isn't pinned to one wall angle. ([#4243](https://github.com/boardsesh/boardsesh/pull/4243))
- Your logbook now draws each climb on the board you actually climbed it on, instead of the biggest board in the layout. ([#4249](https://github.com/boardsesh/boardsesh/pull/4249))
  Climbs on Kilter Orbit, Spire, JUUL, BKB, Decoy, Touchstone and Grasshopper walls finally show a thumbnail on the web.
- Record tab now shows a different badge color when a session is live vs. when a board is just connected, and a quick tap-back-to-session button shows up on your other tabs while you're mid-session. ([#4247](https://github.com/boardsesh/boardsesh/pull/4247))
- Board leaderboards now only count ticks actually logged on that board's setup — a tick whose layout, size, or hold sets don't match the board it names is kept in your logbook but left off that board's stats. ([#4263](https://github.com/boardsesh/boardsesh/pull/4263))
- Your playlist cards load their counts again instead of failing under load. ([#4262](https://github.com/boardsesh/boardsesh/pull/4262))
- Analytics correctness only — no user-visible behaviour change. ([#4254](https://github.com/boardsesh/boardsesh/pull/4254))

## 2026-08-10

### New

- Tuck the beta-video row away when you don't want it — tap the heading on the home feed, a climb, a session, or a profile and it folds. Fold it once and it stays folded everywhere until you open it back up. ([#4233](https://github.com/boardsesh/boardsesh/pull/4233))
- Added optional auto-disconnect setting: ([#4130](https://github.com/boardsesh/boardsesh/pull/4130))
  - Let other climbers take over your board automatically after a configurable idle period.
  - Keep the last climb lit while you browse, then reconnect when you’re ready.
- Claim an unclaimed gym and it's yours on the spot, no waiting for a review ([#4230](https://github.com/boardsesh/boardsesh/pull/4230))

### Fixed

- The lightbulb now spins while Boardsesh writes a climb to your wall, so you know your tap landed. ([#4156](https://github.com/boardsesh/boardsesh/pull/4156))
- Logging climbs offline no longer goes quiet for the rest of the session when the app starts up mid-cleanup. Offline storage now recovers on its own instead of staying switched off until you restart. ([#4121](https://github.com/boardsesh/boardsesh/pull/4121))
  Closes #4104
- Fixed the play drawer on Android opening to an empty purple screen — your climb, the board, and the ([#4210](https://github.com/boardsesh/boardsesh/pull/4210))
  controls are back.
- Custom hold colours now keep up with your finger on Android. ([#4157](https://github.com/boardsesh/boardsesh/pull/4157))
- Editing or deleting an ascent imported more than once now sticks instead of revealing hidden copies. ([#4115](https://github.com/boardsesh/boardsesh/pull/4115))
- Climb grades and ratings stay accurate when an upstream board sends empty, invalid, or detached stats. ([#4095](https://github.com/boardsesh/boardsesh/pull/4095))
- Fixed a bug where a failed avatar upload could wipe your profile picture for good — your old picture now stays put until the new one is safely saved. ([#4212](https://github.com/boardsesh/boardsesh/pull/4212))
  If your profile picture ever can't load, you'll see your initials instead of a blank gray circle.
- The tick sheet is laid out for your thumb now — tries and stars sit where your hand already is, and date and time share one line up top ([#4215](https://github.com/boardsesh/boardsesh/pull/4215))
  Fixed the Send button being cut off on smaller phones

## 2026-08-09

### Fixed

- Grade charts on a climb now read properly on a phone: angles no longer clip, low-graded climbs sit clear of the axis, and every French grade gets its own line ([#4222](https://github.com/boardsesh/boardsesh/pull/4222))
  Turning on both grade formats no longer smears the grades over each other

## 2026-08-08

### Fixed

- Changing a board's setup no longer gets blocked just because you own the same setup somewhere else — the app asks you to confirm instead. ([#4216](https://github.com/boardsesh/boardsesh/pull/4216))
  Climbs logged from the classic board pages now land on the right board when you own more than one with the same setup — and if you're in a session, on the wall that session is running on.
  The app now speaks German on the boards screens it was missing it on.

## 2026-08-07

### New

- Downloading a board for offline just got a lot lighter. The big boards drop from about 270 MB to about 100 MB, so your first download over a gym's wifi finishes noticeably sooner and eats far less data. ([#3819](https://github.com/boardsesh/boardsesh/pull/3819))

### Fixed

- See when an offline board is retrying its fast download or falling back to the slower sync. ([#4150](https://github.com/boardsesh/boardsesh/pull/4150))
- Private board links now keep working when you are signed in without exposing the board to signed-out visitors. ([#4087](https://github.com/boardsesh/boardsesh/pull/4087))
- Browser board connections now retry one brief GATT failure without making you choose the board again. ([#4155](https://github.com/boardsesh/boardsesh/pull/4155))
- Closes #4105 ([#4124](https://github.com/boardsesh/boardsesh/pull/4124))
- This only changes what reaches Sentry's `extra.cause` field for a developer-only telemetry event — no user-visible behavior, copy, or UI changes. The whole feature is also still gated behind `offline-board-downloads` at 0% rollout. ([#4118](https://github.com/boardsesh/boardsesh/pull/4118))
- Zoom into a climb in the player, then drag to move around the board — panning works again, not just in the editor. ([#4204](https://github.com/boardsesh/boardsesh/pull/4204))
- Adding a second board with the same setup at a different gym now works — you'll be asked whether it's a new wall or the one you already have ([#4174](https://github.com/boardsesh/boardsesh/pull/4174))
  New boards land under the right gym on the map, and you can pick that gym while adding them
  Board creation tells you when something goes wrong instead of quietly doing nothing

## 2026-08-05

### App update

A new version shipped to the App Store and Play Store.

### Fixed

- Fixed the Warm-up and Climb Bias pickers not responding to taps on Android ([#4203](https://github.com/boardsesh/boardsesh/pull/4203))

## 2026-08-04

### Fixed

- Fixed a crash that could take the app down when the now-playing bar appeared while a sheet was opening or closing ([#4198](https://github.com/boardsesh/boardsesh/pull/4198))
- Tailscale dev servers now hydrate correctly — no more blank white pages when connecting over the tailnet. ([#4192](https://github.com/boardsesh/boardsesh/pull/4192))
- Fixed a crash opening the Record tab in the browser app ([#4199](https://github.com/boardsesh/boardsesh/pull/4199))
- Bug reports get through now, whatever board you're on — a board with lots of hold sets used to make the report vanish ([#4195](https://github.com/boardsesh/boardsesh/pull/4195))
  The "couldn't send" message no longer claims we saved your report when we didn't
- Tap through None, Standard, and Extended warm-up again when building a workout on Android ([#4196](https://github.com/boardsesh/boardsesh/pull/4196))

## 2026-08-03

### App update

A new version shipped to the App Store and Play Store.

### New

- Boardsesh spricht jetzt Deutsch: the App Store and Play listings, the app, and the iOS permission ([#4178](https://github.com/boardsesh/boardsesh/pull/4178))
  prompts all read in German now.
- Boardsesh spricht Deutsch: the whole app is now translated into German. ([#4177](https://github.com/boardsesh/boardsesh/pull/4177))

### Fixed

- The Start button on the Record tab sits above the tab bar again on iOS 26. ([#4183](https://github.com/boardsesh/boardsesh/pull/4183))
  The climb filter sheet's Apply button sits at the bottom of the sheet again, without the dead gap below it.
  Toasts, snackbars, and the last rows of lists stay clear of the tab bar.
- Fixed the app logo briefly resizing itself while the app started up. ([#4185](https://github.com/boardsesh/boardsesh/pull/4185))
- Filter chips on the climbs list and logbook show their full names again instead of cutting off mid-word ([#4184](https://github.com/boardsesh/boardsesh/pull/4184))
- Zeitangaben wie „vor 6 Minuten" erscheinen jetzt in deiner Sprache — bisher waren sie auf Deutsch, Spanisch und Französisch immer englisch. ([#4182](https://github.com/boardsesh/boardsesh/pull/4182))
- Die deutsche App spricht jetzt sauberes Deutsch: das Board ist überall wirklich sächlich. ([#4180](https://github.com/boardsesh/boardsesh/pull/4180))

## 2026-08-02

### App update

A new version shipped to the App Store and Play Store.

### Improved

- This PR *is* the store release notes — it ships no app code, so there's nothing for the in-app "What's New" screen to show. ([#4168](https://github.com/boardsesh/boardsesh/pull/4168))

### Fixed

- Android Google sign-in now waits for the browser callback when the app resumes instead of failing early. ([#4151](https://github.com/boardsesh/boardsesh/pull/4151))
- Board hold overlays recover instead of erroring when the phone reclaims cache storage mid-render. ([#4114](https://github.com/boardsesh/boardsesh/pull/4114))
- See send counts update as soon as you log a climb, then stay in sync with the crew. ([#4146](https://github.com/boardsesh/boardsesh/pull/4146))
- Keep an iPhone board reconnect from being knocked out by a late Bluetooth failure from the previous attempt. ([#4173](https://github.com/boardsesh/boardsesh/pull/4173))
- Keep controls, lists, and messages tucked above the iOS tab bar without the extra gap. ([#4089](https://github.com/boardsesh/boardsesh/pull/4089))
- Board feeds now stay tied to real wall layouts and hold sets. ([#4149](https://github.com/boardsesh/boardsesh/pull/4149))
- Climb hold overlays now recover when storage pressure clears their cached image, instead of leaving a blank board or stale notification thumbnail. ([#4147](https://github.com/boardsesh/boardsesh/pull/4147))
- Reconnecting to the same board on iPhone no longer lets a late disconnect from the old connection knock the new link offline. ([#4152](https://github.com/boardsesh/boardsesh/pull/4152))
- Keep receiving over-the-air fixes after JavaScript-only dependency updates. ([#4148](https://github.com/boardsesh/boardsesh/pull/4148))
- Remixing or editing a climb now waits for the current board, queue, and player screens to finish closing before the editor opens, preventing stranded sheets and taps that appear to do nothing. ([#4091](https://github.com/boardsesh/boardsesh/pull/4091))
- Board climbs catch up sooner after temporary Aurora sync outages ([#4096](https://github.com/boardsesh/boardsesh/pull/4096))
- Keep empty board angles out of Kilter climb stats after catalog repairs. ([#4109](https://github.com/boardsesh/boardsesh/pull/4109))
- Playlist colours and shared-image emoji now stay consistent across your library, including playlists for 90° walls. ([#4132](https://github.com/boardsesh/boardsesh/pull/4132))
  Playlist collaborators can still read private climbs while owner-only changes stay protected.
- Report a duplicate gym once without sending repeat reports. ([#4138](https://github.com/boardsesh/boardsesh/pull/4138))
- Ticks and favorites waiting to sync now stay queued when a mobile connection drops after response headers, instead of being discarded. ([#4125](https://github.com/boardsesh/boardsesh/pull/4125))

## 2026-08-01

### App update

A new version shipped to the App Store and Play Store.

### Improved

- Dev-only instrumentation behind `__DEV__` — nothing reaches users, so there is ([#4082](https://github.com/boardsesh/boardsesh/pull/4082))
  nothing for the "What's New" screen to show.

### Fixed

- Keep climbing from your downloaded boards when you open Boardsesh without a connection. ([#4083](https://github.com/boardsesh/boardsesh/pull/4083))
- Your full Activity and Grade Distribution history stays reachable on narrow screens, even when every week or grade has data. ([#4090](https://github.com/boardsesh/boardsesh/pull/4090))
  Fixes #3778
  Fixes #3050
- Private gyms and boards now stay private to anyone without access — someone who turns up with just a link can no longer see a private gym's name, address or contact details, or pull a private board's name out of a kiosk screen. ([#4086](https://github.com/boardsesh/boardsesh/pull/4086))
- Board hold overlays recover cleanly after an interrupted render instead of staying blank or corrupted. ([#4081](https://github.com/boardsesh/boardsesh/pull/4081))

## 2026-07-31

### App update

A new version shipped to the App Store and Play Store.

### Improved

- Refs #2863 ([#4063](https://github.com/boardsesh/boardsesh/pull/4063))

### Fixed

- Remixing a climb is lighter on your phone: opening the player now lets the climbs behind it release their artwork instead of holding it all in memory, so a long browse-and-remix session is less likely to end with the app disappearing. ([#4078](https://github.com/boardsesh/boardsesh/pull/4078))
  A remix opened from a bad or shared link falls back to your own board instead of dying on a blank screen.
- Your Activity, Grade Distribution, and Flash vs Redpoint charts on the You ([#4074](https://github.com/boardsesh/boardsesh/pull/4074))
  page now stay inside their cards instead of spilling past the edge.
- Boardsesh no longer creates phantom stat rows for angles nobody's climbed on Kilter — the bogus grade-0 and impossible sub-one-star entries some climbs picked up from empty upstream data stop appearing. ([#4070](https://github.com/boardsesh/boardsesh/pull/4070))
  Closes #3522
- Board hold overlays can no longer get stuck showing a corrupted image after a rare mid-save crash — a broken render clears itself out instead of sticking around forever. ([#4073](https://github.com/boardsesh/boardsesh/pull/4073))
- Your V-Points progress line now connects the dots straight instead of curving — no more phantom dips or bumps between weeks making a session look better or worse than it was. ([#4066](https://github.com/boardsesh/boardsesh/pull/4066))
  Closes #3780
- Offline ticks logged while your connection is spotty no longer get stuck waiting behind one bad request — a real server error now clears out of the queue (or retries on its own terms) instead of stalling every other queued tick behind it. ([#4067](https://github.com/boardsesh/boardsesh/pull/4067))
  Closes #4027
- Queue rows and climb rows now respond to VoiceOver and TalkBack. Double-tap a row to play the climb or select it in edit mode, and reach "Log ascent" on a history row or "More actions" on a climb row straight from the row's actions — no more tapping into dead ends. ([#4022](https://github.com/boardsesh/boardsesh/pull/4022))
- Aurora sometimes filed the same ascent two to four times. Your logbook and your send totals now count it once — every real send is still there, nothing was deleted, and a repeat lap on the same climb still shows up as its own send. ([#4061](https://github.com/boardsesh/boardsesh/pull/4061))
  Fixes #3535
- Fixed a data glitch where some Kilter climbs could show an impossible fraction-of-a-star rating. ([#4047](https://github.com/boardsesh/boardsesh/pull/4047))
- MoonBoard playlists now queue up properly — set a climb active and the rest of the playlist lines up behind it ([#4010](https://github.com/boardsesh/boardsesh/pull/4010))
  Add MoonBoard climbs to playlists from the queue and play views, with checkmarks that actually show what's already in
  Removing a playlist's icon or description now sticks when you save
  Playlist climbs keep their grade even at angles nobody's logged yet
- Fixes #3869 ([#4028](https://github.com/boardsesh/boardsesh/pull/4028))
- Pick the app back up after months away and it now rebuilds your ticks, playlists and favourites from the server, instead of quietly hanging on to ones you deleted while you were gone. Your downloaded boards stay put — no surprise re-download — and anything you logged offline still goes up. ([#4048](https://github.com/boardsesh/boardsesh/pull/4048))
- Climbs you queue from the phone now show your name and avatar to everyone in the session instead of landing anonymous — and a phone in the session no longer wipes the "added by" avatars off the climbs your crew queued from the web. ([#4050](https://github.com/boardsesh/boardsesh/pull/4050))
  Fixes #3995
- Fixes #3382 ([#4053](https://github.com/boardsesh/boardsesh/pull/4053))
  Fixes #3383
  #3383 is a near-duplicate of #3382 filed from the same #3372 review — it is the issue the removed `TODO(#3383)` marker named, and the only one of the pair that mentions mobile. Both are closed by this change; if you'd rather keep #3382 as the canonical one, close #3383 as a duplicate instead.
- Fixes #3525 ([#4051](https://github.com/boardsesh/boardsesh/pull/4051))
- Tap the queue too fast and the app now tells you so. Adding, removing, clearing or replacing climbs used to fail silently when the server asked you to slow down — the queue just quietly snapped back. Now you get the same "give it a second" nudge you already get when switching the current climb, and your queue still lands on whatever the server actually has. ([#4019](https://github.com/boardsesh/boardsesh/pull/4019))
- Adding a climb to a playlist no longer errors out when the same climb gets added twice at once — a double-tap, or your phone syncing a queued add while another device adds the same climb, now quietly ends up with one entry instead of a failure. ([#4021](https://github.com/boardsesh/boardsesh/pull/4021))
- Angles with no community rating no longer show an empty row of stars in the angle picker — the rating only appears when there's an actual rating behind it. ([#4024](https://github.com/boardsesh/boardsesh/pull/4024))
  Fixes #3784
- The Logbook's filter button on iOS now shows a clean filter icon instead of a chopped-off "F…". ([#4026](https://github.com/boardsesh/boardsesh/pull/4026))
  Fixes #3782
- Narrow searches no longer cut off early. If a filter turned up 35 climbs but the list stopped at 21 and said "no more climbs", the missing ones were projects with no logged ascents — they're back in the list now, ranked after the climbs people have sent. ([#4043](https://github.com/boardsesh/boardsesh/pull/4043))
  Fixes #1971
- Fixes #3524 ([#4044](https://github.com/boardsesh/boardsesh/pull/4044))
- Kiosk displays now clear a board's queue preview the moment you flip that board to private or delete it, instead of leaving the last climb on screen. ([#4046](https://github.com/boardsesh/boardsesh/pull/4046))
  Fixes #3649
- The ascent counts above the Flash vs Redpoint bars on your Progress tab no longer get chopped off. When the bars are too narrow for a three-digit count, the number now stands on end so you can still read it. ([#4031](https://github.com/boardsesh/boardsesh/pull/4031))
  Fixes #3779
- When someone ends a session you're in, you now get a plain "session ended" note instead of a red sync error. ([#4032](https://github.com/boardsesh/boardsesh/pull/4032))
- Fixes #3538 ([#4033](https://github.com/boardsesh/boardsesh/pull/4033))
- Fixes #2863 ([#4039](https://github.com/boardsesh/boardsesh/pull/4039))
- Fixed a rare glitch where hold markers could go missing on a climb if your phone ([#4041](https://github.com/boardsesh/boardsesh/pull/4041))
  was low on storage — the app now rebuilds its overlay cache and redraws them.
  Fixes #3182
- Boardsesh now tells you why the board picker is empty on Android instead of blaming your board — if Android is hiding Bluetooth results until Location is allowed, you get a one-tap way to fix it. ([#3980](https://github.com/boardsesh/boardsesh/pull/3980))
- MoonBoard playlists work on the wall again: light up a climb from a playlist and swiping left/right now walks the rest of the circuit instead of stranding you on one climb. ([#3997](https://github.com/boardsesh/boardsesh/pull/3997))
  If adding a climb to a playlist fails, you'll now hear about it — even if you've already swiped the sheet away — and the message names the playlist.
- Fixes #3527 ([#4030](https://github.com/boardsesh/boardsesh/pull/4030))

## 2026-07-30

### App update

A new version shipped to the App Store and Play Store.

### Fixed

- Your board no longer shows as connected when the connection actually died on the first send — you get told to move closer and try again instead of tapping into a dark wall. ([#3998](https://github.com/boardsesh/boardsesh/pull/3998))
  If the first send after connecting doesn't land, the next climb you pick actually gets written to the wall, and your crew no longer sees it as lit when it isn't.
- Connecting to a board no longer needs Location permission on Android 12 and newer. ([#3981](https://github.com/boardsesh/boardsesh/pull/3981))
- Pick climbs back to back in a party session and none of them go missing. A quick double-pick now lands right ([#4005](https://github.com/boardsesh/boardsesh/pull/4005))
  after the current climb for the whole crew instead of at the bottom, and a climb you picked while the app was
  throttling still reaches them rather than vanishing.
- Switch boards with no signal — the picker now lists the boards you've downloaded instead of claiming you have none. ([#4004](https://github.com/boardsesh/boardsesh/pull/4004))
  My Boards works offline too, so you can see what's downloaded from inside the gym dead zone.
  No more "Could not follow" error when you pick a downloaded board offline.
- The filter sheet's Reset button now actually resets everything — including any ([#3999](https://github.com/boardsesh/boardsesh/pull/3999))
  climb name you'd typed in. And you can type or clear a climb name right there
  in the sheet, front and center, so you don't have to hunt for the search bar
  separately.
  Closes #3606.
- Starting a session on older iPhones and on iPad in Split View: the "Start" button no longer hides under the floating climb bar, so you can actually tap it instead of hitting the log-ascent tick by mistake. ([#3974](https://github.com/boardsesh/boardsesh/pull/3974))
- This is an internal hardening fix. Today's "All" climb-type filter behavior on web is unchanged; this closes a dormant footgun that could have silently regressed it in a future refactor. ([#3976](https://github.com/boardsesh/boardsesh/pull/3976))
- Animated climbs play back the way their setter drew them — routes and circuits were leaving holds lit long after the move was done, and one 19-frame Kilter problem lit 157 holds at its peak instead of 27. ([#3986](https://github.com/boardsesh/boardsesh/pull/3986))
  Climbs with a pause frame no longer skip the pause and cut the animation short; the frame counter now matches what's on the wall.
  Climb cards on the web and shared climb images show the whole route for a multi-frame climb instead of a half-finished snapshot. (The mobile app's own thumbnails still draw the opening frame only — its renderer never read past the first comma. Tracked in #3988.)
- Sign up with Apple or Google now stays in the sign-up flow when your device switches to browser sign-in. ([#3984](https://github.com/boardsesh/boardsesh/pull/3984))

## 2026-07-27

### App update

A new version shipped to the App Store and Play Store.

### New

- Open a preview build straight from its pull request — tap the link, confirm, and the app restarts on it. ([#3935](https://github.com/boardsesh/boardsesh/pull/3935))
- Android tablets get the full wall layout: browse climbs and light them in two panes side by side, with a live "on the wall" column — built for a tablet bolted to the gym wall. ([#3613](https://github.com/boardsesh/boardsesh/pull/3613))
  The tablet layout now follows Material 3 on Android, with a navigation rail down the side instead of the phone's bottom tabs.

### Fixed

- Deliberately none. A release note would have to promise climbers that re-importing fixes their mirrored sends, and that promise is only true if Aurora's export carries the field — which is exactly what hasn't been verified. The key-name logging will tell us; a note can ship in the follow-up once it does. ([#3953](https://github.com/boardsesh/boardsesh/pull/3953))
- Invisible to users: the phantom rows were never rendered on any surface. ([#3959](https://github.com/boardsesh/boardsesh/pull/3959))
- Sign in with Apple or Google from Boardsesh in your browser, with failed or cancelled attempts returning you to the app so you can try again. ([#3968](https://github.com/boardsesh/boardsesh/pull/3968))
- Open a climb you've already sent and the tick sheet no longer flashes up a green **Flash** button before your logbook loads — so a repeat can't get filed as a first-go send you never did. ([#3965](https://github.com/boardsesh/boardsesh/pull/3965))
  Logging an ascent on the web form no longer refuses a send that took one try. A redpoint that finally goes first go is a send, and now it saves like one.

## 2026-07-26

### New

- Spot boards that belong to your gym but slipped onto another listing or a merged one, and attach them to your gym in one tap. ([#3843](https://github.com/boardsesh/boardsesh/pull/3843))
- See what your crew's saying about your gym, and reply, right from the manage console. ([#3842](https://github.com/boardsesh/boardsesh/pull/3842))

### Fixed

- Followers stop getting the same "new climbs from &lt;setter&gt;" alert twice after a deploy. ([#3957](https://github.com/boardsesh/boardsesh/pull/3957))
  Your board stops showing a sync error for a sync that actually worked.
- Your logbook keeps syncing even when one old ascent is broken beyond repair — Boardsesh sets that one aside and carries on instead of quietly freezing every send, attempt and circuit behind it. ([#3960](https://github.com/boardsesh/boardsesh/pull/3960))
- Animated multi-frame climbs now show up instead of quietly going missing — around 40 on the two layouts we measured, and every new one from here on. ([#3951](https://github.com/boardsesh/boardsesh/pull/3951))
- Your playlists are yours. If someone else connects the same board account, their sync can no longer rename, empty, or delete the circuits you've synced — and if two accounts are already tangled together, neither can overwrite the other. ([#3931](https://github.com/boardsesh/boardsesh/pull/3931))
  When your circuits can't sync because another Boardsesh account is connected to the same board login, the board card says so in your language, instead of leaving you with an empty playlist list. It reads as a heads-up, not a broken account — your sends and ratings are still coming through.
- Backend correctness fix with no user-facing note yet. The race this closes is real and user-visible in party mode, but `setQueue` can still overwrite a concurrent add (#3933), so a "shared queues are reliable now" note would overclaim. The changelog entry belongs with #3933, once the guarantee actually holds end to end. ([#3932](https://github.com/boardsesh/boardsesh/pull/3932))
- Long-press a climb on Android and the action menu now floats above the wall properly instead of melting into the background ([#3941](https://github.com/boardsesh/boardsesh/pull/3941))
  Screen readers announce the tap-anywhere-to-close area as a close button, not as the climb
- The Edit button now shows up on your own climbs while they're sitting in the queue, not just in search ([#3958](https://github.com/boardsesh/boardsesh/pull/3958))
  Drafts keep their draft state through the queue, so you can jump straight back in and keep working
  Mirrored climbs stay mirrored when you preview them, and no-match tags stop vanishing after a queue sync
- Pick a climb while the wall is busy and it now reaches your crew's queue instead of only yours. Rattle off a fast burst of picks and the last one can still go missing — that half is tracked in #3936. ([#3934](https://github.com/boardsesh/boardsesh/pull/3934))
  Swipe onto the next playlist climb during a throttled session and the crew gets it too, not just you.
  Drop a climb right after picking it and it stays dropped — no phantom re-add landing on everyone's queue seconds later.
- iPad and iPhone: board art no longer piles up in memory without limit, so a long day on the wall won't end in a crash. ([#3944](https://github.com/boardsesh/boardsesh/pull/3944))
  Wall displays: the kiosk board now renders each climb at the size it's actually shown instead of full resolution.
- Log a redpoint that finally goes first try this session and it saves as **one try**, not two. ([#3939](https://github.com/boardsesh/boardsesh/pull/3939))
  The tries picker showed 1 while your logbook quietly stored 2 for any climb you'd been on before — so first-go sends were padding your session attempts and your try counts.
  The **+** button now moves the number that actually gets saved, and if you over-count a flash you can drop it back to 1 instead of being stuck on Send.
  Ticks logged before this fix still carry the extra try — you can correct any of them from the logbook edit sheet.
- [x] none (internal analytics hygiene, no user-facing change) ([#3930](https://github.com/boardsesh/boardsesh/pull/3930))
- Join your own session from a second phone and you can now just leave it — ending the session for everyone is a separate, deliberate step. ([#3956](https://github.com/boardsesh/boardsesh/pull/3956))
  Leave someone else's session without being offered a button that kills it for the whole crew.
  Your crew sees you drop out straight away instead of waiting a minute for the connection to time out.
- MoonBoard walls are readable in dark mode again — hold numbers, letters and the black holds all show up instead of disappearing into the background. ([#3961](https://github.com/boardsesh/boardsesh/pull/3961))
- The tick next to the grade on the now-playing bar sits level with the text instead of floating above it. Same for the checkmarks in playlists, filters, and settings. ([#3038](https://github.com/boardsesh/boardsesh/pull/3038))

## 2026-07-25

### Fixed

- Remix or edit a climb straight from the player without ending up with two stacked drawers — it closes the player and drops you into the create screen, pre-filled, with no leftover black panel over your search. ([#3337](https://github.com/boardsesh/boardsesh/pull/3337))
  A climb you just set now carries its board with it, so the rest of your crew sees it on the right wall.
- Switching boulders in a session no longer throws you back to the previous climb. If you and your crew are flicking through problems fast enough for the server to ask you to slow down, you now get a quiet "Too many changes too fast. Give it a sec." instead of the alarming "Queue was out of sync. Refreshed from your crew." — and your climb stays put. ([#2791](https://github.com/boardsesh/boardsesh/pull/2791))
- Start a generated session and your board stays lit on the climb you're working. The session queues up behind it, and anything you'd already lined up stays in the queue — nothing gets wiped. ([#3224](https://github.com/boardsesh/boardsesh/pull/3224))
- Tapping the ✓ on a past climb in the queue now just logs the ascent — it no longer also jumps you into that climb and closes the queue. ([#3915](https://github.com/boardsesh/boardsesh/pull/3915))
- Pick an angle mid-session and it sticks — reconnecting no longer snaps the wall back to the old angle while your change is still syncing to the crew. ([#3917](https://github.com/boardsesh/boardsesh/pull/3917))
- Fixed your gym's details getting overwritten by our board-location sync. Once you or a moderator edit, claim, or remove a gym or board, those changes stick, and the sync won't reshape or resurrect them on its next run. ([#3845](https://github.com/boardsesh/boardsesh/pull/3845))
- Your queue no longer vanishes if starting a session hiccups — a flaky connection while you tap Start keeps every climb you lined up, and your crew still sees it once you're back online. ([#3896](https://github.com/boardsesh/boardsesh/pull/3896))
- Logging ticks while a board download runs no longer errors out — offline saves go through even mid-sync. ([#3887](https://github.com/boardsesh/boardsesh/pull/3887))
  Browsing your downloaded boards stays smooth while a sync, board removal, or storage cleanup is happening in the background.
- In signed-in party sessions, who's leading and your own presence now heal correctly after a dropped update — no more stale leader badge or ghosted-self until someone reshuffles the crew. ([#3911](https://github.com/boardsesh/boardsesh/pull/3911))
- Your downloaded boards now open with no signal — even from a cold start, and even when the wifi's lying to you. Grab every climb for your board at home, then walk into a dead-zone gym (airplane mode, or that captive-portal wifi that connects but never loads) and go straight to your list. (For testers on the offline-downloads flag.) ([#3898](https://github.com/boardsesh/boardsesh/pull/3898))
- Logged a send at the wrong angle? Edit the send and set the angle — it now sticks, and your stats move with it. ([#3893](https://github.com/boardsesh/boardsesh/pull/3893))
  If you attached a beta video to that send, it now follows the angle fix too, so it opens at the angle you actually climbed.
- Scrolling the queue no longer snags when your thumb drifts right — only a deliberate left swipe reveals Delete. ([#3908](https://github.com/boardsesh/boardsesh/pull/3908))
- Reordering the queue works again — grab the handle and drag; long-press anywhere else on a climb still opens reactions. ([#3890](https://github.com/boardsesh/boardsesh/pull/3890))
- Party mode: when someone lands on a climb a crewmate just added, everyone's wall and queue now catch up to it on their own — no more staying stuck on the last boulder until you swipe again. ([#3894](https://github.com/boardsesh/boardsesh/pull/3894))
- Your crew list stays honest — who's in the session, who's leading, always current. If a network blip drops an update mid-session, your view now re-syncs itself instead of showing a stale or ghost climber until you rejoin. ([#3907](https://github.com/boardsesh/boardsesh/pull/3907))
- iPad: steadier marathon sessions — board art no longer piles up in memory as you hop between tabs, so a long day of browsing won't end in a crash. ([#3867](https://github.com/boardsesh/boardsesh/pull/3867))
- [x] none (internal analytics hygiene, no user-facing change) ([#3895](https://github.com/boardsesh/boardsesh/pull/3895))
- Swiping a queued climb left to remove it now works even when your thumb wanders a little — no more accidentally opening the climb instead. ([#3900](https://github.com/boardsesh/boardsesh/pull/3900))
- The climb list now refreshes right away after saving, editing, or publishing a climb, deleting a draft, or favoriting a climb ([#3901](https://github.com/boardsesh/boardsesh/pull/3901))
- Your 8am flash no longer shows up as an afternoon send — logbook times in the per-climb history now match your phone's clock. ([#3904](https://github.com/boardsesh/boardsesh/pull/3904))
- Your setter tab isn't shy anymore — your own climbs show on your profile now. ([#3903](https://github.com/boardsesh/boardsesh/pull/3903))

## 2026-07-24

### New

- See two listings of your gym? Report a duplicate right from the gym page and we'll get them merged. ([#3847](https://github.com/boardsesh/boardsesh/pull/3847))
- Staff you add to your gym now see it in My Gyms, and get a heads-up the moment they're handed the keys. ([#3844](https://github.com/boardsesh/boardsesh/pull/3844))
  Assigning roles is clearer: a quick note on what admins, editors, and members can each do.

### Improved

- Shared climbs unfurl instantly in chats — the preview is ready before your link lands ([#3834](https://github.com/boardsesh/boardsesh/pull/3834))

### Fixed

- Fixed a case where getting back on your climb after a mate queued one for a different wall left the board dark until you re-tapped the lightbulb ([#3456](https://github.com/boardsesh/boardsesh/pull/3456))
- Grasshopper board climbs are easier to see — hold markers, especially the ([#3745](https://github.com/boardsesh/boardsesh/pull/3745))
  blue ones, now render brighter and with a bolder outline against the board's
  darker photo. Tension, Decoy, Touchstone, So-iLL, and MoonBoard hold colors
  get the same brightness correction as a side effect; Kilter is unchanged.
- Party queues no longer vanish when one climb in the list has an old-style id — the rest of your queue keeps syncing instead of the whole thing getting stuck. ([#3879](https://github.com/boardsesh/boardsesh/pull/3879))
- Picking a climb no longer switches the wall off while the climb is still syncing — the holds light up as soon as it's ready, no more jumping to another climb and back. ([#3870](https://github.com/boardsesh/boardsesh/pull/3870))
- MoonBoard on iPhone: when the board drops mid-session, the bulb now goes dark right away — one tap reconnects you to the same board, no more digging through the device list. ([#3807](https://github.com/boardsesh/boardsesh/pull/3807))
- In a party session your phone now follows the crew's route playback live — play, pause, and speed changes from other phones show up instead of freezing. ([#3873](https://github.com/boardsesh/boardsesh/pull/3873))
- Logbook sync no longer gets stuck for good when one old attempt has a broken date — Boardsesh skips that one attempt and keeps syncing the rest of your sends. ([#3872](https://github.com/boardsesh/boardsesh/pull/3872))
  Fixes #3520
- Queue climbs your crew adds now fill in their name, grade, and thumbnail on your phone instead of getting stuck on "Unknown Climb" — even when the climb wasn't already cached on your device. ([#3763](https://github.com/boardsesh/boardsesh/pull/3763))
- Climb search no longer randomly comes up empty on busy filters. ([#3865](https://github.com/boardsesh/boardsesh/pull/3865))
- Fixed a rare crash when the app was sent to the background mid-sync. ([#3755](https://github.com/boardsesh/boardsesh/pull/3755))
- The recurring MoonBoard location sync isn't live in prod (see #3863), so this change is user-invisible today. ([#3864](https://github.com/boardsesh/boardsesh/pull/3864))
- Bug reports in the admin panel are now readable in dark mode ([#3826](https://github.com/boardsesh/boardsesh/pull/3826))
- Fixed a blank fine-tuning panel when building a session on iPhone — the workout builder's Tuning controls show up again ([#3855](https://github.com/boardsesh/boardsesh/pull/3855))
- The board now relights every climb as you swipe or tap through your queue on the web app — not just the first one. ([#3853](https://github.com/boardsesh/boardsesh/pull/3853))

## 2026-07-22

### New

- One gym, one page — we're merging duplicate gym listings, and your follows, boards, and kiosks ride along to the surviving page. If a merge shifts a kiosk's address, we flag it so the gym can reprint that wall's install QR. ([#3699](https://github.com/boardsesh/boardsesh/pull/3699))
- The play screen now opens onto your own history with this climb — a quick line of sends and attempts, right where you can see it before you scroll. ([#3840](https://github.com/boardsesh/boardsesh/pull/3840))
  Working a project? It reads "12 attempts, no send yet" so you know exactly how many times you've thrown yourself at it. Tap it and the full logbook glides into view.

## 2026-07-21

### New

- Shared climb cards are easier to read in chat previews — hold rings are thicker at small sizes ([#3832](https://github.com/boardsesh/boardsesh/pull/3832))
- Shared climb links now show their preview card instantly on Facebook, WhatsApp, Slack and friends ([#3830](https://github.com/boardsesh/boardsesh/pull/3830))
- The long-press menu leads with Log a tick, Add to playlist, and Share as buttons — your go-to actions in one tap. ([#3828](https://github.com/boardsesh/boardsesh/pull/3828))
  The climb title now sits above the board, and every action fits on one screen — no scrolling.
  Long-press board art is crisp now, matching the play view.
  The ⋮ quick-actions button shows on every climb by default; hide it in More → Display if you'd rather long-press.
- Still on the old Boardsesh app? It now points you straight at the rebuilt one — your logbook, sessions, and crew come with you. ([#3822](https://github.com/boardsesh/boardsesh/pull/3822))
- Long-press a climb and the preview fills the screen up top — big enough to read the beta at a glance. ([#3827](https://github.com/boardsesh/boardsesh/pull/3827))
  New ⋯ button on every climb, plus a first-run tip, so quick actions (queue, tick, playlists, share) are easy to find — no more guessing you have to long-press.
  Tap "Add to playlist" and the preview glides down to make room, then back up when you're done.
  The action list now shows it scrolls when there's more below.

### Improved

- Shared climb links unfurl fast and reliably — old-format links now land on the climb, not the board list ([#3833](https://github.com/boardsesh/boardsesh/pull/3833))

## 2026-07-20

### New

- Your gym console now opens on an Overview — every setup step, your public page, and a paste-anywhere embed are one tap away. ([#3722](https://github.com/boardsesh/boardsesh/pull/3722))
  Edit your gym's profile (name, address, website, visibility) right in the console instead of hunting for the sheet.
  On your public gym page, quick prompts point you straight to whatever's still missing — boards, a TV wall, or your branding.
- Light up your board straight from the browser — the Bluetooth control now works on app.boardsesh.com in Chrome and other Web Bluetooth browsers. ([#3812](https://github.com/boardsesh/boardsesh/pull/3812))
- Make the filter row yours — pin the shortcuts you actually reach for and drop the ones you don't. ([#3802](https://github.com/boardsesh/boardsesh/pull/3802))
  Now pinnable too: Sort, Grade accuracy, Climb type, and Beta videos.
  Collection is one clean picker — Any, Benchmarks, or My drafts — and Tall/Wide live together under a single Shape shortcut.

### Improved

- The app shows the Boardsesh splash right away on the web instead of a blank white screen while it signs you in. ([#3813](https://github.com/boardsesh/boardsesh/pull/3813))
- Signed-in pages load a little quicker — the app no longer re-checks your profile from the database on every request. ([#3815](https://github.com/boardsesh/boardsesh/pull/3815))
- The home feed loads faster on a cold start — fewer requests before your crew's sends show up. ([#3810](https://github.com/boardsesh/boardsesh/pull/3810))

### Fixed

- Buttons at the bottom of the board sheet and other panels no longer hide behind Android's on-screen navigation bar. ([#3771](https://github.com/boardsesh/boardsesh/pull/3771))
- Android: faster, more reliable Bluetooth — your board turns up quicker when you go to connect ([#3811](https://github.com/boardsesh/boardsesh/pull/3811))
- Android: your board shows up in the Bluetooth list again when you reconnect — no more empty picker ([#3806](https://github.com/boardsesh/boardsesh/pull/3806))
- `none` — internal CI/tooling fix, nothing user-facing. ([#3790](https://github.com/boardsesh/boardsesh/pull/3790))

## 2026-07-19

### New

- Boardsesh now runs in your browser: the same app you use on your phone — queue, play view, board LEDs over Web Bluetooth, offline thumbnails — at boardsesh.com/app, rolling out gradually. If anything feels off, add `?classic=1` to any link to hop back to the classic site. ([#3775](https://github.com/boardsesh/boardsesh/pull/3775))

## 2026-07-18

### New

- Reorganized the climbs filter panel into clear sections you can scan at a glance — no more digging through "Refine" and "Advanced" ([#3769](https://github.com/boardsesh/boardsesh/pull/3769))
  Filter for your projects, sends, or untried climbs right at the top under Progress

## 2026-07-17

### App update

A new version shipped to the Play Store.

### New

- Admin-only internal tooling — not climber-facing. ([#3724](https://github.com/boardsesh/boardsesh/pull/3724))
- Stuck on the error screen? A new "Check for a fix" button grabs the latest update and reloads the app on the spot ([#3759](https://github.com/boardsesh/boardsesh/pull/3759))
- Signing in is smoother: your password manager can finally autofill Boardsesh, and login errors show up right in the form instead of a vanishing popup. ([#3734](https://github.com/boardsesh/boardsesh/pull/3734))
- Forms got a full redesign: clear labels that never clip, sensible widths on tablets, grouped sections, and character counters where they help. ([#3703](https://github.com/boardsesh/boardsesh/pull/3703))
  Logging an ascent now tells you when something goes wrong instead of failing silently.

### Improved

- Filter for your projects — show only the climbs you've tried but haven't sent yet ([#3753](https://github.com/boardsesh/boardsesh/pull/3753))
  Cleaner filters: pick where you're at on a climb (not tried, projects, sent) in one tap, with benchmarks on their own
- The Home feed scrolls smoother — flinging through your crew's sessions drops fewer frames, especially on Android. ([#3727](https://github.com/boardsesh/boardsesh/pull/3727))
- The home screen's community beta clips and boards show up faster on phones and patchy signal — the first thumbnail loads right away instead of waiting on the rest of the page to wake up. ([#3730](https://github.com/boardsesh/boardsesh/pull/3730))

### Fixed

- Your MoonBoard 2024 logbook imports now stay attached to the listed climb, even when older duplicate rows exist. ([#3751](https://github.com/boardsesh/boardsesh/pull/3751))
- Your MoonBoard 2024 logbook now imports — sends on the 2024 board match up instead of getting dropped as unknown problems. ([#3749](https://github.com/boardsesh/boardsesh/pull/3749))
- If you use light mode, the app no longer flashes dark while it loads. ([#3735](https://github.com/boardsesh/boardsesh/pull/3735))
  New here? The app now matches your device's light/dark setting from the first screen.
- Internal telemetry hygiene. The one behavior change with user impact (a queued offline tick surviving a mid-drain timeout instead of being dead-lettered) sits behind the `offline-board-downloads` flag at 0% rollout, so nothing visible ships. ([#3733](https://github.com/boardsesh/boardsesh/pull/3733))
- Beta videos and similar climbs now swipe sideways in the climb drawer on Android — flick through the whole strip, not just the first couple. ([#3746](https://github.com/boardsesh/boardsesh/pull/3746))
- Queue climbs your crew adds now fill in their name, grade, and thumbnail on your phone instead of getting stuck on "Unknown Climb" — even when the climb wasn't already cached on your device. ([#3742](https://github.com/boardsesh/boardsesh/pull/3742))
- Change your board angle mid-session and the queue keeps up: the climb you're on and everything coming up show grades, stars, and sends for the angle the wall is actually set to. ([#3741](https://github.com/boardsesh/boardsesh/pull/3741))
  Climbs you've already sent stay pinned to the angle you climbed them at, with a "Sent at N°" tag when that differs from the wall's current angle.
- Removing a vote or like on a session now works every time — it used to get silently rejected. ([#3744](https://github.com/boardsesh/boardsesh/pull/3744))
- Fixed a crash on Android when opening the gym/board map — a build missing the Google Maps configuration now shows the gym list instead of closing the app. ([#3726](https://github.com/boardsesh/boardsesh/pull/3726))
- Send a climb and the board takes an extra second to light up? The bulb keeps waiting instead of flashing a false miss — a slow-but-good confirm now shows as lit. ([#3731](https://github.com/boardsesh/boardsesh/pull/3731))
- Defensive correctness guard for a path users can't currently reach (see decision note above). No user-visible behavior change to describe today. If we later make create track the live session angle, that becomes user-facing and warrants a real note. ([#3738](https://github.com/boardsesh/boardsesh/pull/3738))
- The climb list holds still while it loads — no more rows jumping around as thumbnails and grades settle in. ([#3728](https://github.com/boardsesh/boardsesh/pull/3728))
- "Classics Only" now actually filters your search to curator-flagged benchmark climbs, instead of doing nothing. ([#3736](https://github.com/boardsesh/boardsesh/pull/3736))
- Tapping "Turn off all lights" now tells you when the board dropped mid-clear instead of going quiet. ([#3737](https://github.com/boardsesh/boardsesh/pull/3737))
- Backend log-diagnostic correctness only; no user-facing behavior change. ([#3739](https://github.com/boardsesh/boardsesh/pull/3739))
- Gym pages no longer hide their last few rows behind the queue or tab bar — the comments, links, and manage settings all clear the bottom. ([#3721](https://github.com/boardsesh/boardsesh/pull/3721))
- The homepage gym card no longer flickers between states while it figures out whose gym is whose. ([#3714](https://github.com/boardsesh/boardsesh/pull/3714))

## 2026-07-16

### New

- Adding your gym? We'll show you if it's already on Boardsesh so you can claim it instead of starting from scratch. ([#3701](https://github.com/boardsesh/boardsesh/pull/3701))
  The gym form now has a map — drop a pin or search an address so your crew can find the wall.
- Your kiosk TVs now check in — see at a glance which screens are live and which need a nudge, straight from the Kiosks tab. ([#3685](https://github.com/boardsesh/boardsesh/pull/3685))
- Free up space from Manage storage: see what each downloaded board takes up and clear the ones you're not climbing on. ([#3630](https://github.com/boardsesh/boardsesh/pull/3630))
- Refreshed Boardsesh's look on the web to match the app — new icon everywhere: browser tab, home screen install, and the header. ([#3711](https://github.com/boardsesh/boardsesh/pull/3711))
  Claude-Session: https://claude.ai/code/session_018jnud1ULod9FZ2BfTgFiih
- Dark mode forms finally look like they belong: input fields sit on the same violet surfaces as the rest of the app, with a clear violet focus ring — no more glaring white boxes. ([#3700](https://github.com/boardsesh/boardsesh/pull/3700))
  Autofill no longer flashes your login fields white in dark mode, and iPads stop zooming when you tap a field.
- Own a gym? Your gym now greets you on the homepage — jump straight to managing its boards or your public page. ([#3697](https://github.com/boardsesh/boardsesh/pull/3697))
  Climb somewhere with boards? Find your gym from the homepage and pull up its boards and crew.
- After a duplicate-gym cleanup, old gym links and printed kiosk QR codes now land on the right gym instead of a dead page. ([#3669](https://github.com/boardsesh/boardsesh/pull/3669))
- Gym owners get an Insights tab — see how many climbers hit your boards this week, the climbs everyone's projecting, and your busiest nights, all with a week-over-week read on whether the wall's picking up. ([#3681](https://github.com/boardsesh/boardsesh/pull/3681))
- Boardsesh on the web gets a fresh look — the same violet **Velvet Send** style as the app, in light and dark. ([#3678](https://github.com/boardsesh/boardsesh/pull/3678))
  Keyboard climbers get visible focus rings everywhere.
  Your profile card's grade spread shows as a colourful donut instead of a flat bar.
- Your gyms are one tap away — open the menu and hit **My gyms** to jump straight into managing kiosks, boards, and your crew. ([#3675](https://github.com/boardsesh/boardsesh/pull/3675))
- Gym pages are real pages now — tap a gym's name anywhere to see its walls, follow it, claim it, and join the conversation. ([#3670](https://github.com/boardsesh/boardsesh/pull/3670))
- Your gyms are one tap away — open the menu and hit **My gyms** to jump straight into managing kiosks, boards, and your crew. ([#3668](https://github.com/boardsesh/boardsesh/pull/3668))
- Your gyms now live in the More tab — jump straight to a gym, tweak its details, and fire up the TV kiosk from the web console. ([#3674](https://github.com/boardsesh/boardsesh/pull/3674))
- Report a bug from the app and we'll turn it into a tracked issue, not a lost chat message. ([#3307](https://github.com/boardsesh/boardsesh/pull/3307))
  Tick "Can we contact you?" and we'll email you the link so you can follow the fix.
- Leave a recap when you end your session — how it went, what you almost sent. It shows on your session page. ([#3654](https://github.com/boardsesh/boardsesh/pull/3654))
  Skipped the recap? Add or edit it from the session summary afterwards.
- Your gym's wall screen can now show a scannable code on every board — climbers scan it to get Boardsesh, and their sends light up the screen. ([#3656](https://github.com/boardsesh/boardsesh/pull/3656))
- Gym owners: make the TV yours — upload your logo and set your colours, with a live preview of exactly what the kiosk will show. ([#3637](https://github.com/boardsesh/boardsesh/pull/3637))
  Build your TV layout in the new kiosk editor: pick up to four walls, reorder them, and toggle the leaderboard with a session, 24-hour, week, or month ranking.
  Watch your edits live — the editor preview is the real kiosk, showing what's lit on your walls as it happens.
  Grab a copy-paste embed code for any public board or your gym leaderboard and drop the live view straight into your own website.
- Every gym now has a public page — logo, boards, and a one-tap link to the live wall. ([#3635](https://github.com/boardsesh/boardsesh/pull/3635))
  Gym owners get a manage hub to link boards and manage their crew (kiosk and branding setup arrive with the editor update).
- Gyms can now embed a live board view and a gym leaderboard straight into their own website — paste one iframe snippet and visitors see what's lit on the wall and who's been sending, powered by Boardsesh. ([#3636](https://github.com/boardsesh/boardsesh/pull/3636))
- Put your gym's walls on a TV: `/kiosk/your-gym` shows what's lit on every board, live, with your gym's logo and colours ([#3634](https://github.com/boardsesh/boardsesh/pull/3634))
  Run up to four boards on one screen — the layout adapts as you add walls
  Add a leaderboard rail to see who's crushing this session, the last 24 hours, this week, or this month
  The TV takes care of itself: stays awake, reconnects, and picks up your kiosk edits on its own

### Improved

- Smoother scrolling through your logbook and a snappier You tab ([#3718](https://github.com/boardsesh/boardsesh/pull/3718))
- **Android: instant tab switching.** Hopping between Home, Climbs, and You no longer rebuilds the screen every time — the app keeps each tab ready, so switching is immediate instead of stuttering on the charts-heavy You tab. ([#3688](https://github.com/boardsesh/boardsesh/pull/3688))
- MoonBoard heatmaps, hold search, and area filters now work from the board's real hold placements. ([#3658](https://github.com/boardsesh/boardsesh/pull/3658))

### Fixed

- Fixed a rare Android crash that could close the app during a climbing session while the ongoing session notification updated. ([#3723](https://github.com/boardsesh/boardsesh/pull/3723))
- Hold heatmaps keep loading even when the busiest boards are getting hammered — no more failed heatmap loads under heavy search traffic. ([#3694](https://github.com/boardsesh/boardsesh/pull/3694))
- Fixed: your Settings display name now shows everywhere right away — no more getting stuck with your auto-generated handle in the menu after you change it. ([#3719](https://github.com/boardsesh/boardsesh/pull/3719))
- Bug reports now default to letting us follow up with you — flip the switch off if you'd rather we didn't. ([#3712](https://github.com/boardsesh/boardsesh/pull/3712))
- Party sessions ride out a mid-action reconnect cleanly: queueing or switching a climb right as your connection blips no longer throws an error. ([#3693](https://github.com/boardsesh/boardsesh/pull/3693))
  A crew member who drops and rejoins won't flicker out of the roster, and the session won't be left without a leader.
- Google sign-in on Android now recovers through the browser instead of dead-ending when the native sign-in hits a configuration error. ([#3709](https://github.com/boardsesh/boardsesh/pull/3709))
  Fixes #3100
- Fixed a rare crash on the climb list when a browser translate extension (like Chrome's auto-translate) was switched on. ([#3707](https://github.com/boardsesh/boardsesh/pull/3707))
- Fixed a bug where the setter filter on the climb list could crash the page if search results failed to load. ([#3706](https://github.com/boardsesh/boardsesh/pull/3706))
- No more spurious "Queue sync error" when a party session you were in has ended or moved on — the app quietly drops the stale session instead. ([#3710](https://github.com/boardsesh/boardsesh/pull/3710))
- Importing your Tension Board history now keeps attempts as attempts. Projects you tried but didn't send no longer show up as sends, so your send count and stats stay honest. ([#3692](https://github.com/boardsesh/boardsesh/pull/3692))
  Already imported before this fix? Just re-import your history — the mislabeled sends get corrected in place.
- Party mode: when someone else lights up a climb, it now slots in right after the current climb instead of getting bumped to the bottom of the queue — everyone's up-next order stays put. ([#3691](https://github.com/boardsesh/boardsesh/pull/3691))
- Embed widgets now show proper titles and descriptions again — the live board and gym-leaderboard embeds were briefly rendering placeholder text instead of real metadata. ([#3704](https://github.com/boardsesh/boardsesh/pull/3704))
- Fixed a rare bug where logging a tick right as a party session wrapped up could silently fail to save — your tick is saved every time now, even if the session link can't be kept. ([#3686](https://github.com/boardsesh/boardsesh/pull/3686))
- Reconnecting to your board mid-session is quieter now — tap the lightbulb and it slips back onto the same box instead of throwing the board picker at you every few climbs, and it remembers your board across app restarts. ([#3687](https://github.com/boardsesh/boardsesh/pull/3687))
- Party queues now ride out rate limits. If the app buffers a burst of queue changes while you're offline and replays them the moment you reconnect, they land smoothly with a brief "catching up" note instead of a raw "Rate limit exceeded" error — and a change that's still being throttled is kept and retried instead of lost. ([#3690](https://github.com/boardsesh/boardsesh/pull/3690))
- Changing your display name or avatar saves reliably again. ([#3679](https://github.com/boardsesh/boardsesh/pull/3679))
  And if a save ever does hiccup, you'll get a plain "couldn't save, try again" instead of a wall of database text.
- Sign in with Apple and Google now go through reliably on the latest iOS — no more bouncing straight back to the login screen. ([#3684](https://github.com/boardsesh/boardsesh/pull/3684))
- Party sessions pick back up cleanly when you come back to the app — locking your phone mid-session no longer throws a phantom sync error. ([#3680](https://github.com/boardsesh/boardsesh/pull/3680))
- When a board won't connect on Android, you now get the real reason — Bluetooth off, board not found, or a connection that dropped — instead of a blanket "unknown error". ([#3653](https://github.com/boardsesh/boardsesh/pull/3653))

## 2026-07-15

### New

- See how big a board is before you download it — no more surprise 270 MB on cellular ([#3625](https://github.com/boardsesh/boardsesh/pull/3625))
- Find a new wall and it drops straight into your boards, ready to pull down for offline. ([#3622](https://github.com/boardsesh/boardsesh/pull/3622))
  Turn on "Keep boards offline" in Settings to download every board you use so browsing and logging sends works with no signal.
  Manage your boards the easy way: tap Edit to unfollow or delete, or swipe — the swipe actually catches now.

### Fixed

- Fixes a bug where the app could sign you out or get stuck loading after being backgrounded on a locked iPhone. ([#3612](https://github.com/boardsesh/boardsesh/pull/3612))
- Reorder climbs in a playlist and the new order sticks. ([#3652](https://github.com/boardsesh/boardsesh/pull/3652))
- Downloading a board for offline use now completes in seconds instead of minutes — the app grabs a pre-built copy of the catalog instead of crawling it climb by climb. (This fixes the fast path so it actually kicks in.) ([#3618](https://github.com/boardsesh/boardsesh/pull/3618))

## 2026-07-14

### New

- Shuffle the list — a new **Random** sort mixes up your climbs so you're not stuck scrolling the same popular sends every session. Tap it again for a fresh shuffle. ([#3601](https://github.com/boardsesh/boardsesh/pull/3601))

### Fixed

- Log a tick from a climb's long-press menu on the player screen without the tick sheet snapping shut before you can save it. ([#3600](https://github.com/boardsesh/boardsesh/pull/3600))

## 2026-07-11

### Fixed

- Fixed the log-ascent sheet popping back open uninvited after connecting to a board ([#3595](https://github.com/boardsesh/boardsesh/pull/3595))

## 2026-07-09

### App update

A new version shipped to the App Store and Play Store.

### New

- See how hard a climb looks from its holds — every Boardsesh grade now shows a second estimate computed purely from a climb's hold layout, right next to the community grade, so you can compare the two. ([#3592](https://github.com/boardsesh/boardsesh/pull/3592))
- Sharper grades on climbs almost no one has logged yet — the new hold-shape model estimates a grade (with a range) from a climb's holds, so brand-new and rarely-climbed problems show a real number instead of just the setter's guess. ([#3589](https://github.com/boardsesh/boardsesh/pull/3589))
- Hitting a Bluetooth wall? Bug reports now have an "I'm having Bluetooth trouble" toggle — flip it and we'll spot the boards around you so we can work out why yours won't connect. ([#3581](https://github.com/boardsesh/boardsesh/pull/3581))
- Turn on "Show Boardsesh grades" in Settings to see every climb on one cross-board grade, built from real sends across every board. ([#3565](https://github.com/boardsesh/boardsesh/pull/3565))
  The Boardsesh grade section in the play drawer now shows the grade at a glance when collapsed, how confident it is, and how it shifts by wall angle.
  Logged a send without grading it? We'll show the Boardsesh grade — your own grade always stays put when you set one.

### Improved

- Import your MoonBoard CSV logbook into Boardsesh from connected apps, with sends, flashes, attempts, projects, and fails matched at 40 degrees. ([#3571](https://github.com/boardsesh/boardsesh/pull/3571))

### Fixed

- _(User-facing benefit ships via #3577's note in the same 2.2.2 build; this is a robustness hardening of that fix.)_ ([#3579](https://github.com/boardsesh/boardsesh/pull/3579))
- Kilter boards that show up as just "Kilter Board" now light up on the first tap instead of taking a couple of tries. ([#3586](https://github.com/boardsesh/boardsesh/pull/3586))
- Kilter and Tension boards with newer write-only BLE boxes light reliably after the first rescue, without slowing down healthy boards. ([#3580](https://github.com/boardsesh/boardsesh/pull/3580))
- Using an early-2025 Kilter LED box on iPhone? It would connect but the holds stayed dark no matter which climb you picked. Now it lights up like it should — pick a climb and the wall comes on. ([#3577](https://github.com/boardsesh/boardsesh/pull/3577))

## 2026-07-08

### App update

A new version shipped to the App Store and Play Store.

### New

- Your star ratings finally move the needle — rate a climb in Boardsesh and the stars everyone sees shift with it ([#3556](https://github.com/boardsesh/boardsesh/pull/3556))
  Climbs nobody rated before show stars as soon as someone in your crew rates them
  Ticks synced from Kilter now show the stars you gave the climb over there

### Fixed

- Kilter logbook sync no longer stalls for climbers who cleared a star rating ([#3570](https://github.com/boardsesh/boardsesh/pull/3570))
- Kilter star ratings are honest again — climbs that suddenly all looked like 5‑star classics go back to their real ratings ([#3567](https://github.com/boardsesh/boardsesh/pull/3567))
- Your Kilter logbook syncs again — connections that quietly stopped updating now recover on their own, and when something breaks it's recorded instead of pretending everything's fine ([#3557](https://github.com/boardsesh/boardsesh/pull/3557))
  Linking a board account that's already connected to another Boardsesh member now warns you clearly instead of silently sending your ticks to their logbook
  Old Kilter connections from before the new sign-in now say "reconnect to sync" instead of a confusing network error
- Your logbook stops double-counting: if you linked a Kilter or Aurora account, the same send used to show up twice — sometimes hours off. Every send now lands on one tick at the real moment you climbed it ([#3555](https://github.com/boardsesh/boardsesh/pull/3555))
  Sends you delete in the Kilter app disappear here too, and they stop being re-pushed
  Edits you make in Boardsesh survive the next sync instead of being stomped
- Thousands of climbs that had quietly vanished from search are back — including 837 live Kilter climbs and 9,230 climbs hidden from set-filtered searches ([#3553](https://github.com/boardsesh/boardsesh/pull/3553))
  When a board maker pulls or unpublishes a climb, it now disappears from Boardsesh too
  Duplicate MoonBoard problems and stray import copies are merged into one entry, so ticks and stars land on the real climb
- Fixed some iPhones on iOS 26.5 that connected to a board but never lit up climbs. ([#3563](https://github.com/boardsesh/boardsesh/pull/3563))

## 2026-07-07

### App update

A new version shipped to the App Store and Play Store.

### New

- See how hard a climb really is: a new Boardsesh grade in the play drawer, built from every logged send — with a confidence level, and comparable across Kilter and Tension ([#3517](https://github.com/boardsesh/boardsesh/pull/3517))
  Sandbagged at 25°? The Boardsesh grade accounts for the angle you're actually climbing at
  MoonBoard crew: log your Moon sends on Boardsesh to help unlock standardized Moon grades
- Boardsesh frees up memory as soon as you switch away from the app on Android ([#3510](https://github.com/boardsesh/boardsesh/pull/3510))
- Filter for **tall and wide climbs on more boards** — Kilter Original, Tension Board 2, Decoy and Grasshopper now show the Tall/Wide chips, not just the Kilter Homewall. And they work **with no signal**: once you've downloaded a board, tall/wide filtering runs on-device. Flip on a filter that still needs a connection (drafts, beta, zones, holds) while offline and the screen now tells you why, with a tap to clear it, instead of just coming up empty. ([#3498](https://github.com/boardsesh/boardsesh/pull/3498))
- Early testers: download a board in My Boards and keep browsing, logging sends, and saving favorites with no signal — everything queues on your phone and syncs when you're back online. (Rolling out gradually behind a feature flag.) ([#2785](https://github.com/boardsesh/boardsesh/pull/2785))

### Improved

- The play drawer shows your climb the moment it opens, instead of a grey box catching up ([#3509](https://github.com/boardsesh/boardsesh/pull/3509))
  Scrolling, searching, and queueing climbs is smoother, especially on Android

### Fixed

- Ascent counts are honest again: if you synced your Kilter or Tension logbook, your sends were being counted on top of the numbers already in the board's own history — climbs looked more repeated than they are ([#3549](https://github.com/boardsesh/boardsesh/pull/3549))
  Sends you log in Boardsesh still bump the tally instantly
  First-ascent credits on Kilter, Tension, and MoonBoard problems now come from the board itself, not whoever logged them first in Boardsesh
- Star ratings finally read true on every board — Kilter classics that were stuck at 3 stars now show their real 5 ([#3547](https://github.com/boardsesh/boardsesh/pull/3547))
  Low-rated climbs stop getting a free bump: Tension-family averages are back on the same scale as your own tick ratings
  "Unrated" climbs no longer sort as zero stars or drag averages down
- The Boardsesh grade now stays consistent across angles — the same climb can't be graded easier at a steeper angle (fixes inversions like The Enchiridion reading harder at 30° than 35°) ([#3548](https://github.com/boardsesh/boardsesh/pull/3548))
- Fixed over-the-air updates not reaching phones still on the current App Store build ([#3546](https://github.com/boardsesh/boardsesh/pull/3546))
- Adding a beta video from the player's "..." menu works again — the share sheet opens over the player instead of vanishing. ([#3514](https://github.com/boardsesh/boardsesh/pull/3514))
- Your real name and avatar now show up when you start or join a session with your crew — no more `user-3f8a12`. ([#3516](https://github.com/boardsesh/boardsesh/pull/3516))
- Scrolling the climb history list during a session is fixed on Android. ([#3515](https://github.com/boardsesh/boardsesh/pull/3515))
- Downloaded boards now work fully offline: changing the queue angle keeps grades accurate, "plan my session" builds from your downloaded climbs, and wall-panel climbs load without a connection ([#3499](https://github.com/boardsesh/boardsesh/pull/3499))
- Fixed the play drawer sometimes showing the board without the lit holds on Android ([#3512](https://github.com/boardsesh/boardsesh/pull/3512))
- Filter chips on Android now respond after you scroll the climb list, instead of opening the climb hiding underneath ([#3508](https://github.com/boardsesh/boardsesh/pull/3508))

## 2026-07-06

### App update

A new version shipped to the App Store.

### New

- The board angle now sits with your other filters at the top of the climb list instead of taking up its own line — one less row between you and the climbs. ([#3493](https://github.com/boardsesh/boardsesh/pull/3493))
- Own a gym? Claim your listing and keep it accurate — verify with a work email or ask us to review. ([#3409](https://github.com/boardsesh/boardsesh/pull/3409))
  Gym owners and community leaders can now hand a crew member write access to keep a gym's details up to date.

### Fixed

- Empty playlists screen now has a clear "Create playlist" button instead of pointing at a hard-to-spot + ([#3451](https://github.com/boardsesh/boardsesh/pull/3451))
- Fixed a rare crash that could close the app while it was loading climbs. ([#3488](https://github.com/boardsesh/boardsesh/pull/3488))
- Fixed a crash where the app could be killed for using too much memory while browsing boards — most noticeable on older iPhones. ([#3482](https://github.com/boardsesh/boardsesh/pull/3482))

## 2026-07-05

### New

- Pair your gym's workout timer to your board — while you're lit up on the wall, every send starts the clock. ([#3473](https://github.com/boardsesh/boardsesh/pull/3473))
- The home screen now points you straight to the app in the App Store or Google Play. ([#3469](https://github.com/boardsesh/boardsesh/pull/3469))
- On iPad, the On the Wall view now keeps the screen from dimming so the board stays visible for your whole session. ([#3465](https://github.com/boardsesh/boardsesh/pull/3465))

### Fixed

- MoonBoard sends now add to a climb's community repeat count instead of wiping it — so popular benchmarks like Birthday Cake Trail Mix show their real numbers and sort back to the top of the list. ([#3461](https://github.com/boardsesh/boardsesh/pull/3461))
- Adding a climb to a playlist works again — press and hold a climb to add or remove it from your playlists right there, no disappearing sheet. ([#3452](https://github.com/boardsesh/boardsesh/pull/3452))
  Spin up a brand-new playlist in the same spot without it vanishing mid-name.

## 2026-07-04

### App update

A new version shipped to the App Store and Play Store.

### New

- Mount an iPad on the wall and the On the Wall tab now shows what's lit, big and readable from across the gym ([#3457](https://github.com/boardsesh/boardsesh/pull/3457))
  Step back and forward through the wall's history and tap Light this climb to put an accidental change right
- See what's lit on the wall from your iPad — a new On the Wall tab with the current climb, who's crushing it, the session's hardest send, and recent history, in portrait or landscape ([#3453](https://github.com/boardsesh/boardsesh/pull/3453))
  Smaller iPads now open the board history as a sheet, so the browse list keeps the full screen
- MoonBoard search now hides climbs set on holds you don't have — deselect the wooden holds (or any set) you don't own and those climbs drop out of your results. ([#3320](https://github.com/boardsesh/boardsesh/pull/3320))

### Fixed

- Turn off your MoonBoard's lights from the app — the Clear Lights button now works on MoonBoard walls. ([#3455](https://github.com/boardsesh/boardsesh/pull/3455))
- Queued climbs from a different board no longer flash your wall dark — Boardsesh skips them, tells you, and lights the next climb that fits your setup ([#3454](https://github.com/boardsesh/boardsesh/pull/3454))
  In a party session, a mate on a different wall can no longer knock your whole crew's queue off the current climb
- Original (first-generation) MoonBoard LED boxes are easier to find in the board picker ([#3450](https://github.com/boardsesh/boardsesh/pull/3450))
- Gyms with a single board now say "1 board", not "1 boards" — fixed in English, Spanish, and French ([#3449](https://github.com/boardsesh/boardsesh/pull/3449))
- The About, Acknowledgements, Licenses, and gym-edit screens no longer flash a black background when opened from the side menu in light mode ([#3426](https://github.com/boardsesh/boardsesh/pull/3426))
- On iPad, the sidebar highlight no longer flickers off when you move the pointer away from a tab you're navigating with the keyboard. ([#3446](https://github.com/boardsesh/boardsesh/pull/3446))
- French UI now calls your board « la board » everywhere — no more « panneau » or « planche » ([#3440](https://github.com/boardsesh/boardsesh/pull/3440))
- The board picker no longer flashes "Don't see your board?" tips while it's still scanning — they wait until the scan comes up empty. ([#3444](https://github.com/boardsesh/boardsesh/pull/3444))

## 2026-07-03

### New

- Dev/tester OTA-tooling screens; RN → native rendering with no behaviour change. ([#3321](https://github.com/boardsesh/boardsesh/pull/3321))
- Working a climb all session no longer floods your logbook — burns and the send collapse into one row with the day's total tries. Tap-and-hold or swipe still reaches every individual entry. ([#3384](https://github.com/boardsesh/boardsesh/pull/3384))
  Your projects now show alongside your sends by default. Flip back to sends-only anytime with the Show filter — your choice sticks.
  Open any climb you've worked and see your history per angle: total tries, sessions, and sends at 40° vs 45°.
- Outdated board and gym listings can now be fixed by the community — the setups you browse stay accurate as walls get reconfigured. ([#3313](https://github.com/boardsesh/boardsesh/pull/3313))
- Log a climb on a date other than today — backdate a send you forgot to tick, right from the log sheet. ([#3389](https://github.com/boardsesh/boardsesh/pull/3389))
- Requesting your MoonBoard data now sends a formal GDPR request that spells out exactly what Moon owes you — including what happened to any logbook that went missing. The letter lands on your clipboard so it pastes cleanly into your email. ([#3378](https://github.com/boardsesh/boardsesh/pull/3378))
- Your logbook now reads like a climbing diary — day headers with your send count and hardest send of the day, plus which board you were on. ([#3350](https://github.com/boardsesh/boardsesh/pull/3350))
  Rows lead with how it went: flash, send, or project, with your tries, your stars, and your grade next to the community's call.
  Spot beta at a glance — a violet camera marks every climb you have a video for, and a pencil marks your written notes.
  Swipe a logbook entry right to edit, left to delete (with a confirmation).

### Improved

- Leaving a session from the queue bar now just takes you out of the crew's session — it keeps going for everyone else. It only wraps up the whole session (with the recap) when you're the last one on the wall. ([#3375](https://github.com/boardsesh/boardsesh/pull/3375))
- Party mode: picking a climb from your logbook or a playlist while away from the board view now updates the shared queue instantly — no more waiting on the round trip. ([#3372](https://github.com/boardsesh/boardsesh/pull/3372))
- The hold, area, and setter filter pickers get proper navigation headers with a back button. ([#3371](https://github.com/boardsesh/boardsesh/pull/3371))
  Pasting a beta-video link no longer hides the text field behind the keyboard.
  The invite sheet opens at its intended height on Android.

### Fixed

- The "Show climbs" button in the filter now stays put on smaller iPhones — no more scrolling into a button you can't reach. ([#3433](https://github.com/boardsesh/boardsesh/pull/3433))
  Connecting a board? If yours isn't in the list, the picker now tells you why (asleep, connected to another phone, or too far) and flags when the boards nearby are a different type than the one you've got selected.
- French version now speaks climber French: log an « Enchaîné », count your « croix » — no more « envoyer » a climb ([#3438](https://github.com/boardsesh/boardsesh/pull/3438))
- On iPhone, opening one sheet right after another no longer stalls — the second one comes up as soon as the first finishes sliding away, instead of waiting out a fixed half-second. ([#3425](https://github.com/boardsesh/boardsesh/pull/3425))
- Mini MoonBoard now lights the right holds when you drive the wall from the lock screen or Dynamic Island ([#3413](https://github.com/boardsesh/boardsesh/pull/3413))
- Fixed climbs not lighting up on Kilter and Tension boards for iPhones on iOS 26.5 — no more blank board mid-session or connect–disconnect churn while your partner queues the next problem. ([#3365](https://github.com/boardsesh/boardsesh/pull/3365))
  Sending climbs over Bluetooth is faster: LED data now rides bigger Bluetooth packets when your phone and board support them.
- Lock-screen and Dynamic Island controls are more reliable: the session card no longer freezes on the wrong climb after quick navigation, dies after a hiccup starting up, or flips to "Session ended" minutes after you use it ([#3419](https://github.com/boardsesh/boardsesh/pull/3419))
- Party sessions stay in sync on the lock screen: reconnecting after a dead spot no longer freezes the Live Activity, and a crew mate shuffling the queue no longer flips it to the wrong climb ([#3414](https://github.com/boardsesh/boardsesh/pull/3414))
- What's New now only shows real update notes. Robot commit signatures and stray code links can't sneak into the feed anymore. ([#3424](https://github.com/boardsesh/boardsesh/pull/3424))
  The What's New screen also gets its proper background back, so the "you're on this build" chip is readable again instead of gray-on-black.
- The benchmark badge on a grouped ascents header now matches its climbs — a consensus benchmark no longer shows up on the rows but goes missing on the header. ([#3411](https://github.com/boardsesh/boardsesh/pull/3411))
- Star ratings from imported Kilter and Tension logbooks now show what you actually rated them — a climb you called a 3-star classic is 5 stars again, not "mediocre". ([#3397](https://github.com/boardsesh/boardsesh/pull/3397))
- See exactly who's in your session — the crew count no longer balloons with phantom climbers after a shaky connection, so a solo send stops reading as a party. ([#3338](https://github.com/boardsesh/boardsesh/pull/3338))

## 2026-07-02

### New

- Party queues on your phone stay in step with the crew even on flaky gym wifi — dropped or out-of-order updates get caught and quietly resynced instead of drifting silently. ([#3353](https://github.com/boardsesh/boardsesh/pull/3353))
- Scroll back through everything that's been up on the wall — board history no longer stops at the last 50 climbs ([#3354](https://github.com/boardsesh/boardsesh/pull/3354))

### Improved

- Sending a climb to the wall is snappier, and an accidental double-send no longer shows up twice in board history ([#3344](https://github.com/boardsesh/boardsesh/pull/3344))

### Fixed

- Filters work again: the Apply button no longer disappears after using the hold, area, or setter pickers, so your selections stick. ([#3352](https://github.com/boardsesh/boardsesh/pull/3352))
- Your session's queue is now visible only to people who've actually joined — invite links still show who's climbing before you join. ([#3341](https://github.com/boardsesh/boardsesh/pull/3341))
- The shared queue catches up reliably after a dropped connection, even when someone in the party is running a variable-speed playback. ([#3340](https://github.com/boardsesh/boardsesh/pull/3340))
- Board history keeps itself in sync — the wall feed catches up automatically after connection blips and when you come back to the app ([#3343](https://github.com/boardsesh/boardsesh/pull/3343))
  Smoother board history: no more full-list redraws when you reopen the app

## 2026-07-01

### New

- Your logbook now opens to your sends. Bring attempts back from the filters whenever you want. Old bookmarked logbook links open to sends by default too; flip attempts back on if you want both. ([#3334](https://github.com/boardsesh/boardsesh/pull/3334))

## 2026-06-30

### New

- MoonBoard climbers can now request their data and kick off getting it into Boardsesh ([#3333](https://github.com/boardsesh/boardsesh/pull/3333))
- Crash reports now know which preview channel you're running, so beta bugs get sorted out faster. ([#3327](https://github.com/boardsesh/boardsesh/pull/3327))
- Switch between app versions yourself: open **What's New → Try a preview** to jump onto any preview build — or tap **Production** to get back to the stable app. No tester access needed. ([#3324](https://github.com/boardsesh/boardsesh/pull/3324))

### Fixed

- Kilter logbook sync is more reliable — your Kilter sends and attempts keep importing even when a climb was logged more than once. ([#3329](https://github.com/boardsesh/boardsesh/pull/3329))
- Lock the Tall or Wide filter from its chip menu so it sticks when you clear other filters. ([#3322](https://github.com/boardsesh/boardsesh/pull/3322))
- The Tall and Wide filter chips now work — tap to filter to your homewall's shape, long-press to lock it on. ([#3319](https://github.com/boardsesh/boardsesh/pull/3319))
  Tap the Grade chip again (or swipe the grade picker away) to close it.

## 2026-06-29

### App update

A new version shipped to the App Store and Play Store.

### New

- On Android, the tag showing whose climb is on the wall is now a clean "On the wall" status band that fits the app instead of an iOS-style pill. ([#3293](https://github.com/boardsesh/boardsesh/pull/3293))
- Filter the gym map by how many boards a gym has, the board, the layout, and the exact size ([#3317](https://github.com/boardsesh/boardsesh/pull/3317))
  Hunt down a specific wall — like a 16x10 Kilter — instead of scrolling every gym nearby
- Cleaner single-choice filters in the climb-filter sheet — the status and accuracy pickers now use the native iOS/Android selection controls. ([#3280](https://github.com/boardsesh/boardsesh/pull/3280))
- Android: your climb filters now live in a tappable chip row right under the search bar — change grade, popularity, min rating, and what's shown in a single tap, no digging through a menu. ([#3310](https://github.com/boardsesh/boardsesh/pull/3310))
  Long-press the Tall or Wide chip to pin it so it sticks through clears.
- The workout generator's count steppers are easier to use — the number now sits between the − and + buttons, and you can press and hold to fly through the range. ([#3291](https://github.com/boardsesh/boardsesh/pull/3291))
- Buttons across the app now use the real iOS and Android button — so a tap feels native: the system's own press animation, a crisp spinner while something's loading instead of three dots, and delete/disconnect actions that turn the proper system red. Your main violet action button stays bold and solid over busy board art and in dark mode, while quieter buttons pick up iOS 26's Liquid Glass on a calm background. ([#3309](https://github.com/boardsesh/boardsesh/pull/3309))
- Sign-in and profile fields now use your phone's own keyboard, password autofill, and (on iPhone) Strong Password. ([#3284](https://github.com/boardsesh/boardsesh/pull/3284))
- Mini MoonBoard is here — both the 2020 and 2025 Mini boards now show up with the right holds, so you can find problems, build a queue and log your sends on a Mini just like the full-size wall. ([#3287](https://github.com/boardsesh/boardsesh/pull/3287))
- Android: the Home scope switcher now opens a smoother, native dropdown. ([#3279](https://github.com/boardsesh/boardsesh/pull/3279))
- In the logbook, Latest and Hardest are now quick-tap chips at the top — switch how your ticks are sorted without opening the filter sheet. (iOS; the rest of the filters stay one tap away in the sheet.) ([#3265](https://github.com/boardsesh/boardsesh/pull/3265))
- See the grade you gave each climb right in its logbook ([#3274](https://github.com/boardsesh/boardsesh/pull/3274))
  Logbook, community, and similar-climbs sections now stay open if you leave them open
  Long-press a climb's name to copy it
- Find What's New in the user menu now — tap your avatar to see the latest updates, with a badge when there's something fresh. ([#3276](https://github.com/boardsesh/boardsesh/pull/3276))

### Fixed

- Long boulder names read in full again — the climb view and the play bar scroll a long name so nothing gets cut off. ([#3255](https://github.com/boardsesh/boardsesh/pull/3255))
- The board, layout, and size buttons on board setup no longer cut off their labels — they wrap to fit and every option is visible. ([#3292](https://github.com/boardsesh/boardsesh/pull/3292))
- MoonBoard sends now show the board preview in your crew's session feed, just like Kilter and Tension. ([#3286](https://github.com/boardsesh/boardsesh/pull/3286))

## 2026-06-28

### App update

A new version shipped to the App Store and Play Store.

### New

- Your settings now use your phone's own native controls and layout — the More screen looks and moves like the rest of iOS and Android. ([#3261](https://github.com/boardsesh/boardsesh/pull/3261))
- Switches, segmented pickers, and the angle slider now use your phone's own native controls, so they look and move like the rest of iOS and Android. ([#3254](https://github.com/boardsesh/boardsesh/pull/3254))
- See which playlists a climb is in, right from the list. Turn on **Show playlist tags** under More → Display. ([#3260](https://github.com/boardsesh/boardsesh/pull/3260))
- Curious what's coming? Open What's New and tap **Try a preview** to load an upcoming change before it ships — then reset to jump back to the shipped version anytime. ([#3258](https://github.com/boardsesh/boardsesh/pull/3258))
- The current climb's bar now stays on your main tabs and gets out of the way on detail, filter, and settings screens. ([#3253](https://github.com/boardsesh/boardsesh/pull/3253))
- See who's on the wall at a glance — when a crewmate lights up a different climb, their face and the climb show in a capsule up top, and the bottom bar stays your own queue. ([#3247](https://github.com/boardsesh/boardsesh/pull/3247))

### Improved

- Internal CI change — no user-facing or runtime behavior change. Wires the existing mobile dependency-health check into the CI pipeline so native-module drift from the Expo SDK fails the build instead of being opt-in. ([#3248](https://github.com/boardsesh/boardsesh/pull/3248))
- Draft pilot enabling React Compiler auto-memoization; not yet shipped — pending measurement. ([#3239](https://github.com/boardsesh/boardsesh/pull/3239))

### Fixed

- The grade filter button on the climbs screen now just says "Grade" until you pick a range. ([#3264](https://github.com/boardsesh/boardsesh/pull/3264))
- The grade filter now opens where you left off — on your recent grades instead of scrolled all the way back to the easy end. ([#3256](https://github.com/boardsesh/boardsesh/pull/3256))

## 2026-06-27

### App update

A new version shipped to the App Store and Play Store.

### New

- Filter the climb list right where you are — grade, sort, popularity, and your recent filters now sit in a chip row under the title instead of behind a button. ([#3245](https://github.com/boardsesh/boardsesh/pull/3245))
  Home-wall boards get Tall/Wide chips; long-press to lock one so the right climbs always show.
- Internal/ops change — no user-facing behavior change. Adds a non-blocking post-publish health check for production OTA updates and a documented rollback runbook. The health gate ships inert and activates once the `POSTHOG_PERSONAL_API_KEY` repo secret is added to the Production environment. ([#3243](https://github.com/boardsesh/boardsesh/pull/3243))

### Improved

- Internal dependency-hygiene change. No user-facing or runtime behavior change — native module versions are unchanged, only their version *ranges* are tightened to the already-installed versions, plus a new read-only CI check. ([#3237](https://github.com/boardsesh/boardsesh/pull/3237))
- App Store metadata copy + version bump only; no in-app behaviour changes. ([#3246](https://github.com/boardsesh/boardsesh/pull/3246))
- Internal CI/build hygiene — no user-facing change. ([#3238](https://github.com/boardsesh/boardsesh/pull/3238))

### Fixed

- Internal preview-tester tooling hardening — removes a write-capable EAS token from preview builds; the in-app branch switcher now repoints the build at a branch device-locally. No public, user-facing change. ([#3241](https://github.com/boardsesh/boardsesh/pull/3241))
- Playlist creation errors now appear inside the sheet instead of an invisible toast behind it. ([#3240](https://github.com/boardsesh/boardsesh/pull/3240))
- Filter climbs by setter, hold type, or board region again — these pickers were opening to a blank sheet that vanished on its own, and now open full-screen. ([#3236](https://github.com/boardsesh/boardsesh/pull/3236))
  Scroll the whole filter sheet — expanding the Refine or Advanced sections no longer hides options below the fold.
- Party-mode realtime now reconnects after an auth refresh, and queries pause offline and refetch when the connection returns. ([#3242](https://github.com/boardsesh/boardsesh/pull/3242))
- Kilter and Tension boards light up reliably again on iPhone — climbs send to the wall instead of the board connecting but staying dark. ([#3228](https://github.com/boardsesh/boardsesh/pull/3228))

## 2026-06-26

### App update

A new version shipped to the App Store and Play Store.

### New

- Tap any climb in a circuit or playlist and the whole list drops into your queue in order — swipe right or hit back to revisit the boulders above, not just jump to the next one. ([#2773](https://github.com/boardsesh/boardsesh/pull/2773))
  A heads-up before a playlist takes over your queue, so you don't lose climbs you'd lined up.
- Connect your Kilter account with your username and password to pull your sends, attempts, ratings, and circuits into Boardsesh. ([#3170](https://github.com/boardsesh/boardsesh/pull/3170))
  Used the old Kilter app built by Aurora? Import a JSON export or request your data from the new "Kilter (Aurora)" card.
- MoonBoard hold circles are now bigger and easier to read at a glance. ([#3218](https://github.com/boardsesh/boardsesh/pull/3218))
- Thousands more MoonBoard problems, now with real grades, star ratings and send counts — and the Mini 2025 and original 2010 boards join the lineup. Your 25° sessions on the 2016 and 2024 boards finally have their own graded problems too. ([#3214](https://github.com/boardsesh/boardsesh/pull/3214))
- Pick hold colours with a real colour picker — slide lightness, saturation, and hue instead of typing numbers ([#3212](https://github.com/boardsesh/boardsesh/pull/3212))
  Built for colour blindness: a lightness-first picker, plus a toggle to preview your colours through red-green and blue-yellow colour blindness
  New octagon marker shape, so every hold role can have its own distinct shape
  Accessibility hold settings now live on their own page, with a live preview on your board
- Sorting by Hardest now reads top-to-bottom the way you'd expect, and every logbook entry shows both grades — the grade you logged, plus the community consensus beside it when the crowd disagrees (and on climbs you never graded yourself). ([#3202](https://github.com/boardsesh/boardsesh/pull/3202))

### Fixed

- MoonBoard holds now light up on iPhone — connect and your problem shows on the wall. ([#3225](https://github.com/boardsesh/boardsesh/pull/3225))
- Pinch-to-zoom now works first try when setting a climb or filtering holds on Android, instead of taking several tries or swiping the sheet shut ([#3045](https://github.com/boardsesh/boardsesh/pull/3045))
- The Ascents by angle chart now reads clearly when a climb is popular at lots of angles — angle labels stay readable and rarely-climbed angles no longer vanish next to a dominant one. ([#3221](https://github.com/boardsesh/boardsesh/pull/3221))
- The Accessibility settings now make it clear that custom hold colours light up your board, not just the in-app markers — so the feature stops looking like it's missing. ([#3220](https://github.com/boardsesh/boardsesh/pull/3220))
- MoonBoard on iPhone now recovers and re-lights the wall after a flaky Bluetooth moment instead of going dark, and the Dynamic Island climb controls drive a MoonBoard too. ([#3219](https://github.com/boardsesh/boardsesh/pull/3219))
- Fixed an iOS freeze where the app could stop responding to taps after opening and closing sheets (board history, the queue, filters) or after using the sidebar. ([#3211](https://github.com/boardsesh/boardsesh/pull/3211))
- Smoothed out the logbook filter: swipe down or tap outside to close it and your filters and sort apply automatically (no more Apply button), the grade picker opens at the start instead of jumping to the middle, and the Refine and Advanced sections start tucked away so it opens tidy. ([#3201](https://github.com/boardsesh/boardsesh/pull/3201))

## 2026-06-25

### App update

A new version shipped to the App Store and Play Store.

### New

- Logbook search and filters are tucked away while we put the finishing touches on them ([#3200](https://github.com/boardsesh/boardsesh/pull/3200))
- Testers can now flip feature flags on or off right in the app, no new build needed ([#3199](https://github.com/boardsesh/boardsesh/pull/3199))
- Your logbook is searchable again on mobile. Head to You → Logbook to find a climb by name, narrow by grade, angle, date, or sends/attempts, and sort by **Latest** or **Hardest** so your hardest ticks rise to the top. The filter button is amber, so you always know you're searching your logbook, not the whole board. ([#3179](https://github.com/boardsesh/boardsesh/pull/3179))
- The full MoonBoard 2024 catalog is now on Boardsesh — every problem shows its style (footless, footless + kickboard, no-kickboard) as a tag. ([#3151](https://github.com/boardsesh/boardsesh/pull/3151))
- Forgot your password? Now you can reset it — tap "Forgot password?" on the login screen and we'll email you a secure reset link. Works on web and mobile. ([#3185](https://github.com/boardsesh/boardsesh/pull/3185))
- MoonBoard problems now carry their style — footless, footless + kickboard, and no-kickboard show as tags right on the climb, and you can pick one when you set a problem. Benchmarks are now set by the crew that curates them, not anyone with the create screen open. Under the hood, "no matching" is proper climb data now instead of a note buried in the description. ([#3171](https://github.com/boardsesh/boardsesh/pull/3171))

### Fixed

- Flick through climbs in the player without the view accidentally sliding shut mid-swipe. ([#3195](https://github.com/boardsesh/boardsesh/pull/3195))
  On Android, the next climb now lands cleanly at the end of a swipe — no more flash.
- Fixed password reset emails linking to `localhost:3000` instead of `www.boardsesh.com` — the reset link in your inbox will now take you to the right place. ([#3196](https://github.com/boardsesh/boardsesh/pull/3196))
- Tap a climb on a flaky Bluetooth link and the wall now re-lights itself instead of staying dark — no more re-tapping a climb that didn't show up. ([#3186](https://github.com/boardsesh/boardsesh/pull/3186))

## 2026-06-24

### App update

A new version shipped to the Play Store.

### New

- Find a gym by board type ([#3178](https://github.com/boardsesh/boardsesh/pull/3178))
  Filter the map to gyms that have a Kilter, Tension, or MoonBoard.

## 2026-06-23

### New

- Bring your Instagram climbing beta into Boardsesh. On your Instagram profile, run the quick scan, paste it into Import Beta, and Boardsesh shows which of your filmed climbs aren't linked yet. Attach the missing ones in a couple of taps and your videos show up as beta on those climbs for the whole crew. Works with Kilter and Tension. ([#3117](https://github.com/boardsesh/boardsesh/pull/3117))

### Fixed

- Fixed the app freezing on some Android phones (Samsung S24/S25, Pixel) — if you'd changed your phone's display size, the app could open but ignore every tap and swipe. Touch works again. ([#3165](https://github.com/boardsesh/boardsesh/pull/3165))

## 2026-06-22

### App update

A new version shipped to the App Store and Play Store.

### Fixed

- Android: if the sign-in screen won't respond to taps on a newer phone, the login screen now shows how to sign in using split-screen while we fix the freeze. ([#3159](https://github.com/boardsesh/boardsesh/pull/3159))
- Sign-in on recent Android phones no longer leaves the login form unresponsive — you can tap and sign in without the split-screen workaround. ([#3158](https://github.com/boardsesh/boardsesh/pull/3158))
- Android: fixed a freeze on some phones (Pixel 10, Galaxy S24+) where the login screen and climb list stopped responding to taps — the app stays responsive now. ([#3148](https://github.com/boardsesh/boardsesh/pull/3148))

## 2026-06-21

### App update

A new version shipped to the Play Store.

### New

- Stuck at sign-in? Report a bug or jump into Discord without logging in first. ([#3131](https://github.com/boardsesh/boardsesh/pull/3131))
- You can now see at a glance when you're driving the board: the bar lights up when you have control, shows who's driving when a crewmate has it, and lets you connect or open board controls right from the bar — no digging into the climb view. ([#3115](https://github.com/boardsesh/boardsesh/pull/3115))

### Fixed

- Your session stats now count only your own climbs. On the You and profile Sessions tabs, your weekly sends and flashes, grade spread, and hardest send no longer fold in your crew's climbs from group sessions. ([#3140](https://github.com/boardsesh/boardsesh/pull/3140))
- Tester-only dev tooling + backend security/integrity hardening; nothing climber-facing. ([#3116](https://github.com/boardsesh/boardsesh/pull/3116))

## 2026-06-20

### App update

A new version shipped to the App Store and Play Store.

### New

- Beta testers can now switch OTA update channels right in the app to preview a specific build. ([#3068](https://github.com/boardsesh/boardsesh/pull/3068))
- See when a new app version landed — What's New now flags store updates, so you can tell what arrived over the air from what needs an app update. ([#3101](https://github.com/boardsesh/boardsesh/pull/3101))
  Tap "Check for updates" in What's New to grab the latest fixes on the spot.
- See a climber's recent beta videos right on their profile — swipe through the shelf or tap See all for the full grid. ([#3076](https://github.com/boardsesh/boardsesh/pull/3076))
- Drive your board from the Android session notification ([#3073](https://github.com/boardsesh/boardsesh/pull/3073))
  The session notification now shows your current climb with its grade, angle, and your spot in the queue, and draws the board art right on your phone. Previous and Next move the board through your queue without opening the app, and the lightbulb shows when you're connected. When a crewmate takes the board, the card steps back to show what's on the wall.
- The lock-screen Live Activity got a cleaner look and now knows who's on the board. ([#3077](https://github.com/boardsesh/boardsesh/pull/3077))
  When you're connected, the bulb glows and Prev/Next move the wall through your
  queue; when a crewmate takes over, it shows what they're climbing instead. The
  grade shows in its real grade colour up in the corner, and the board thumbnail is
  easier to read at a glance.

### Improved

- Boards open without a hitch on Android — selecting a board no longer briefly freezes the app. ([#3099](https://github.com/boardsesh/boardsesh/pull/3099))

### Fixed

- Find a gym on a full-screen map you can drag to resize, pan to explore new areas, and search by city — board picking right from the map. ([#3118](https://github.com/boardsesh/boardsesh/pull/3118))
- The wall history keeps up with your crew now — sends from friends show up right away, even after your phone's been in your pocket or your signal dropped for a moment. Pull down on the history list any time to refresh it. ([#3111](https://github.com/boardsesh/boardsesh/pull/3111))
- Fixed an Android freeze where the app could stop responding after a couple of minutes — the climb list wouldn't scroll and both bars went dead until you reopened the app. It stays live now. ([#3108](https://github.com/boardsesh/boardsesh/pull/3108))
- Fixed an Android freeze where the top and bottom bars stopped responding right after you picked a climb. ([#3104](https://github.com/boardsesh/boardsesh/pull/3104))
- Sign in with Apple now falls back to a browser sign-in on iPhone when the native prompt can't complete, so you're not locked out. ([#3092](https://github.com/boardsesh/boardsesh/pull/3092))
- Pick a board and keep climbing — fixed an Android freeze that hit right after switching boards. ([#3097](https://github.com/boardsesh/boardsesh/pull/3097))
- Playlist grades now match the wall angle you've dialed in, instead of a climb's most-popular angle ([#3090](https://github.com/boardsesh/boardsesh/pull/3090))

## 2026-06-19

### App update

A new version shipped to the App Store and Play Store.

### New

- See what's new right in the app — a What's New page now lives under Settings, with a "New" dot when there's an update you haven't read yet. ([#3066](https://github.com/boardsesh/boardsesh/pull/3066))

### Fixed

- The board view now renders natively on the newest Android phones that use 16 KB memory pages (Android 15 and later, 64-bit devices). ([#3069](https://github.com/boardsesh/boardsesh/pull/3069))
