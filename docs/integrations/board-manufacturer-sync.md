# Two-way sync with a board manufacturer: proposal

Status: **proposal**. Nothing in this document is built or agreed unless a
section says so. It describes how Boardsesh would like to exchange climbs,
totals and logbooks with the service a board manufacturer runs for its own
app. The first manufacturer is Walltopia, for the Quantum Board; the details
and our questions for Walltopia are in [quantum-ewalls.md](quantum-ewalls.md).

Boardsesh does the syncing. It reads the manufacturer's API on a
schedule to learn what changed there, and it sends its own changes to the
manufacturer's API. Public climbs and their totals appear in both apps for
everyone. A climber who links their two accounts gets one logbook, one set of
favourites and one set of playlists in both apps, and can edit in either. The
manufacturer builds no sync client.

## Contents

1. [Terms](#terms)
2. [What "share everything" means](#what-share-everything-means)
3. [Principles](#principles)
4. [The two tiers](#the-two-tiers)
5. [How data moves](#how-data-moves)
6. [Climbs](#climbs)
7. [Boards and gyms](#boards-and-gyms)
8. [Linking an account](#linking-an-account)
9. [Linked climbers: logbook, favourites, playlists](#linked-climbers-logbook-favourites-playlists)
10. [Edits from both apps](#edits-from-both-apps)
11. [Climbers who have not linked](#climbers-who-have-not-linked)
12. [Totals](#totals)
13. [The public snapshot](#the-public-snapshot)
14. [Sharing one wall](#sharing-one-wall)
15. [Summary per record](#summary-per-record)
16. [Operations](#operations)
17. [Names and trademarks](#names-and-trademarks)
18. [Privacy and data roles](#privacy-and-data-roles)
19. [Phases and who builds what](#phases-and-who-builds-what)
20. [If a manufacturer prefers to pull](#if-a-manufacturer-prefers-to-pull)
21. [What this changes on the Boardsesh side](#what-this-changes-on-the-boardsesh-side)
22. [Open questions](#open-questions)

## Terms

| Term | Meaning here |
| --- | --- |
| Ascent | One logged climb in a logbook. A **send** is an ascent that was completed |
| Totals | The numbers shown on a climb: how many people sent it, its star rating, its grade votes |
| Linked climber | A climber who linked their Boardsesh account to their account with the manufacturer |
| Pull | Boardsesh reads data from the manufacturer's API: everything that changed since the last read |
| Push | Boardsesh writes data to the manufacturer's API: it creates or changes a record |
| Catalogue | All public climbs of a board |
| Setter | The person who created a climb. Their **public name** is the name shown on the climb |
| Playlist | A climber's own named list of climbs |
| Cursor | A bookmark the manufacturer's API returns, so the next pull continues where the last one stopped |
| External id | The id the manufacturer gave a record. Boardsesh stores it next to its own id |
| Boardsesh id | Boardsesh's own id for a record. Sent with every push; storing it is optional for the manufacturer |
| Partner credential | A key issued to Boardsesh as a company, not to a climber |

## What "share everything" means

Both sides want the two apps to share climbs, logbooks and playlists: set a
climb in one app and it shows up in the other.

This document says "the manufacturer" for whoever runs the API. The company
that owns the brand, the one that runs the API and the one that makes the
controller can be different parties, so each annex records who approves what.

Not every Boardsesh climber has an account with the manufacturer, so the
proposal has two layers:

- **For everyone, with no account link:** every public climb and its totals
  appear in both apps. A climb set in Boardsesh shows in the manufacturer's
  app with the setter's public Boardsesh name, and the other way round.
- **For a linked climber:** their logbook, favourites, projects and playlists
  are the same in both apps.

The individual logbook of a climber who has not linked does not cross. Their
sends still count in the totals each climb shows. Their name, dates and
comments stay in Boardsesh.

Boardsesh wants climbers to link. When a climber first uses the
manufacturer's board in Boardsesh, Boardsesh asks them to link their account or create
one. Two-way sync is one of the features our users ask for most, so we expect
most of them to link. Linking stays optional: the prompt can be dismissed and returns only
occasionally, and a climber who never links keeps every feature.

## Principles

1. **The catalogue is factual data that gives the board its value.** The
   climbs set on a board are a large part of what its owner paid for, so they
   should stay available to that owner. Boardsesh publishes the public
   catalogue as a file anyone can download (see
   [The public snapshot](#the-public-snapshot)). The Boardsesh app uses the
   same file to work offline, and serving a file from a CDN costs far less
   than syncing a database to every phone. For a manufacturer's own catalogue
   this is a request and not a condition: what is published follows the
   option the manufacturer chooses there, and agreeing to sync is not
   agreeing to publish.
2. **Only public climbs and totals are open.** Logbooks, accounts, drafts and
   private walls are not.
3. **A logbook belongs to the climber.** The climber decides whether it moves
   between services. Boardsesh also lets every climber export their own data.
4. **No required third account.** Using a board through Boardsesh never
   requires an account with the manufacturer. Boardsesh encourages linking and
   does not enforce it.
5. **Both apps can edit.** A climber should not have to remember which app an
   ascent or a playlist was first made in.
6. **Climbs are not deleted.** A published climb is a fact about a board.
   Moderation can hide it and its setter's name can be removed, and the climb
   itself remains.

## The two tiers

| Tier | Who | What crosses | Direction |
| --- | --- | --- | --- |
| 0. Catalogue | Everyone. No account link | Public climbs with the setter's public name; totals per climb and angle | Both ways |
| 1. Linked | A linked climber | That climber's ascents and attempts, favourites, projects and playlists; climbs they set appear under their own identity in both apps | Both ways |

Not shared, for anyone: logbook rows of climbers who have not linked, in any
form, including anonymised; drafts; private walls; account details.

We considered sending unlinked climbers' logbooks with the names removed, and
rejected it. A row with a timestamp, a climb and a board at a known gym can
identify a person even without a name. It is still personal data and needs the same
consent and deletion handling as a named row. The totals in tier 0 give both
apps what they need from those climbers.

We also considered requiring an account with the manufacturer before a climber
can use the board in Boardsesh. That contradicts principle 4.

## How data moves

| Direction | Whose data | How | When |
| --- | --- | --- | --- |
| Manufacturer to Boardsesh | Public catalogue; boards and gyms | Boardsesh pulls with the partner credential (a test account at first) | On a schedule (we suggest every six hours) |
| Manufacturer to Boardsesh | A linked climber's logbook, favourites, playlists | Boardsesh pulls with that climber's token | When the climber opens Boardsesh, and on the schedule |
| Boardsesh to manufacturer | A linked climber's changes | Boardsesh pushes with that climber's token | At once |
| Boardsesh to manufacturer | Public climbs of climbers who have not linked; Boardsesh's totals | Boardsesh pushes with the partner credential | Climbs on the schedule, totals once a day |

![Boardsesh's backend and scheduled job make every call to the manufacturer's API: they pull the public catalogue and linked climbers' logbooks, push a linked climber's changes at once and the public climbs and totals of climbers who have not linked on the schedule, and publish the public snapshot file to a CDN](diagrams/sync-overview.svg)

### Pushing

![A record saved in Boardsesh with no external id is pushed to the manufacturer, and each answer leads to a different state: success stores the external id, an unreachable manufacturer leaves it for the scheduled job, a rejection marks it not synced until the climber fixes it, and no answer is repeated at once if the manufacturer stores the Boardsesh id, or else waits until a later pull shows it or the timeout passes](diagrams/push-lifecycle.svg)

1. A record made in Boardsesh is saved with no external id.
2. Boardsesh pushes it. The push carries Boardsesh's own id for the record.
   On success the manufacturer returns its id, and Boardsesh stores it as the
   external id.
3. If the manufacturer could not be reached, the record stays saved and the
   scheduled job pushes it later.
4. A create can succeed and its answer be lost on the way back. What Boardsesh
   does next depends on whether the manufacturer stores the Boardsesh id (see
   below).
5. If the manufacturer rejects the record as invalid, Boardsesh shows the
   climber the reason and asks them to fix it, then pushes the fixed record.
   See [Publishing a climb](#publishing-a-climb).

#### The Boardsesh id on a push (optional for the manufacturer)

Every push carries Boardsesh's id for the record. We ask the manufacturer to
store it, refuse a second create that carries an id it already has, and return
it with the record in its changes. This is optional. With it:

- A create with no answer can be repeated at once and cannot make a second
  record.
- A record that comes back in a pull carrying a Boardsesh id is matched
  exactly, with no comparing of holds or dates.
- The manufacturer can tell which records came from Boardsesh.

Without it the sync still works. A create with no answer is then not repeated
automatically. It stays "waiting" until a later pull shows the record, or
shows after the manufacturer's stated timeout that it was never made, and only
then is it pushed again. Records are matched by their content, as described
under [Climbs](#climbs) and
[Linked climbers](#linked-climbers-logbook-favourites-playlists).

Either way Boardsesh keeps the table that pairs its id with the manufacturer's
id, so the manufacturer never needs to look one up.

### Pulling

Boardsesh reads what changed since its last cursor. A record whose external
id Boardsesh already holds is an update to something it knows. Anything else
is new and is matched as described under [Climbs](#climbs) and
[Linked climbers](#linked-climbers-logbook-favourites-playlists).

An edit made in the manufacturer's app reaches Boardsesh at the next pull.
Pulling when a climber opens Boardsesh covers the case they would notice.

### Does the manufacturer need to push to Boardsesh?

No. The scheduled pull is enough. If the manufacturer would like its changes
to arrive in Boardsesh sooner, Boardsesh is happy to accept pushes, or a short
"something changed for this climber" message that makes Boardsesh pull at
once. Neither is needed to start.

### Why Boardsesh pushes, and the manufacturer does not pull from us

- A push gets an answer straight away, so a problem with a climb reaches the
  climber while they are still looking at it.
- Only one side has to keep the table of paired ids.
- A push can check what the other side holds before changing it, which makes
  edits from both apps safe.
- The manufacturer builds no sync client and runs no scheduled job.

This model needs write access to the manufacturer's API. A manufacturer that
would rather read from Boardsesh can do that:
see [If a manufacturer prefers to pull](#if-a-manufacturer-prefers-to-pull).

## Climbs

### What makes two climbs the same climb

Two published climbs on the same board layout are the same climb when they
use the same holds, each in the same role (start, hand, foot, finish), under
the same rules (for example "no matching"). The angle is not part of it: these boards
are adjustable and one climb is climbed at several angles. The name is not
part of it either.

Boardsesh already applies this rule to its own catalogue: it refuses a new
climb that matches a published one on the same layout, at any angle.

When a pull delivers a climb that is the same as one Boardsesh already has,
Boardsesh merges them:

![Three climbs with the same lit holds, two set in the manufacturer's app at 25 and 40 degrees and one set in Boardsesh, are stored in Boardsesh as three source climbs with their own ids, setters and ascents, and shown as one climb named after the one published first, while the manufacturer keeps its two climbs separate](diagrams/same-climb-merge.svg)

- Climbers browsing Boardsesh see one climb. It shows the name, setter and
  grade of the one that was published first, whichever app it came from.
- Anything the manufacturer curates stays with its own source climb: an
  official grade, a benchmark mark, whether it counts for a ranking. Matching
  holds do not pass any of that to another source climb, and community votes
  never replace a curated grade. Boardsesh shows the community's grade next
  to it.
- This is a display rule only. Underneath, Boardsesh keeps every source
  climb with its own id, setter, publication date and editing rights. A
  setter editing their climb never changes another setter's climb.
- Each ascent remembers which source climb it was logged on. An ascent
  logged in Boardsesh goes to the source climb set at the angle climbed, or
  to the earliest one when no angle matches.
- Ascents and totals logged against any of them are shown on the one climb.
- A linked climber's ascent is pushed to the manufacturer's climb at the
  angle they climbed, or to the earliest one when no angle matches.
- Boardsesh's totals for an angle go to the same manufacturer climb that
  ascents at that angle go to.
- If one of them is edited later so that the holds differ, Boardsesh shows
  them as separate climbs again, each with its own ascents.

One Boardsesh climb can therefore match several of the manufacturer's climbs:
the same holds set once at 25 degrees and once at 40, or set twice by two
people. The manufacturer does not have to merge anything on its side.

### Publishing a climb

Publishing a climb cannot be undone, so Boardsesh checks first:

1. Publishing needs a connection to Boardsesh. A climb made offline is kept
   as a draft until the phone is online. This is a Boardsesh rule for all
   boards and does not depend on the manufacturer: if the manufacturer's API
   is down, the climb is published in Boardsesh and waits to be pushed.
2. Boardsesh checks the manufacturer's rules itself before saving (hold
   count, start and finish holds, name length, allowed angles), so most
   problems are caught on the screen.
3. Boardsesh saves the climb and pushes it.
4. If the manufacturer still rejects it, Boardsesh shows the climber the
   reason and asks them to fix it. Until they do, the climb is marked "not
   synced" in Boardsesh.

### Other rules

1. **A published climb stays published.** This and the next rule are
   Boardsesh's own policies; the sync does not require them of the
   manufacturer. In Boardsesh a climb has no audience setting: once published and listed it is public to everyone,
   whoever set it ([privacy.md](../product/privacy.md)).
2. **Deleting a Boardsesh account does not delete climbs.** If the climber
   chooses to remove their name, the setter becomes "Unknown", and Boardsesh
   pushes that change.
3. **If the manufacturer removes a climb,** Boardsesh stops listing it and
   keeps the ascents already logged on it. Boardsesh does not create it
   again.
   - In a merged climb only that source is removed. The others stay listed,
     and the name and setter shown move to the earliest one left.
   - The removed source's totals and any official status it carried are no
     longer shown. Its ascents stay in the logbooks of the climbers who
     logged them.
   - The merged climb disappears from browsing only when every source is
     removed, or when Boardsesh's own moderation hides it.
   - Boardsesh remembers the removal. A later pull, a retry, or another
     source with the same holds does not bring the removed one back. Only
     the side that removed it can restore it.
4. **Hold ids never change meaning.** A climb's holds refer to physical LEDs.
   A change to what an id means is a new board layout, announced ahead of
   time.

## Boards and gyms

Boardsesh ties as much as it can to the physical board: each ascent, each
session, who is on the wall, and a gym's page with its boards. So besides
climbs, Boardsesh would like to pull the manufacturer's list of installed
boards and the gyms they are in, where the manufacturer has that data.

- For each board: a stable id, the model and size, the name it advertises
  over Bluetooth or its serial number, the angle range, and whether it is in
  a public venue or a private home.
- For each public venue: its name and location, and which boards it has.
- On an ascent: which board it was logged on, in both directions.

Boardsesh already keeps a directory of gyms and boards. A board or gym that
arrives from the manufacturer is matched to an existing entry, or added.
Boards in private homes are not listed publicly.

## Linking an account

Climbers sign in on the manufacturer's own page. Boardsesh stores the
resulting token and makes every call, so the manufacturer does not need to
call Boardsesh.

### Preferred: a standard OAuth 2.0 sign-in

- Authorization code flow with PKCE. Boardsesh opens the manufacturer's
  sign-in page in the system browser. The climber never types their
  manufacturer password into Boardsesh.
- **The same page offers "create an account".** That is how a climber creates
  a manufacturer account from inside Boardsesh: we open the page, they sign
  up with the manufacturer and return linked. The manufacturer controls its
  own sign-up page.
- Scopes that name what Boardsesh may do: read and write the logbook, read
  and write favourites and playlists, set and edit climbs.
- A refresh token, so sync continues while the app is closed, and a way to
  revoke it from either side.

### Not for climbers: the manufacturer's existing login

Typing a manufacturer password into Boardsesh would let Boardsesh do anything
that password allows, with no way to limit it or to take back Boardsesh's
access alone. Boardsesh will not link climbers' accounts that way. Linked
accounts are switched on only once there is a sign-in that gives Boardsesh a
token limited to the scopes above, which the climber or the manufacturer can
revoke on its own: authorization code with PKCE (S256).

The existing login is used for one thing only: the test accounts in phase 1,
which hold no real climber's data.

### What the climber is told when linking

One screen, before anything moves:

- What is synced: their ascents, attempts, grades, ratings, comments,
  favourites, projects and playlists, in both directions, including past
  ones.
- What is not: drafts, sessions, followers, anything about other climbers.
- Who can see a record in each app after syncing, in both directions. The
  climber chooses on this screen whether records they marked "Only me" in
  Boardsesh are synced too. Records that are private in the manufacturer's
  app arrive in Boardsesh as "Only me".
- Boardsesh will keep reading their manufacturer account in the background.
- After copying, each service keeps its copy under its own privacy policy.
- They can unlink at any time.

### Who can see a synced record

The two apps may not have the same privacy settings. Boardsesh has public and
private accounts, and each ascent or playlist can be Public, Followers or
Only me. The rule for the sync, in both directions and for ascents and
playlists alike:

**A record is never more visible in the other app than the climber made it in
the app they made it in.**

- Where the other app has a matching or stricter setting, the record gets
  that setting.
- Where it has none (for example every logbook there is public), the link
  screen says so, and records that are not public are synced only if the
  climber agrees.
- A record that arrives from the manufacturer as private becomes "Only me"
  in Boardsesh. So does one whose visibility Boardsesh cannot tell.
- Boardsesh never widens an imported record on its own. A public Boardsesh
  account does not make an imported private ascent public. The climber can
  change it afterwards, one record at a time or for the whole import.
- Visibility is separate from totals. In Boardsesh a private account and an
  "Only me" ascent still count in a climb's totals, as numbers with no name.
  We need to know whether the manufacturer's private ascents count in its
  totals in the same way.

### Unlinking

Boardsesh revokes and deletes the token. Pulls and pushes stop. Copies already
made stay where they are, as the link screen said. A climber who wants a copy
gone deletes it in that app.

If a token expires and cannot be renewed, sync pauses and Boardsesh asks the
climber to link again.

## Linked climbers: logbook, favourites, playlists

All of this is one piece of work on the Boardsesh side. Each kind of record
is switched on separately once it has been tested against the manufacturer's
API, so a gap in one (for example playlist order) does not hold back the
logbook.

| Record | Boardsesh pushes | Boardsesh pulls |
| --- | --- | --- |
| Ascents and attempts | Create, edit, delete | The climber's ascents, with deletions |
| Favourites and projects | Add, remove | Added and removed |
| Playlists | Create, rename, delete, add and remove climbs, reorder | The same |
| Climbs they set | Create, edit | Their climbs, like any public climb |

### Matching ascents

- An ascent Boardsesh pushed is known by the id the manufacturer returned.
- An ascent that arrives in a pull with no known id is matched by its data:
  the climber, the climb, the angle and the time it was climbed. This is
  mainly for the first sync after linking, when both apps hold some of the
  same climbing, logged twice by hand. Ascents that do not match stay as
  separate ascents.
- That only works if an ascent keeps the time it was climbed and its angle.
  An ascent pushed days later must still carry the day it happened.
- Ascents of other climbers that arrive in a linked climber's pull are
  discarded.
- A pulled ascent that matches one already in Boardsesh keeps the audience
  the climber gave it. A new one is never more visible in Boardsesh than it
  was in the manufacturer's app; see
  [Who can see a synced record](#who-can-see-a-synced-record).

### Deletions

When a climber deletes an ascent or a playlist in Boardsesh, Boardsesh pushes
the deletion. It also remembers it, so that if the manufacturer cannot delete
the record, the next pull does not bring it back. A deletion always wins over
an edit made in the other app (see
[Edits from both apps](#edits-from-both-apps)).

Three things a climber can do, and what each means:

| The climber | In Boardsesh | In the manufacturer's app |
| --- | --- | --- |
| Unlinks | Records stay | Records stay. Sync stops |
| Deletes a record in one app while linked | Deleted | Deleted, through the sync |
| Deletes their account in one service | Handled by that service | Not touched; the climber deletes there too if they want |

### What the manufacturer's API needs for this

| Need | Why |
| --- | --- |
| The permanent id of a created record in the response | Boardsesh stores it as the external id |
| The time of the climb, with timezone, accepted on an ascent and returned unchanged | History, and sends logged offline |
| The angle on an ascent | Totals are per angle |
| A read of one climber's whole logbook | The first sync after linking |
| An "updated at" time on each record | To tell which edit is newer |
| Delete for an ascent | A climber removes a mistake in one app and expects it gone in the other |
| A rate limit and a retry rule | Boardsesh follows the stated rule |

## Edits from both apps

A climber can edit an ascent or a playlist in either app.

![One ascent as three copies (last agreed, Boardsesh now, manufacturer now) in three cases: different fields changed, so both changes are kept; the same field changed, so Boardsesh keeps both values and asks the climber; an edit against a delete, so the delete stays until the climber restores it; below, a pushed edit names the version it changes and the manufacturer refuses it if the record changed since](diagrams/edits-from-both-apps.svg)

Boardsesh keeps, for every synced record, the copy both sides last agreed
on. When the two apps have both changed a record, it compares each side with
that copy:

- Changes to different fields are both kept. A new comment in one app and a
  new rating in the other end up on the same ascent.
- Changes to the same field cannot both be kept. Boardsesh keeps both values
  and asks the climber which one is right. It does not pick by clock time,
  because a phone with a wrong clock would let an old edit replace a new one.
- An edit in one app and a delete in the other: the delete stays. A climber
  who deletes an ascent, perhaps because of what its comment says, must not
  see it come back because of an unrelated edit elsewhere. Boardsesh pushes
  the deletion, drops any push still waiting for that record, and deletes
  its own kept copies of it. The climber can log the ascent again.
- Until the climber has chosen between two values, each app keeps showing
  its own and nothing is pushed for that field.
- Favourites, projects and the climbs in a playlist are merged one add or
  remove at a time. A favourite added in one app and a different one added
  in the other both survive.
- The order of a playlist follows the app where it was reordered last, if
  the manufacturer stores an order. If it does not, the order stays in
  Boardsesh only.

For this to be safe, a push of an edit states which version of the record it
is changing (a version number, or the "updated at" Boardsesh last saw), and
the manufacturer refuses it if the record has changed since. Where the API
cannot do that for a kind of record, Boardsesh does not push edits to that
kind of record. The climber sees that the edit is saved in Boardsesh and not
synced. Creating and deleting still work.

## Climbers who have not linked

Their public climbs and their share of the totals still cross. This part
needs new features in the manufacturer's API.

- Boardsesh pushes each of their published climbs with its partner
  credential. The setter shown is the climber's public Boardsesh name, sent
  as text. No manufacturer account is created for them, and nothing else
  about them is sent.
- The scheduled job does this, so a rejected climb is reported to the setter
  after the job's next run, not at the moment they publish.
- When that climber links later, their climbs move to their manufacturer
  account and they can edit them in both apps.
- Before their first publish on a synced board, Boardsesh tells the climber
  that the climb and their name will also appear in the manufacturer's app.

What this needs on the manufacturer's side:

1. A partner credential that may create and edit climbs.
2. A setter name stored as text on a climb, for a setter with no account.
3. A way to move a climb to its setter's account when they link.
4. Somewhere to receive Boardsesh's totals (next section).

## Totals

Every climb shows totals: how many people sent it, how they graded it, how
they rated it. Both apps should show the same numbers, and nobody's send
should be counted twice.

Totals are kept per climb **and angle**. A new climb has no totals at any
angle. Once it is sent at 40 degrees it has totals for 40 degrees and still
none for 45.

### The rule

**Boardsesh counts an ascent until it sees that ascent in a pull from the
manufacturer. From then on the manufacturer counts it.**

The two apps reach the same numbers within about a day. They are not exact at
every moment, and we do not think they need to be: a reliable personal
logbook matters more than two counters that agree to the minute.

- A linked climber's ascent is pushed, and Boardsesh keeps counting it until
  a later pull returns it.
- An unlinked climber's ascents are never pushed, so Boardsesh counts them.
- An ascent whose push is still waiting is counted by Boardsesh.
- After a climber unlinks, ascents already pushed stay counted by the
  manufacturer only.

Each app shows the manufacturer's totals plus Boardsesh's totals.

### What Boardsesh pushes

Per climb and angle, once a day, as the full current values. Each push
replaces the previous values, so a missed day corrects itself:

| Field | Meaning |
| --- | --- |
| `senders` | Distinct Boardsesh climbers with at least one counted send |
| `ratingSum`, `ratingCount` | Sum and number of star ratings on counted ascents, on a stated scale. Each climber counts once, with their latest rating. Left out below 5 ratings |
| `gradeVotes` | Number of their grade votes per grade. Left out below 5 votes |

Sums and counts are sent because they can be added exactly:
`(sumA + sumB) / (countA + countB)` is the true combined average.

### Worked example

One climb at 40 degrees:

| | Manufacturer | Boardsesh | Shown in both apps |
| --- | ---: | ---: | ---: |
| Senders | 41 | 11 | 52 |
| Rating sum / count | 156 / 39 | 46 / 10 | 202 / 49 = 4.1 stars |
| Votes for 6C+ | 22 | 6 | 28 |

An example climber, Ana, has linked her accounts and logged her send in
Boardsesh. Her ascent was pushed to the manufacturer, so she is one of the 41
and not one of the 11.

![Two climbers send one climb at 40 degrees: Ana is linked, so her send is pushed at once, stays in Boardsesh's count until a later pull returns it, and then moves to the manufacturer's count, while the send of a climber who has not linked is never pushed and stays in Boardsesh's count; 41 manufacturer senders plus 11 Boardsesh senders give the 52 that both apps show](diagrams/totals-counting.svg)

### What this needs on the manufacturer's side

- An endpoint that accepts Boardsesh's totals for a climb and angle.
- **Boardsesh's totals kept apart from the manufacturer's own.** The
  manufacturer's API keeps returning its own totals unchanged, and its app
  shows the two added together. If the two were stored as one number,
  Boardsesh would read back its own contribution at the next pull and add it
  again.

### Limits

- People or ascents. Boardsesh counts distinct people, so repeats by one
  climber do not inflate a climb. If the manufacturer counts logged ascents,
  the two numbers measure different things. They are then shown as two
  numbers and not added, until both sides count the same thing. We propose
  counting people.
- One person in both apps, unlinked, is counted twice. Neither side can
  know they are the same person. Linking fixes it for that climber.
- A day's delay. The climber's logbook pull, the catalogue pull and the
  daily totals push run at different times. While an ascent moves from
  Boardsesh's count to the manufacturer's it can be counted twice, or not at
  all, for up to a day. The next daily push corrects it.
- Merged climbs. When one Boardsesh climb covers several of the
  manufacturer's climbs, their sender counts are added. A person who sent two
  of them at the same angle is counted twice, and can have two ratings. A way
  to ask the manufacturer for distinct senders across several climbs would
  remove this.
- Grades. The grade a setter or the manufacturer gave a climb stays as it is.
  The grade from the combined votes is shown as the community's grade, next
  to it. Each app decides which of the two it shows first.
- Small numbers. Pushing once a day does not make a number anonymous. A
  rating count of 1 is one person's rating, and comparing two days can show
  one new rating even on a popular climb. So:
  - Ratings and grade votes for a climb and angle are left out until at
    least 5 climbers have given one, and are then sent in steps of 5, so a
    single new rating does not show.
  - The sender count is sent as it is. Boardsesh already shows it publicly
    on every climb, with no name.
  - Totals carry no first-ascent name or time.
  - Before this is switched on, the two sides look at everything that is
    shared together (totals, who is on the wall, public climbs), because
    numbers that are harmless alone can identify someone in combination.

## The public snapshot

Boardsesh publishes each board's public catalogue as a SQLite file on a CDN,
rebuilt nightly, free to download with no account
([board-snapshots-dataset.md](../data/board-snapshots-dataset.md)). It holds
climbs, their holds, grades and totals, the setter's name, and the name and
date of the first ascent where the catalogue has one. It holds no accounts and
no logbooks. Today it covers the published climbs of imported catalogues;
climbs set in Boardsesh are due to join it.

The Boardsesh app loads the same file to work offline. It is also what makes
principle 1 true in practice: if Boardsesh shuts down, or a manufacturer
retires an app, the climbs on a board someone bought are still available.

**Our request.** We would like the public catalogue of the manufacturer's board,
with climbs from both apps and with setter and first-ascent names, to be part
of that snapshot. This is the manufacturer's decision, because a published
file cannot be recalled once someone has downloaded it.

The options, in the order we prefer them:

1. The full public catalogue for the board, with climbs from both services.
2. Climbs set in Boardsesh only. The manufacturer's climbs reach Boardsesh
   apps through the sync and are not republished.
3. Not now. The board is left out of the snapshot and we revisit it later.

The sync works the same under all three. Under 2 and 3 the Boardsesh app
needs another way to hold the board's catalogue offline.

**Terms.** Boardsesh's position ([LEGAL.md](../../LEGAL.md)) is that climbs
and grades are facts and that no manufacturer owns the community's climb
data. That position is argued under U.S. law, and EU database law may read
differently. We therefore do not propose a copyright licence. The snapshot
asks two things of anyone who uses it: credit setters where a climb is shown,
and do not present the data as an official manufacturer source. If the
manufacturer wants more than that written down, a short agreement between the
two companies would be the right document.

## Sharing one wall

Two apps can be connected to the same board at the same time, and some boards
let several climbers light their climbs at once in different colours.

Boardsesh follows four rules so that it does not disturb other players:

- It reads who is on the wall before it lights anything.
- It only changes or clears the layer it lit itself.
- It never clears the wall to make room.
- A phone that reconnects does not assume it still owns its old layer.

A Boardsesh session, where a group shares a queue and takes turns, is one
player on the wall. The session lights one climb at a time, whoever in the
group is climbing.

Boardsesh has a board presence feature that shows who is on a board and what
is lit. For a manufacturer with a live feed of board activity, the Boardsesh
backend can subscribe to that feed and show the manufacturer's climbers in the
same place.

Presence says where a person is right now, so it is handled apart from the
sync and has its own rules:

- To share the wall, the two apps need only an anonymous player id that lasts
  as long as the layer does. That is the default.
- A climber's name goes to the other app only if their own privacy settings
  allow it. Boardsesh already has these settings (a private account, and
  "anonymous on boards I don't own"), and they apply to what Boardsesh sends
  as well as to what it shows.
- The holds of a climb that is not published are not sent to the other
  service. Everyone at the wall can see them lit; nobody else needs them.
- Presence is not stored by the receiving side beyond the time the climber
  is on the wall.

What has to be agreed per board is in the manufacturer's annex.

## Summary per record

| Record | Identity | Who may edit | Both sides changed it | Delete | Privacy |
| --- | --- | --- | --- | --- | --- |
| Climb | Boardsesh id plus the manufacturer's id (the manufacturer may store the Boardsesh id too). Same-climb matches are shown as one and stored separately | Its setter, in either app once linked. Before that, in the app it was set in | Field by field against the last agreed copy | Never deleted. Either app can hide it from its own users | Public. Setter's public name only |
| Ascent | Boardsesh id plus the manufacturer's id; matched by its data when it has no id yet | The climber, in either app | Field by field; same field asks the climber; a delete beats an edit | Pushed, and remembered so it does not come back | Linked climbers only. "Only me" ascents by the climber's choice |
| Favourite, project | Climber plus climb | The climber | Merged one add or remove at a time | Remove is pushed | Linked climbers only |
| Playlist | Boardsesh id plus the manufacturer's id | The climber | Name: field by field. Climbs in it: merged one at a time. Order: last reorder | Pushed, and remembered | Linked climbers only. Never more visible than the climber made it |
| Totals | Climb plus angle | Nobody; each side computes its own | Not applicable; Boardsesh's are replaced daily | Not applicable | Counts only, with the limits above |
| Board, gym | The manufacturer's id, matched to Boardsesh's directory | The manufacturer | The manufacturer's value | Follows the manufacturer | Public venues only |

## Operations

- Moderation. Each company moderates its own app. The manufacturer may hide
  or remove any climb Boardsesh wrote, and Boardsesh will not write it again.
  Boardsesh removes abuse on its side and answers the manufacturer's reports
  about climbs that came from Boardsesh.
- Limits. Boardsesh keeps to the rate limits the manufacturer states, and
  limits how many climbs one setter can publish in a day.
- Scope. The partner credential covers the agreed boards and the agreed
  operations (read the catalogue, write climbs, write totals) and nothing
  else. The manufacturer can withdraw one operation without the others.
- Support. Before writes are switched on, the two sides agree a contact for
  incidents, how much notice an API change gets, the request volume to expect,
  and who looks into each kind of failure. Either side can pause one kind of
  record (for example playlists) without stopping the rest.

### When the connection stops

| | Outage (the API cannot be reached) | Suspended (access paused by either side) | Ended (the agreement stops) |
| --- | --- | --- | --- |
| Pushes waiting in Boardsesh | Kept, sent when the API is back | Kept; sent after access returns only if the manufacturer agrees, otherwise dropped | Dropped |
| Pulls | Resume from the last cursor | Stop | Stop |
| Records already copied | Stay in both services | Stay in both services | Stay in both services, each under its own policy |
| The board in Boardsesh | Works as normal | Works; climbers see that sync is paused | Works from the catalogue Boardsesh already holds, with no new climbs from the manufacturer |
| Public snapshot | Unchanged | No new builds for that board | No new builds; whether the last one stays published is part of ending the agreement |
| Tokens and credentials | Kept | Kept, unused | Deleted |
| What climbers see | Nothing, unless it lasts | "Sync paused" on linked accounts | "No longer syncing"; their account is unlinked |
| Names and logos | Unchanged | Unchanged | Removed, back to the wording used for any other board |

After access ends, an account deletion or a name removal in one service can no
longer reach the other through the sync. Each company then handles such
requests for the data it holds, and the two agree a contact for passing them
on.

## Names and trademarks

These are proposed terms, for the manufacturer to confirm in writing. Until
then Boardsesh describes the board as it describes every other: a board it
works with, with no claim of a relationship.

- Boardsesh may name the manufacturer and its board in the app and on the
  website to describe the integration, for example "Works with Quantum
  Board" and "Syncs with eWalls", and may show the manufacturer's logo next to that
  statement if the manufacturer supplies one.
- The manufacturer may do the same with the Boardsesh name and logo.
- Boardsesh stays an independent app and does not present itself as the
  manufacturer's app.
- **The permission covers the Boardsesh apps and website that Boardsesh
  publishes. It does not pass to forks.** Boardsesh's code is open source and
  anyone may run their own copy. A copy gets neither the manufacturer's names
  nor the partner credential.

## Privacy and data roles

- **Two independent services.** Each company decides for itself why and how
  it processes the data it holds. Neither processes data on the other's
  behalf. For linked climbers, each receives a copy at the climber's request.
- **Tier 0 carries one piece of personal data:** a setter's public name on a
  climb they chose to publish. In Boardsesh that name is already public on
  the climb. The manufacturer's app is a new place for it to appear, so
  Boardsesh tells the setter before their first publish and says so in its
  privacy policy.
- **Tier 0 totals are counts,** with the limits under [Limits](#limits).
- **A private Boardsesh account** hides that climber's activity. It does not
  hide climbs they published. Its sends still count in totals, as numbers
  with no name, whether or not the climber has linked.
- **Deleting a Boardsesh account** removes the account's link to its climbs
  and sets the setter name to "Unknown" if the climber chooses that. The
  climbs stay. Snapshot files downloaded earlier keep the old name.
- **Deleting an account with the manufacturer.** Boardsesh needs to learn of
  it, to stop syncing and to apply the same rule to that climber's climbs.
- **Tokens** are stored encrypted on the Boardsesh backend and never reach a
  phone.
- **Age.** Each service applies its own minimum age to its own accounts.
- **A written agreement before real climbers' data moves.** Permission to use
  an API is not the same as an agreement about personal data. Before phase 2
  the two companies sign a short data-sharing agreement: the purposes, the
  list of fields, how long each side keeps them, who handles deletion
  requests, incident contacts, and whether setter and first-ascent names may
  be published in the snapshot.

## Phases and who builds what

| Phase | Climbers get | Manufacturer provides | Boardsesh builds |
| --- | --- | --- | --- |
| 1. Read | The manufacturer's public climbs and totals in Boardsesh, on the right board in the right gym | Test user accounts; permission to read the catalogue and the list of boards and gyms | The importer and board support |
| 2. Linked accounts | One logbook, favourites, projects and playlists in both apps, with edits from both; climbs a linked climber sets appear in both | A scoped, revocable sign-in for linking (OAuth with PKCE); a data-sharing agreement; the API needs listed under [Linked climbers](#what-the-manufacturers-api-needs-for-this) | Link and sign-up prompt; pull and push; matching; merging edits |
| 3. Everyone else | Climbs set by unlinked climbers, and their share of the totals, in the manufacturer's app | The four items under [Climbers who have not linked](#climbers-who-have-not-linked) | The scheduled push of climbs and totals |

Phase 1 needs only test accounts and permission to read the catalogue. Phase
2 builds on what the manufacturer's own app already calls and may need a few
new fields or endpoints. Phase 3 is the only one that needs a credential that
acts for no climber, which is why it comes last.

## If a manufacturer prefers to pull

Some manufacturers will not want another company writing to their API.
Boardsesh expects to support that as well. It would offer two read-only feeds
on `api.boardsesh.com`, with the cursor rules of the logbook feed that already
exists ([partner-api.md](partner-api.md), "Syncing"): public climbs set in
Boardsesh on that manufacturer's boards, and Boardsesh's totals. The
manufacturer runs the job that reads them and stores Boardsesh's id on each
climb it copies. Linked logbooks would use the Boardsesh OAuth API for partner
apps, which reads a logbook today and would need write, favourites and
playlist scopes added.

Pulling costs the manufacturer more work and makes edits from both apps
harder, which is why this proposal leads with push.

## What this changes on the Boardsesh side

These are recorded decisions and behaviours this proposal would change. None
has changed yet.

| Today | Under this proposal |
| --- | --- |
| Boardsesh ascents are not sent to a manufacturer, so its own totals and the manufacturer's add up. An ascent pulled from a manufacturer counts only in that manufacturer's totals | A linked climber's ascents are pushed, and Boardsesh counts one until a pull returns it |
| A climb set in Boardsesh takes its totals from Boardsesh ascents alone | A synced climb also takes the manufacturer's totals |
| A new climb that duplicates a published one is refused | A duplicate that arrives from a manufacturer is merged, earliest published first |
| Publishing a climb needs a connection on every board except spray walls, where it can be done offline | Publishing a climb as public needs a connection on every board (decided 2026-11-25, not built) |
| The snapshot holds imported climbs only, never one a Boardsesh account set ([board-snapshots-dataset.md](../data/board-snapshots-dataset.md)) | Published climbs set in Boardsesh go into the snapshot, and stay (decided 2026-11-25, not built) |
| Removing the setter name on account deletion clears it | It becomes "Unknown" (decided 2026-11-25, not built) |
| Every manufacturer is described as unaffiliated ([LEGAL.md](../../LEGAL.md)) | A manufacturer that confirms the terms under [Names and trademarks](#names-and-trademarks) is named as an integration partner |
| Only if a manufacturer pulls: the partner API has no catalogue endpoints and no tokens without a climber ([integration-platform.md](integration-platform.md)) | Two catalogue feeds and a system credential, for that manufacturer's boards only |

## Open questions

For Boardsesh:

1. The minimum vote count before grade votes are pushed. Proposed: 5.
2. How often the link prompt returns for a climber who dismissed it.
3. LEGAL.md says Boardsesh is not affiliated with any board manufacturer, and
   offers to remove a climb at its creator's request. Both need new wording
   once a manufacturer confirms: a paragraph on integration partners, and the
   rule that a published climb stays.

For each manufacturer, the list is in its annex. For the Quantum Board:
[quantum-ewalls.md](quantum-ewalls.md).

## Editing the diagrams

The `.excalidraw` files in `docs/integrations/diagrams/` are the sources. Open
one at [excalidraw.com](https://excalidraw.com), edit it, then export an SVG
with the same base name, replacing the old one.
