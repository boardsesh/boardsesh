# Quantum Board and eWalls: what we propose and what we need

Status: **proposal**, for the eWalls team at Walltopia.

Boardsesh would like to show Quantum Board climbs in its app and have climbs
set in Boardsesh show in eWalls, with shared totals for everyone and a shared
logbook for climbers who link their two accounts. This page applies the
general design in [board-manufacturer-sync.md](board-manufacturer-sync.md) to
the Quantum Board and lists our questions so they can be answered one by one.
The first request is small: a test environment and a read-only credential.
Everything else can follow at a pace that suits eWalls.

Boardsesh is independent and is not an official Walltopia app. Quantum Board
and eWalls are Walltopia's products and names.

## The first ask

Two things let us replace guesses with facts, and commit neither side to more:

1. **A test environment**, with one test account and, if possible, access to a
   test board or a controller we can borrow or buy.
2. **A read-only system credential** for the public Quantum catalogue, and a
   sentence from eWalls saying which climbs that credential is meant to see.

## Where Boardsesh is today

Boardsesh has a working prototype of Quantum Board support. It is not
released: the board is hidden in the apps behind a feature flag that is off,
and the catalogue download has not been run against the production service.

- All five models are supported as fixed board layouts: XL, L and M share one
  layout; S Fitness and Belay each have their own.
- The public catalogue is read from eWalls as a complete first download
  followed by changes, every six hours. We first built this by reading the
  code of the eWalls Android app (2.6.5), without sending requests, so it
  rests on our reading and not on an agreed contract. Our notes are in
  [QUANTUM_API_SPEC.md](QUANTUM_API_SPEC.md). We would like to replace it with
  whatever eWalls specifies.
- The board is lit over Bluetooth with the binary protocol. Boardsesh reads
  the list of active players before it writes, and leaves other players'
  layers alone. Notes:
  [QUANTUM_BLUETOOTH_PROTOCOL_SPEC.md](../boards/QUANTUM_BLUETOOTH_PROTOCOL_SPEC.md).
- Nothing personal is kept. The catalogue changes can include ascents,
  favourites and projects; Boardsesh discards them, and writes nothing to
  eWalls.
- None of it has been tested against a real controller or with an account
  eWalls has approved for the purpose.

## What Boardsesh proposes for Quantum

| | Proposal |
| --- | --- |
| Catalogue, eWalls to Boardsesh | Boardsesh pulls public climbs and totals with the system credential |
| Catalogue, Boardsesh to eWalls | eWalls pulls two Boardsesh feeds: public climbs set in Boardsesh on Quantum boards, and Boardsesh totals for every public Quantum climb |
| Climbers without an eWalls account | Their public climbs cross with their public Boardsesh name as setter. Their sends count in totals. Their logbook does not cross |
| Climbers who link | Their logbook is the same in both apps; later favourites, projects and lists |
| Creating an eWalls account | Offered inside Boardsesh by opening the sign-up page eWalls chooses; never required |
| Public snapshot | We ask that the public Quantum catalogue may be part of Boardsesh's downloadable snapshot. Options are in the general proposal |

## Questions for eWalls

Each has a letter and number so answers can refer to it.

### A. Access

- **A1.** Is there a test environment Boardsesh may use (the app refers to a
  test host), and how do we get an account on it?
- **A2.** How should a partner authenticate for catalogue reads? A long-lived
  system token is enough for us.
- **A3.** How long does a token live and how is it renewed? We have not seen a
  refresh step.
- **A4.** Which headers should Boardsesh send to identify itself?
- **A5.** What rate limits apply, and how should we back off?

### B. The catalogue, eWalls to Boardsesh

- **B1.** Which climbs are public? Are there gym-only climbs, private boards,
  or climbs set commercially for one venue? We will leave out anything that is
  not plainly public, so we need to know how to tell.
- **B2.** Is the first download stable while it is being paged? If climbs
  change during paging, can a page be missed or repeated?
- **B3.** The change timestamp: is it safe to treat as an opaque cursor? How
  far back can we resume before a full download is required?
- **B4.** Are deletions always sent, or can a climb disappear without one?
- **B5.** Does a climb's angle ever change after it is published? What does a
  missing angle mean?
- **B6.** Grades: we see options with an id, a label and a value that can
  cover a range, and a V grade and a Font grade that share one value. Which
  is the identity of a grade, and what is the mapping to Font and V grades?
- **B7.** The allowed angles per model. We have the app's menu options, not
  the physical limits.
- **B8.** Board identity: is the advertised Bluetooth name the right key for a
  board, and can two boards share one?

### C. The catalogue, Boardsesh to eWalls

- **C1.** Is pulling two feeds from Boardsesh acceptable, or would eWalls
  rather receive pushes?
- **C2.** Can a climb in eWalls store an external id and an origin, and return
  both in the catalogue you send us? Without it, a Boardsesh climb comes back
  to us as a new eWalls climb.
- **C3.** Can a climb show a setter name as plain text when the setter has no
  eWalls account? Today a setter appears to be an eWalls user with a first and
  last name.
- **C4.** Are there limits a Boardsesh climb must respect to be accepted: hold
  count, start and finish rules, name length, allowed characters?
- **C5.** Should Boardsesh climbs be marked in the eWalls app, for example
  "set in Boardsesh"?
- **C6.** When eWalls removes a Boardsesh climb from its app, how do we learn
  of it?

### D. Totals

- **D1.** What do the plays, ascents and rating numbers on a climb count:
  people or logged ascents? Per angle or per climb? What is the rating scale?
- **D2.** Can an ascent record its origin ("logged in eWalls" or "received
  from Boardsesh"), and can totals be given for eWalls-native ascents only?
  This is what keeps a linked climber from being counted in both apps.
- **D3.** Can eWalls show its own totals plus the Boardsesh totals from our
  feed?
- **D4.** Is there a grade-vote breakdown per climb, or only the grade the
  setter chose?

### E. Linked accounts and logbooks

- **E1.** Would eWalls offer a standard OAuth 2.0 sign-in for linking, with
  sign-up on the same page? If not now, may Boardsesh use the existing email
  login for linked climbers in the meantime?
- **E2.** The app sends a client id with an ascent. Does the server use it to
  make a repeated request safe, and does the response give the permanent id
  of the ascent?
- **E3.** Can an upload carry the date and time the climb happened, for
  ascents logged offline or imported from the past? And the angle?
- **E4.** Can an ascent be edited and deleted through the API? We see
  deletions arriving in the change feed but no request that makes one.
- **E5.** How does a partner read one climber's complete logbook? We see
  ascents inside the catalogue changes but not a full history per user.
- **E6.** Favourites and projects appear to change through GET requests. Is
  there a form that is safe for a sync client to retry?
- **E7.** Lists: is there a change feed, and is the order of climbs in a list
  stored?
- **E8.** What should happen in eWalls when a climber unlinks?

### F. Multi-climber mode and the shared wall

The controller holds several coloured layers at once, one per active player,
and eWalls shows who is on the wall.

What Boardsesh does in the prototype:

- Lights one layer per climber and supports four layers at a time.
- Reads the active players before every change and confirms afterwards.
- Replaces or clears only its own layer.
- Refuses to light a climb with more than 92 distinct diodes, the size of one
  command, instead of cutting it short. See F9.
- Supports the binary protocol only.

What we need to know:

- **F1.** Each command carries a 16-byte user id. Is it the eWalls user id,
  and does the controller or eWalls check it?
- **F2.** What should a Boardsesh climber with no eWalls account present as
  their player identity? We would like a way that does not need an account.
- **F3.** How many layers does the firmware support? We see a "no more users
  accepted" error and would like to know the limit behind it.
- **F4.** Who may clear another player's layer? Commands carry a duration;
  what is the board default, and can a gym change it?
- **F5.** When a Boardsesh climber lights a climb, what should eWalls show to
  its own users on that wall: the climb, the climber's name, a colour only?
  The climb may be a Boardsesh draft that eWalls has never seen.
- **F6.** eWalls sends live lighting activity to its app over a socket. Should
  Boardsesh send its activity there too, and may it listen, so each app shows
  everyone on the wall?
- **F7.** Boardsesh has party sessions: a group shares a queue and takes turns
  on one wall. Should a session appear to eWalls as several players, or as one?
- **F8.** Which firmware and protocol versions are in the field, and is the
  older JSON protocol still in use?
- **F9.** A command holds up to 92 diodes and the eWalls app sends a larger
  climb as several commands. Do repeated commands add to a player's layer or
  replace it?

Section F has the most open questions. A one-hour call with the person who
owns the controller firmware would be faster than writing back and forth.

### G. The public snapshot

- **G1.** May the public Quantum catalogue be included in Boardsesh's
  downloadable snapshot? The three options are in
  [the general proposal](board-manufacturer-sync.md#the-public-snapshot).
- **G2.** If yes, does eWalls want setter names and first-ascent names for
  eWalls-set climbs included, or left out?

## Suggested order

| Step | Needs answers to | Result |
| --- | --- | --- |
| 1 | A1, A2, B1 | Boardsesh reads the catalogue under an agreed credential, on a test environment |
| 2 | Rest of A and B, F1 to F4, F8, F9 | Quantum Board support released in Boardsesh: browse, light, log in Boardsesh |
| 3 | C, D1, D3, D4 | Boardsesh climbs and totals appear in eWalls |
| 4 | E1 to E3, D2 | Linked climbers share one logbook for new ascents |
| 5 | E4 to E8, F5 to F7, G | Past ascents, corrections, lists, live presence across apps, the snapshot |
