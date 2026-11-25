# Quantum Board and eWalls: what we propose and what we need

Status: **proposal**, for the eWalls team at Walltopia.

Boardsesh would like Quantum Board climbs to show in Boardsesh and climbs set
in Boardsesh to show in eWalls, with shared totals for everyone and a shared
logbook, favourites and playlists for climbers who link their two accounts.
Boardsesh does the syncing: it reads the eWalls API on a schedule and sends
its own changes to the eWalls API. eWalls builds no sync client. The general
design is in [board-manufacturer-sync.md](board-manufacturer-sync.md); this
page applies it to the Quantum Board and lists our questions so they can be
answered one by one.

Walltopia has agreed to open the eWalls API to Boardsesh. Boardsesh is an
independent app and is not a Walltopia app. Quantum Board and eWalls are
Walltopia's products and names.

## Scope

We propose to start with the Quantum Board **XL, L, M and S**.

The Belay board and other walls that eWalls serves are out of scope for now.
We are happy to support them later; they need changes to how Boardsesh draws
and lays out a board first. Nothing in this document asks about them.

## The first ask

1. **A few test user accounts** on eWalls that we may use for testing. We do
   not need a separate test environment.
2. **Permission to read the public Quantum Board catalogue** through the
   eWalls API, and a short written statement of which climbs are public.

That is enough for phase 1. How the two apps share one physical board
(section F) also needs testing on a real board before release. Everything else can follow at a pace that suits
eWalls.

## What Boardsesh proposes for Quantum

| | Proposal |
| --- | --- |
| eWalls to Boardsesh, public climbs and totals | Boardsesh pulls on a schedule, for everyone |
| eWalls to Boardsesh, boards and gyms | Boardsesh pulls the list of installed Quantum Boards and their venues, if eWalls has it |
| eWalls to Boardsesh, a linked climber's logbook, favourites, playlists | Boardsesh pulls with that climber's token, when they open Boardsesh and on the schedule |
| Boardsesh to eWalls, a linked climber's changes | Boardsesh pushes at once, as that climber |
| Boardsesh to eWalls, climbers without an eWalls account | Boardsesh pushes their public climbs with their public Boardsesh name as setter, and their share of the totals, on the schedule. Their logbook does not cross |
| Sign-in | Climbers sign in on eWalls' own page and Boardsesh stores the token. eWalls does not need to call Boardsesh |
| Creating an eWalls account | Offered inside Boardsesh by opening the sign-up page eWalls chooses. Boardsesh encourages it and does not require it |
| Pushes from eWalls to Boardsesh | Not needed. Welcome if eWalls wants its changes to arrive sooner |
| Public snapshot | We ask that the public Quantum Board catalogue may be part of Boardsesh's downloadable snapshot |

### Phases

| Phase | Result | Needs from eWalls |
| --- | --- | --- |
| 1. Read | Quantum Board in Boardsesh: browse, light, log in Boardsesh | The first ask; sections A, B, F and I; E1 and E4 |
| 2. Linked accounts | One logbook, favourites, projects and playlists in both apps; climbs a linked climber sets appear in both | Section C |
| 3. Everyone else | Climbs from climbers without an eWalls account, and their share of the totals, in eWalls | Sections D and E. This phase needs new endpoints and a credential that acts for no climber |

## Questions for eWalls

Each has a letter and number so answers can refer to it.

Where a question says "we see", this comes from our reading of the eWalls
Android app, not from a contract. Our notes are in
[QUANTUM_API_SPEC.md](QUANTUM_API_SPEC.md) and
[QUANTUM_BLUETOOTH_PROTOCOL_SPEC.md](../boards/QUANTUM_BLUETOOTH_PROTOCOL_SPEC.md).

### A. Access

- **A1.** May Boardsesh use the email login the app uses, for test accounts
  now and for linked climbers until there is another sign-in?
- **A2.** How long does a token live and how is it renewed? We have not seen
  a refresh step. Boardsesh pulls in the background, so it needs a token that
  can be renewed without the climber.
- **A3.** Which headers should Boardsesh send to identify itself?
- **A4.** What rate limits apply, and how should we back off?
- **A5.** Would eWalls offer a standard OAuth 2.0 sign-in for linking, with
  sign-up on the same page? See
  [Linking an account](board-manufacturer-sync.md#linking-an-account).
- **A6.** When Boardsesh creates a record (a climb, an ascent, a playlist) and
  gets no answer, how can it repeat the request safely? We would send the
  same request key each time. Can the server refuse a second create with a
  key it has seen, or tell us what happened to a key? The app sends a client
  id with an ascent, and we do not know whether the server uses it.

### B. The catalogue, eWalls to Boardsesh

- **B1.** Which climbs are public? Are there gym-only climbs, private boards,
  or climbs set commercially for one venue? We will leave out anything that is
  not plainly public, so we need to know how to tell.
- **B2.** Is the first download stable while it is being paged? If climbs
  change during paging, can a page be missed or repeated?
- **B3.** The change timestamp: may we treat it as a cursor and send it back
  unchanged? How far back can we resume before a full download is required?
- **B4.** Are removals always sent, or can a climb disappear without one?
- **B5.** A climb has one angle in eWalls. Boardsesh treats a climb as the
  same climb at every angle and keeps totals per angle. We see a read of a
  climb's ascents by angle. Are ascents recorded at the angle the climber
  climbed, or always at the climb's angle?
- **B6.** Grades: we see options with an id, a label and a value that can
  cover a range, and a V grade and a Font grade that share one value. Which
  is the identity of a grade, and what is the mapping to Font and V grades?
- **B7.** The allowed angles for XL, L, M and S. We have the app's menu
  options, not the physical limits.
- **B8.** Board identity: is the advertised Bluetooth name the right key for a
  board, and can two boards share one?
- **B9.** Can two climbs in eWalls have exactly the same holds? Boardsesh
  shows such climbs as one climb, under the name and setter of the one
  published first, and adds their ascents and totals together. Each stays a
  separate climb in eWalls. A person who sent both is then counted twice in
  Boardsesh. Can eWalls return the number of distinct people across a set of
  climb ids?

### C. Linked accounts

- **C1.** How does Boardsesh read one climber's complete logbook? We see
  ascents inside the catalogue changes, apparently including other climbers',
  but not a full history for one climber.
- **C2.** Who can see an ascent in eWalls: everyone, or only the climber?
  Boardsesh has "Only me" ascents and will tell the climber before linking.
- **C3.** When Boardsesh logs an ascent, does the response give its permanent
  id? (See also A6.)
- **C4.** Can an ascent carry the date and time it was climbed, and is that
  returned unchanged? This matters for sends logged offline and for a
  climber's history from before they linked.
- **C5.** Can an ascent carry the angle it was climbed at?
- **C6.** Can an ascent be edited and deleted through the API? We see
  deletions arriving in the changes but no request that makes one.
- **C7.** Do records carry an "updated at" time? Can an edit state the
  version it expects to change, so that it is refused if the record changed
  in the meantime?
- **C8.** Favourites and projects appear to change through GET requests. Is
  there a form that is safe for Boardsesh to repeat?
- **C9.** Playlists: is there a way to read what changed, and is the order of
  climbs in a playlist stored?
- **C10.** A linked climber sets a climb in Boardsesh and Boardsesh creates it
  in eWalls as that climber. Does setting a climb need a special role? What
  are the validation rules (hold count, start and finish holds, name length,
  allowed angles and grades), so Boardsesh can check them before saving?
- **C11.** How does Boardsesh learn that a climber deleted their eWalls
  account, or that eWalls suspended it?

### D. Climbers without an eWalls account

These need something eWalls does not have today.

- **D1.** May Boardsesh have a partner credential that can create and edit
  climbs on Quantum Boards?
- **D2.** Can a climb show a setter name as plain text when the setter has no
  eWalls account? Today a setter appears to be an eWalls user with a first and
  last name.
- **D3.** When that setter later links an eWalls account, can their climbs be
  moved to it?
- **D4.** Should these climbs be marked in the eWalls app, for example "set in
  Boardsesh"?
- **D5.** When eWalls hides or removes one of these climbs, will it appear as
  a removal in the changes, so Boardsesh does not create it again?

### E. Totals

- **E1.** What do the plays, ascents and rating numbers on a climb count:
  people or logged ascents? Per angle or per climb? What is the rating scale?
- **E2.** Can eWalls accept Boardsesh's totals for a climb and angle (number
  of people who sent it, rating sum and count, grade votes), replaced once a
  day?
- **E3.** Can eWalls keep those apart from its own totals, return its own
  totals unchanged in the API, and show the two added together in the app?
  Otherwise Boardsesh reads its own numbers back and counts them twice.
- **E4.** Is there a grade-vote breakdown per climb, or only the grade the
  setter chose?

### F. Multi-climber mode and the shared wall

The controller holds several coloured layers at once, one per active player
(a player is one lit layer on the wall), and eWalls shows who is on the wall.

How Boardsesh intends to behave:

- Light one layer per player.
- Read the active players before every change and confirm afterwards.
- Replace or clear only its own layer.
- Never cut a climb short to make it fit a command. See F9.
- Use the binary protocol only.

**Sessions.** In a Boardsesh session a group shares one queue and takes turns
on the wall. The session lights one climb at a time, so to the controller it
is **one player**, and it keeps the same player id when the turn passes to the
next person in the group. Two separate sessions on one wall are two players.
A climber outside any session is one player.

**Who is on the wall.** Boardsesh has a board presence feature: it shows who
is on a board and what is lit. For Quantum we propose the Boardsesh
backend subscribes to the eWalls board socket, so eWalls climbers appear in
Boardsesh, and we would like Boardsesh climbers to appear in eWalls the same
way.

**Climbs the other app does not know.** A climber can light a climb that is
not saved yet. eWalls may have the same case with its own unsaved climbs. We
propose that each app shows the lit holds and the climber's name, with no
link to a climb, when it does not know the climb.

What we need to know:

- **F1.** The commands that light a climb or turn a player off carry a
  16-byte user id. Is it the eWalls user id,
  and does the controller or eWalls check it?
- **F2.** What should a Boardsesh climber with no eWalls account present as
  their player id? And a session? We would like a way that does not need an
  account, for example an id Boardsesh generates.
- **F3.** How many layers does the firmware support? We see a "no more users
  accepted" error and would like to know the limit behind it.
- **F4.** Who may clear another player's layer? Commands carry a duration;
  what is the board default, and can a gym change it?
- **F5.** We see a "user id in use" error. A linked climber may have eWalls
  and Boardsesh open on the same wall with the same id. What should happen?
- **F6.** May the Boardsesh backend subscribe to the board socket without a
  climber's token, with the partner credential? The app connects with a
  climber's token.
- **F7.** How should Boardsesh report what its climbers light, so that eWalls
  shows them: through the socket, or another way?
- **F8.** Which firmware and protocol versions are in the field for XL, L, M
  and S, and is the older JSON protocol still in use?
- **F9.** A command holds up to 92 diodes and the eWalls app sends a larger
  climb as several commands. Do repeated commands add to a player's layer or
  replace it?
- **F10.** A few controller details we could not settle from the app: which
  board type names are XL, L, M and S; how a diode id maps to an LED address
  on each; whether pairing is needed; the largest write size and the pause
  the controller needs between commands.

Section F is probably easiest to settle in a call. We would be glad to have
one with whoever works on the controller firmware, if that helps.

### G. The public snapshot

- **G1.** May the public Quantum Board catalogue be included in Boardsesh's
  downloadable snapshot? The three options are in
  [the general proposal](board-manufacturer-sync.md#the-public-snapshot).
  Setter names and first-ascent names are part of the catalogue and would be
  included.

### H. Names

- **H1.** Does Walltopia agree to the terms under
  [Names and trademarks](board-manufacturer-sync.md#names-and-trademarks):
  each side may name the other to describe the integration, and the
  permission covers Boardsesh's own apps and website and not copies of its
  open-source code?
- **H2.** Is there a logo and wording Walltopia would like Boardsesh to use?

### I. Boards and gyms

Boardsesh ties ascents, sessions and board presence to the physical board,
and shows gyms with the boards they have.

- **I1.** Does eWalls hold a list of installed Quantum Boards, each with a
  stable id, its model, the name it advertises over Bluetooth, and the venue
  it is in? May Boardsesh read it?
- **I2.** Does eWalls hold venue details (name, address or coordinates), and
  does it tell a public venue from a private home?
- **I3.** Does an ascent in eWalls record which board it was logged on, and
  can Boardsesh send that when it logs an ascent?
- **I4.** When a board moves to another venue or is replaced, does its id
  stay the same?

### J. Optional

- **J1.** Would eWalls like to send its changes to Boardsesh, or send a short
  "something changed for this climber" message, so they arrive sooner than
  the scheduled pull? Boardsesh does not need this to start.
