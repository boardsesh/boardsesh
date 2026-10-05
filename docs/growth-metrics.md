# Growth metrics contract

Which PostHog events and filters the growth dashboards count, and why. Project
412845. Written for #5653. The live insights are configured in PostHog; this
file says what they are supposed to count, so a tile can be checked against it.

Every figure here is a count of PostHog people. It is not a count of verified
humans or store installs.

## Populations

A PostHog event says who sent it through two properties: `$lib` (which SDK) and
`environment` (which build). Neither one is enough alone. `environment =
production` covers native, www and backend events at once, and one www event
(`Climb Handoff Clicked`) sets `environment = production-web` by hand. So every
population filters on both.

| Population         | Filter                                                           | Notes                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Native production  | `$lib = posthog-react-native` AND `environment = production`      | iOS and Android store and TestFlight binaries. Split by `$os`.                                                                          |
| Browser app        | `$lib = posthog-react-native` AND `environment = production-web`  | The Expo app at `/app` (`production-deploy.yml` bakes the tag in).                                                                      |
| Preview            | `environment = preview`                                           | `pr-*` OTA bundles (`mobile-ota-preview.yml`). www previews send nothing: the web client only starts on a production host.            |
| Legacy binaries    | `$lib = posthog-react-native` AND `environment` is not set        | Real climbers on store binaries built before 2026-07-25 (2.0.0, 2.1.0, early 2.2.2). They can't take OTAs since the V2 OTA server went away on 2026-08-25, so they stay untagged. Label them; don't fold them into production. |
| www                | `$lib = js`                                                       | Marketing, public climb pages, auth, account. Split by `$pathname` (below).                                                             |
| Backend            | `$lib = posthog-node`                                             | Server-side events. Only a production backend sends (`packages/backend/src/services/analytics/posthog.ts`).                             |
| Internal and test  | cohort 295337                                                     | Exclude it explicitly. `filterTestAccounts` covers typed insights only; a SQL tile needs its own `person_id NOT IN COHORT 295337`.      |

The internal cohort held one person at the 2026-09-20 audit. Excluding it does
not prove every test identity is excluded.

### www page groups

Locale prefixes (`/es`, `/fr`, `/de`) come first where present; strip them
before grouping.

| Group        | `$pathname`                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------- |
| Marketing    | `/`, `/about`, `/gym/*`, `/gyms`, `/help/*`, `/docs/*`, `/legal`, `/privacy`, `/support`        |
| Climb pages  | `/b/*` and `/<board>/<layout>/<size>/<sets>/<angle>/…` (`list`, `view`, `play`), plus `/setter/*`, `/playlists/*`, `/profile/*` |
| Auth         | `/auth/*`, `/join/*`                                                                           |
| Other        | anything else (`/settings`, `/session/*`, `/kiosk/*`, …); `/admin` and `/embed/*` send nothing |

## Bot and crawler traffic

- **Before 2026-09-11, www person counts are mostly Applebot.** It renders our
  JavaScript and minted a new person per page load: 917 of 946 www "users" on
  2026-09-10. #5388 stopped known crawlers booting the client on 2026-09-11.
  Treat www people before that date as unreliable.
- **`$virt_is_bot` is wrong for every www event before the #5653 fix deploys.**
  PostHog reads the bot flag from the `$raw_user_agent` event property.
  posthog-js-lite never sends it, and the proxy's forwarded header (#3139) does
  not fill it. Result: 0 of about 660k www events carried a UA over the 120
  days to 2026-09-25, and every one was flagged a bot. From the fix's deploy
  date, www registers the browser UA as a super property. Do not filter www on
  `$virt_is_bot` for dates before that.
- **Native events send the constant `Boardsesh Mobile`.** The browser app now
  sends the real browser UA (`analytics-user-agent.web.ts`), from the same
  deploy, and no UA at all when the browser reports none, so PostHog flags it.
  About 12 Android people a week are still flagged bots by PostHog despite the
  UA, probably Play pre-launch test devices.

### The www crawler rule

`$virt_is_bot` does not catch the crawlers that make up most of www. From
2026-09-26 to 2026-10-04 www sent 2,418 pageviews from 1,663 people. The flag
was true on 2 of them, and this rule removes 1,389. Use it on every www people
count from 2026-09-26, the start of the window it was measured on. It reads
`$raw_user_agent`, which www only sends since the #5653 fix (merged
2026-09-25), so it cannot be applied to earlier dates: there is no UA to read.

A www person is a crawler when the first `$pageview` they sent matches any of
these, checked in this order:

| Class | Rule | People, 2026-09-26 to 2026-10-04 |
| ----- | ---- | -------------------------------: |
| Lightpanda | `$raw_user_agent` contains `Lightpanda` | 633 |
| Emulator | `$raw_user_agent` contains `Android SDK built` | 9 |
| Windows crawler, arm 1 | UA contains `Windows NT` and `Chrome/15x`, exactly one pageview, and its referring domain contains `boardsesh.com` | 645 |
| Other self-referred single page | exactly one pageview whose referring domain contains `boardsesh.com`, any other UA | 8 |
| Windows crawler, arm 2 | UA contains `Windows NT` and `Chrome/15x`, country `US`, at most two pageviews, no `App Install Click` | 94 |
| Kept | everything else | 274 |

"Contains `boardsesh.com`" is a substring test (`ILIKE '%boardsesh.com%'` in
the query below), and the counts in the table were measured with it. In this
window it means `www.boardsesh.com` in practice, but it also matches the apex
and any other host with that string in its name. Rebuild a tile with the same
test, not an exact match, or the class counts will not reconcile with these.

The Windows crawler is one actor with two shapes, and both arms are needed.
Arm 1 is a page loaded with our own site as its referrer and nothing after it:
a real first visit has an outside referrer or none. Arm 2 is the same UA
arriving with no referrer, in the US, loading `/` and then one `/setter/<name>`
page. Dropping either arm leaves hundreds of crawler "people" in the count.

Arm 2 is a rule about behaviour, not about identity. It also removes a real
person on Windows Chrome in the US who read one or two pages and left without
tapping a store button, and 92 of its 94 people sent some other event. So the
9-day www figure is 274 likely people, and at most 368 if every arm 2 person
was real. Quote it as that range. Do not use arm 2 to judge a US desktop
campaign.

The crawler's Chrome version was 150 to 154 in this window. `Chrome/15x` is a
signature that will age: re-check the classes when the kept count moves and
nothing else explains it.

```sql
SELECT
  multiIf(
    ua ILIKE '%Lightpanda%', 'lightpanda',
    ua ILIKE '%Android SDK built%', 'emulator',
    pageviews = 1 AND entry_referring_domain ILIKE '%boardsesh.com%'
      AND ua LIKE '%Windows NT%' AND match(ua, 'Chrome/15[0-9]'), 'windows crawler, arm 1',
    pageviews = 1 AND entry_referring_domain ILIKE '%boardsesh.com%', 'other self-referred single page',
    ua LIKE '%Windows NT%' AND match(ua, 'Chrome/15[0-9]') AND country = 'US'
      AND pageviews <= 2 AND store_clicks = 0, 'windows crawler, arm 2',
    'kept'
  ) AS class,
  count() AS people
FROM (
  SELECT
    person_id,
    countIf(event = '$pageview') AS pageviews,
    countIf(event = 'App Install Click') AS store_clicks,
    argMinIf(toString(properties.$raw_user_agent), timestamp, event = '$pageview') AS ua,
    argMinIf(toString(properties.$referring_domain), timestamp, event = '$pageview') AS entry_referring_domain,
    argMinIf(toString(properties.$geoip_country_code), timestamp, event = '$pageview') AS country
  FROM events
  WHERE timestamp >= '2026-09-26' AND timestamp < '2026-10-05'
    AND properties.$lib = 'js'
    AND person_id NOT IN COHORT 295337
  GROUP BY person_id
  HAVING pageviews > 0
)
GROUP BY class
```

The classes are per person over the window you query, so a person's class can
change with the window. Keep the window on the tile and in the query the same.

## Identity-split pitfall

A returning climber who signs in on a fresh install is counted twice: once as
their account, and once as a "newcomer" who logged in, saw one screen and never
came back. The anonymous person keeps `Login Succeeded` and often one `$screen`
(`/climbs` or `/home`), and everything after that lands on the account's older
person.

**A fix ships with #6078, and it is not yet confirmed on a device.** The app
used to tell PostHog that its signed-out anonymous person was an identified
one. It no longer does. Whether the split rate below drops is the test: see
"What is still unproven".

### What is measured

Native production, 2026-09-08 to 2026-10-01, internal cohort not excluded:

| Measure                                                             | Android        | iOS             |
| ------------------------------------------------------------------- | -------------- | --------------- |
| Alias pairs that ended on two persons (#6003 analysis)              | 87/467 (18.6%) | 57/898 (6.3%)   |
| Anonymous ids whose identity switch ended on two persons (query below) | 97/990 (9.8%)  | 63/1,754 (3.6%) |
| The same, minus persons that carry an `email`                        | 91/990 (9.2%)  | 54/1,754 (3.1%) |

- The first row only exists while the app sends `$create_alias`. Track the
  third from here on. Target once the split is fixed: under 2% on both.
- The denominator is distinct anonymous ids that were switched to another id.
  Before #6078 it is not a count of sign-ins: the `identify()` the app sent for
  the party UUID while signed out is in there too, and it never splits. From
  #6078 on the app sends no such call, so the denominator is close to sign-ins
  and roughly halves. Do not compare the rate across that date without
  recomputing the old one on sign-in switches only (`distinct_id` is not a
  UUID v4).
- Every one of the 161 flagged persons has two or more distinct ids. None is a
  lone anonymous person.
- Every native `$identify` in the window that changes identity carries an
  SDK-minted anonymous id (UUID v7) as `$anon_distinct_id`. None carries the
  party UUID (v4). About half of those anonymous ids are attached to two ids in
  turn: first the party UUID, then the account.

### What the app did (observed)

A control run on the bundle before #6078: three pristine simulator installs
and one relaunch, read back from production PostHog.

1. Signed out, before any sign-in, each launch sent
   `$identify(distinct_id = party UUID v4, $anon_distinct_id = SDK-minted v7)`.
   No `$set` and no `$create_alias` was involved.
2. PostHog created the party person with `is_identified = 1`.
3. Every signed-out cold start repeated it with a new v7 id.

Real devices show the same shape: over three days, 626 of 794 native
`$identify` events had a v4 `distinct_id` and a v7 `$anon_distinct_id`.

Three things in the app produced it:

- **The signed-out branch identified the party UUID.** The SDK was on its own
  v7 id, so `identify(partyUuid)` was a real identity change.
- **The bootstrap never took.** The client was meant to start on the party
  UUID, but the slot it read was still empty when the client was built:
  expo-router loads `app/(tabs)/_layout.tsx`, which reaches the PostHog client,
  before the root layout that filled the slot (about 1.2 s too late).
- **Every signed-out cold start reset the SDK, twice.** `AuthProvider` reset
  analytics on any session check that found no session while it was still
  loading, and two of those ran per launch about 150 ms apart. Each reset threw
  the anonymous id away and the SDK minted another. The two calls are most
  likely the mount check and the `AppState` `active` check, which native does
  not queue; that pairing is read from the code and was not instrumented.

### What the app does now

The party-profile UUID is no longer an analytics id. The rules are in the
header of `packages/shared/analytics/src/reconcile-identity.ts`, and web
follows the same ones
(`packages/web/app/components/providers/analytics-identity.tsx`):

- Signed out, the SDK stays on its own anonymous id. The app sends no
  `identify()`.
- `reset()` runs only when the SDK is pinned to a person: a sign-out, or a
  session that died while the app was closed. A signed-out cold start on an
  anonymous SDK resets nothing, so the anonymous id survives relaunches.
- Sign-in is one `identify(userId, { email })`. Its `$anon_distinct_id` is the
  anonymous id that carried the pre-login events, and nothing has identified
  that id before.
- The account's person properties (`email`, `role`, `primary_board` and the
  rest of the cohort set) go out after that `identify()`, under the user id.
  They are held back while the SDK is on any other id, so an account's email
  never lands on an anonymous person.
- A second forced sign-out in one launch (two 401s) resets nothing: the first
  one already did, and the anonymous id it left is the one the next sign-in
  merges.
- The bootstrap is gone.
- The client runs with `personProfiles: 'always'`, so signed-out events still
  build a person and carry `$process_person_profile: true`, as they did before.
  The old signed-out `identify()` had switched that on as a side effect;
  without the setting, signed-out installs would have gone personless (the SDK
  default is `identified_only`) and signed-out person counts would have stepped
  down on the OTA date. An anonymous person built this way is not identified
  (`$is_identified: false`), so it can still merge on sign-in.

An install that ran the old bundle while signed out arrives pinned to its
party UUID. The first launch on the new bundle resets it once. Its old party
person stays in PostHog as it is, and the device starts a new anonymous id.
That is one extra anonymous person per upgraded signed-out install, on the
day the OTA lands, and no more after it.

Feature flags read before sign-in are keyed on the SDK's anonymous id. Before,
they ended up keyed on the party UUID, because the app identified as it on
every launch, and that id survived a sign-out. The anonymous id holds across
launches too, so a percentage rollout still gives one answer per install, but
it changes at a sign-out. Upgraded signed-out installs are re-bucketed once,
by the reset above.

Super properties persist with the SDK and a reset clears them. Signed-out cold
starts no longer reset, so one left over from the last launch rides the first
events of the next until the app sets it again. Gym and OTA properties are
re-registered at every launch. `arm_connect_step` is the one that can be stale:
it stays until the first-connect host binds the (signed-out) account and
unregisters it. Signed-in launches always had this window.

### What is still unproven

- **The merge refusal.** The split needs a third step: on sign-in,
  `identify(userId)` carries an anonymous id that belongs to an identified
  person, and PostHog won't merge an identified person into an account that
  already has one. That is PostHog's documented rule and it matches who the
  phantoms are (a brand-new account has no person yet, so nothing splits), but
  it has not been watched happening. A device sign-in test is pending.
- **That the rate drops.** Nothing here is confirmed until the third row of
  the table falls on bundles from #6078 on.
- **Why Android is worse.** The likely reason: the session lives in secure
  storage, which survives an uninstall on iOS and not on Android, so an Android
  reinstall has to sign in again.

### Finding the phantoms

A phantom is a person with no `email` whose distinct id shows up as
`$anon_distinct_id` on a native `$identify` that belongs to a different person.

```sql
SELECT DISTINCT anon.person_id AS phantom_person_id
FROM (
    SELECT
        properties.$anon_distinct_id AS anon_distinct_id,
        person_id AS account_person_id
    FROM events
    WHERE event = '$identify'
      AND properties.$lib = 'posthog-react-native'
      AND properties.environment = 'production'
      AND properties.$anon_distinct_id != distinct_id
      -- native events carry `environment` from 2026-07-25; narrow this to
      -- the cohort's own window where you can
      AND timestamp >= toDateTime('2026-07-25 00:00:00')
    GROUP BY anon_distinct_id, account_person_id
) AS switches
INNER JOIN person_distinct_ids AS anon
    ON anon.distinct_id = switches.anon_distinct_id
WHERE anon.person_id != switches.account_person_id
  AND coalesce(anon.person.properties.email, '') = ''
```

The `email` line matters. Without it the query also flags real accounts: the
previous account after a sign-out and a sign-in to another account on the same
device (15 of the 161 in the window above). Excluding those from a cohort would
drop real climbers.

For the split rate, add `any(properties.$os) AS os` to the subquery, move both
`WHERE` conditions into a `uniqIf(anon.person_id, ...)`, and divide by
`uniq(switches.anon_distinct_id)` per `os`. Split it by OTA bundle as well.

### Rules

- **A newcomer cohort must exclude the phantoms.** Add
  `person_id NOT IN (<the query above>)`, or keep only people whose
  `Login Succeeded` has `is_new_account = true`. The second is cheaper but is
  null on embedded JS and before the 2026-09-21 OTA, and from the #6027 OTA the
  flag can arrive on `Login Account Age Resolved` instead ("Counting sign-ups"
  below).
- **This holds for cohorts after #6078 too**, until the split rate above is
  seen to drop on bundles that carry it.
- **Past phantoms stay.** No fix merges them. PostHog merges can't be undone,
  so nobody should try to repair them by hand.
- **Signing out and into another account on one device** leaves the first
  account's person holding the anonymous id. That is a real account, not a
  phantom, and it is not fixed either.

## Newcomer, bind, board-active

Three words every activation read uses. Use these meanings, and say so when a
number uses another one.

| Term         | Meaning                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Newcomer     | A person whose first-ever event, across every `$lib` and `environment`, is within 1 hour of their first native production event. Phantoms excluded (above), internal cohort excluded. |
| Bind         | The person got a board to climb on: any of `Onboarding Board Activated`, `Board Picker Selection Completed`, `Board Created`, `Board Create Reused Existing`. |
| Board-active | The person lit a climb on a board: at least one `Climb Sent to Board Success` in the window. Name the window ("board-active in 28 days").            |

- "First" has to be first-ever. The first production-tagged event is not: 20
  to 35% of those people were already climbing on an older build or the old web
  client. PostHog's own "first time" filter has the same flaw.
- Android newcomer cohorts take store builds only (`$app_build`; 2.5.0 is
  2001108). Test and Play pre-launch builds add people who almost never scan.
- `Signup Completed` is email registration only. Apple and Google sign-ups show
  up as `is_new_account = true` on `Login Succeeded` or `Login Account Age
  Resolved` ("Counting sign-ups" below).
- A database read of board-active (an account with a light or a tick) counts
  accounts, not PostHog people. Don't mix the two in one rate.
- Report the Activation funnel below next to any narrower measure, so two
  reads can be compared.

## Funnels

All ordered, unique people, the native production population, internal cohort
excluded.

| Name                    | Steps                                                                                          | Window    | Why                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| Search to send (main)   | `Climb Search Performed` → `Climb Sent to Board Success`                                        | 3 hours   | Sending straight from search is a success. The queue is optional.                        |
| Queue adoption          | `Climb Search Performed` → `Climb Added to Queue` → `Set Active Climb` → `Climb Sent to Board Success` | 3 hours   | How many use the queue. Not a success measure: it counts direct sends as drop-off.       |
| Activation              | first-ever `$screen` → first `Climb Sent to Board Success`                                      | 7 days    | Replaces the lifecycle-install funnel, whose install events are sparse.                  |

Baseline from the 2026-09-20 audit (2026-08-23 to 2026-09-19 UTC): search to
send 1,808/2,361 (76.6%); queue adoption 323/2,361 (13.7%).

### Spray-wall activation

A spray wall has no Bluetooth (`docs/spray-walls.md`, "No Bluetooth, and the
flag it rests on"), so a
climber whose first board is a spray wall can never send `Climb Sent to Board
Success` and reads as a failure in the Activation funnel above. Spray walls get
their own definition:

> A new person created or took a spray wall, then lit or ticked a climb on a
> spray wall, within 7 days of their first-ever `$screen`.

| Step | Events | Filter |
| ---- | ------ | ------ |
| 1. Created or took a wall | `Board Created` or `Wall Taken` | `boardType = 'spray'` on `Board Created`; `boardName = 'spray'` on `Wall Taken` |
| 2. Lit or ticked a climb | `Set Active Climb` or `Tick Logged` | `boardType = 'spray'`; on `Set Active Climb` also `trigger` is not `climb_saved` |

Ordered, unique people, native production, internal cohort excluded, both steps
inside 7 days of the first-ever `$screen`.

"Lit" on a wall with no lights is `Set Active Climb`: the climber made a climb
the one on the wall. "Took" is `Wall Taken`, the "I'm on it" turn on a wall
with no light kit.

Saving a climb also fires `Set Active Climb`, because the create screen puts
the saved climb on the queue. Those carry `trigger = 'climb_saved'` and are
left out of step 2. Every spray wall starts empty and the first thing anyone
does on one is set a climb, so with saves counted step 2 would read "saved a
climb" for nearly everyone and could not tell a climber who came back from one
who did not. In HogQL the filter is
`coalesce(toString(properties.trigger), '') != 'climb_saved'`: `trigger` is
null on a climb the climber chose.

`boardType` on both step 2 events is the climb's own board, not the board the
app has active. A spray climb opened from a shared link by someone whose active
board is a Kilter counts as spray. `Set Active Climb` falls back to the active
board only when the climb carries no board type.

Read it with these limits:

- **It is unvalidated.** From 2026-09-21 to 2026-10-04 the spray events came
  from testers: `Board Created` with `boardType = 'spray'` was 10 events from 1
  person. No rate has been measured, so there is no baseline and no evidence
  yet that step 2 separates climbers who stay from climbers who leave.
- **Step 2 exists only from the #6027 mobile OTA.** `Tick Logged`, `Set Active
  Climb` and `Climb Created` carried no board type before it, and a spray
  wall's `layoutId` is created with the wall, so earlier events cannot be
  classified. Do not backfill.
- **The two steps are not tied to the same wall.** No event may identify a
  wall, so "a climb on it" is measured as "a climb on a spray wall".
- **Report it beside the Bluetooth activation rate, never added to it.** They
  count different first sessions.

`Climb Created` carries `boardType` too. Setting a climb is not part of the
definition, which is why the save's own `Set Active Climb` is filtered out
above; count it as its own measure. Its `boardLayout` is the empty string
on a spray wall, which is an accident of the layout table and not a classifier.

## Acquisition

These are separate counts. None of them is a funnel of the same people.

| Measure              | Event / property                                         | What it means                                                                                     |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Landing visits       | www `$pageview`, by page group                             | Visits, after the crawler caveats above.                                                         |
| Landing source       | www `$pageview` and every www `track()` event: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid` | The tags on the URL the visit landed on. Absent on an untagged visit. See "Campaign params on www". |
| Store clicks         | `App Install Click` (www and browser app), by `platform`, `source` and `placement` | Someone tapped a store button. Not an install. |
| Android install source | person properties `install_source` / `install_medium` / `install_campaign`, classified with the expression below | From the Play Install Referrer, once per install. `campaign`, `organic` or `unknown`. |
| iOS install source   | App Store Connect App Analytics, by campaign (`ct`)          | Aggregate download counts per campaign token. Nothing per person, and nothing in PostHog: Apple gives the app no referrer. Show iOS as unknown in PostHog; do not infer it. |
| New-user activation  | the Activation funnel above                                 | Counts people, not installs.                                                                      |
| Android link id      | `utm_content` inside person property `install_referrer_raw` ("Link ids on Android installs" below) | Which published link an install came from: on www, the button's `placement` ("Store links" below). Empty before the #6027 web deploy. |
| Sign-ups             | `is_new_account = true` on `Login Succeeded` or `Login Account Age Resolved` ("Counting sign-ups" below) | New accounts, native only. |

`App Install Click` comes from two populations: www, and the store prompt in the
browser app (phone browsers only, on the signed-out climb view, the login screen
and Home). A store-click tile has to union both. Browser-app clicks carry
`placement` = `browser-app-climb-view`, `browser-app-login` or
`browser-app-home`, with the same `platform` and `source` values as www. A
browser-app click carries no `utm_*` properties: PostHog reads those as the
campaign that brought a visitor in and copies them to the person, so a store
click must not set its own link's tags on the event. (A www click can carry
`utm_*`, but only the tags of the URL the visitor landed on, never the store
link's. See "Campaign params on www".) Break clicks down by `placement`. The tags live on the
store links only, which carry `utm_source=boardsesh`, `utm_medium=browser-app`,
`utm_campaign=<climb-view|login|home>`: on Android that arrives as
`install_medium = browser-app` and `install_campaign`; on iOS it is the App
Store campaign token `ct=browser-app-<surface>`, which App Analytics only shows
once the link also carries the provider token (`pt`, not set yet).

`Install Attributed` fires whenever the Play referrer has any `utm_*` param.
Play stamps organic installs too (`utm_source=google-play&utm_medium=organic`),
so 584 of the 663 people who fired it from 2026-08-23 to 2026-09-19 were
organic. It also fires on the first launch of an older install that never ran
the referrer code, so it is not a new-install count. Filter new installs on
`install_begin_timestamp`.

Classify the channel from the person properties every Android install already
has. This matches `classifyInstallChannel` in
`packages/mobile/src/lib/install-referrer.ts` and covers every install back to
the start:

```sql
multiIf(
  lower(person.properties.install_medium) = 'organic', 'organic',
  coalesce(
    nullIf(nullIf(person.properties.install_source, ''), '(not set)'),
    nullIf(nullIf(person.properties.install_medium, ''), '(not set)'),
    nullIf(nullIf(person.properties.install_campaign, ''), '(not set)')
  ) IS NOT NULL, 'campaign',
  'unknown'
)
```

The app also sends that result as `install_channel`, but don't build tiles on it
yet. The referrer is read once, on an install's first launch. That launch runs
the JS embedded in the store APK: expo-updates' `fallbackToCacheTimeout` is left
at its default of 0, so an OTA only applies from the next cold start. So
`install_channel` only appears for installs of the next Android store binary
after #5653, and never for anyone who installed before it.

A Google Ads install whose referrer carries only `gclid=…` and no `utm_*` reads
as `unknown` and fires no `Install Attributed`. Its raw referrer is kept in
`install_referrer_raw`.

### Link ids on Android installs

A store link can carry a link id in `utm_content` (#6027). The app's referrer
parser keeps only source, medium and campaign, but the whole referrer string is
stored as the person property `install_referrer_raw`, so the link id is
readable with no app change and for every install already made:

```sql
SELECT
  coalesce(extract(toString(properties.install_referrer_raw), 'utm_content=([^&]*)'), '') AS link_id,
  coalesce(extract(toString(properties.install_referrer_raw), 'utm_campaign=([^&]*)'), '') AS campaign,
  count() AS people
FROM persons
WHERE notEmpty(coalesce(extract(toString(properties.install_referrer_raw), 'utm_content=([^&]*)'), ''))
GROUP BY link_id, campaign
ORDER BY people DESC
```

- The values come out as Play stored them, still URL-encoded (`+` for a space).
- Test for a present value with `notEmpty(coalesce(…, ''))`. HogQL counts
  `NULL != ''` as true, so `extract(…) != ''` matches every person with no
  referrer at all.
- On 2026-10-05 this returns no rows: 2,138 people have `install_referrer_raw`
  and none of them has a `utm_content`, because no link we published set one.
  The www store links fill it from the #6027 web deploy ("Store links" below). The same
  expression on `utm_term` finds 46 people, so the extraction itself works.
- `install_referrer_raw` and the other `install_*` values are person
  properties. They are not on the `Install Attributed` event.
- iOS has no referrer, so there is no link id on iOS.

### Counting sign-ups

PostHog could not count sign-ups before the #6027 mobile OTA. `is_new_account`
on `Login Succeeded` was null whenever the account's creation time was not
known within 5 s of sign-in, and on store version 2.5.0 that was 42% of logins
(week of 2026-09-28: true 203, null 176, false 29). That week PostHog's own
events gave 242 new people. The database figure is about 366 a week, which was
not re-checked when this was written.

From the OTA, a `Login Succeeded` that goes out null is followed by `Login
Account Age Resolved` when the creation time arrives within two minutes, with
the same sign-in properties and the same backdated timestamp. A sign-up is a
person with `is_new_account = true` on either event:

```sql
SELECT
  toStartOfWeek(timestamp, 1) AS week,
  uniq(person_id) AS new_accounts
FROM events
WHERE timestamp >= '2026-10-05' AND timestamp < now()
  AND event IN ('Login Succeeded', 'Login Account Age Resolved')
  AND toString(properties.is_new_account) = 'true'
  AND properties.$lib = 'posthog-react-native'
  AND properties.environment = 'production'
  AND person_id NOT IN COHORT 295337
GROUP BY week
ORDER BY week
```

- "New" means the account was at most 24 hours old at sign-in.
- `Signup Completed` is email sign-up only. Apple and Google find or create the
  account in one step and fire no sign-up event, so `Signup Completed` alone
  undercounts by most of the total.
- `account_age_read` on `Login Succeeded` says how the 5 s went: `ok`,
  `timeout`, `empty` or `error`. The cause of the 42% was not established. If
  the null share stays high after the OTA, this split is where to look, and
  the share of nulls that `Login Account Age Resolved` repairs is the measure
  of whether the follow-up is enough.
- A sign-in still counts as unknown when the app is closed before the creation
  time arrives, or it takes longer than two minutes. Check the remaining null
  share against the database before trusting a week.
- Every login event carries `provider` (`email`, `google`, `apple`) from the
  same OTA, next to the older `auth_method` (`credentials`, `google`, `apple`).
  They are the same fact; use `provider` on new tiles.
- The browser app's Apple and Google return (`flow = 'web'`) and www's own
  `Login Succeeded` carry no account age. This count is native only.

### "New people" has three regimes

A weekly count of first-ever native people is not one series. How a person got
minted changed twice:

| Period | What a first-ever native person is | Use |
| ------ | ---------------------------------- | --- |
| Before 2026-07-27 | Only someone who logged in. People were not tracked before sign-in, so 92 to 95% of new people logged in within 7 days. | New people who logged in. Nothing about people who never signed in. |
| 2026-07-27 to 2026-09-06 | Real people plus throwaway persons minted by app versions 2.3.0 and 2.3.1: one distinct id, about 8 start-up events, one day, no login. About 500 a week on iOS and 220 to 290 on Android. Raw counts are about 3 times the real figure. | Do not read the raw count. |
| From 2026-09-07 | Real people, including those who have not signed in yet. The throwaway persons stop as 2.4.0 and 2.5.0 roll out: 26 to 46 one-day, never-logged-in people a week per platform remain. | Raw count is usable. |

Raw first-ever native people per week from 2026-08-10: 1,070, 1,188, 1,168,
823, 591, 432, 398, 474. The fall is the artifact ending, not people leaving.

The one figure that means the same thing in all three regimes is **first-ever
people who log in within 7 days**: 494, 369, 333, 392 for the four weeks from
2026-09-07, iOS 64%. Put that on any tile that spans a regime boundary, and
annotate both boundaries.

Which 2.3.x change minted the throwaway ids was not traced in code. The dates
come from the data.

## Campaign params on www

www runs posthog-js-lite, which never parses campaign params. Until #6027 no www
event or person had a `utm_*` property: 0 of 6,661 sessions in the 28 days to
2026-10-05 had `$entry_utm_source`, although tagged links did arrive (ChatGPT,
an Instagram bio).

`packages/web/app/lib/inbound-campaign.ts` now reads `utm_source`, `utm_medium`,
`utm_campaign`, `utm_content`, `utm_term` and `gclid` off the landing URL, and
`analytics.ts` sends whichever were present as plain event properties on
`$pageview` and on every `track()` event (`App Install Click`, `Climb Handoff
Clicked`, the gym funnel). PostHog derives the session's `$entry_utm_source`
from those; we do not set it ourselves.

**Break www traffic down by the session property `$entry_utm_source` or by the
event property `utm_source`. Not by the person property `$initial_utm_source`.**
The www client sets no `personProfiles`, so it runs on the SDK default
`identified_only`: an event from a signed-out visitor is sent with
`$process_person_profile: false` and writes no person property. Almost all
landing traffic is signed out, so a breakdown on `$initial_utm_source` shows
close to nothing for www while the tagged visits are all there on the session.
The person property exists only for someone who is identified on www.

- **Read once per page load, from the landing URL, and kept in memory.** A
  client-side navigation keeps it. A full page load (a locale switch, a hard
  reload on a later page) starts over from that page's URL. Nothing is written
  to browser storage.
- **Not on `$web_vitals`.** That event goes through `capturePosthog`, not
  `track()`.
- **An untagged visit sends none of the keys.** Filter on `utm_source IS NOT
  NULL`; do not expect an empty string.
- **No `$current_url` override.** `pageview()` used to pass the pathname as
  `$current_url`. The SDK spreads its own properties after the caller's, so
  every www event has always carried the full URL, query string included. The
  override was removed; the data did not change.
- Values are trimmed and capped at 200 characters. Param names are
  case-sensitive.

Annotate the deploy date: `utm_*` on www starts there and is not backfilled. For
earlier visits, parse `$current_url`.

**`utm_content` on a www event is the landing tag, not the store link id.** A
visitor who arrives on `?utm_content=ad-creative` and taps the hero button sends
`App Install Click` with `utm_content = 'ad-creative'` and `placement = 'hero'`,
and opens a store link whose `utm_content` is `hero`. The link id lives in the
store URL only, and after an install in `install_referrer_raw`. To join clicks
to installs, match the event's `placement` to the `utm_content` extracted from
`install_referrer_raw`. Joining event `utm_content` to install `utm_content`
gives wrong rows for every tagged visitor.

## Store links

Every store button on www builds its URL with `buildStoreUrl` in
`packages/web/app/lib/store-links.ts`. A link says four things:

| Value    | Untagged visit                                   | Visitor arrived on a tagged link     |
| -------- | ------------------------------------------------ | ------------------------------------ |
| source   | `boardsesh`                                      | their `utm_source`                   |
| medium   | `web` for a click on a page, `qr` after scanning a printed code | their `utm_medium`, unless it is `organic` or `(not set)` |
| campaign | `www`, or `gym-<slug>` on a gym page             | their `utm_campaign`                 |
| link id  | the button's `placement`, plus `.poster` / `.kiosk` / `.board` after a scan | the same: the link id is always ours |

The visitor's tags win field by field. A gym that links its page from Instagram
with a source and medium but no campaign still reports `gym-<slug>`. A landing
URL with a `gclid` and no `utm_source` reads as `google` / `cpc`; the click id
itself is not copied into the store link.

A visitor's `utm_medium` of `organic` (any case) or `(not set)` is not carried;
the link keeps `web` or `qr`. Play writes those two values itself, and the app
files any referrer whose medium is `organic` as `install_channel = 'organic'`
before it reads the source or campaign. A gym that tags its Google Business
Profile link `utm_medium=organic` would otherwise move every install from our
button out of the `campaign` count. Its source and campaign still carry.

Link ids today: `hero`, `help`, `gym-page`, `gym-page.poster`, and
`join-page.<session id>` on a session invite page. Reserved for the store
buttons still to come (`AppInstallPlacement` in
`packages/web/app/lib/app-install-event.ts`): `climb-view`, `climb-list`,
`spray-climb`, `gyms-directory`, `site-banner`. The link id equals the
`placement` on the matching `App Install Click`, so clicks and installs join on
it: event `placement` on one side, the `utm_content` inside
`install_referrer_raw` on the other. Do not use the event's own `utm_content`
property for this; that is the visitor's landing tag ("Campaign params on www").

**A session invite link names its session.** The invite page
(`/join/{sessionId}`, #6004) sends `utm_campaign=session-invite` and
`utm_content=join-page.<session id>` to Google Play, so an Android install can
be traced to the invite behind it; the click carries the same `sessionId`. Split
the link id on the first `.` to get the placement back. The App Store token is
`join-page` for every invite: one session never reaches the 5 downloads App
Analytics needs, and its id would not fit in 30 characters. Nothing in the app
acts on the session id yet. Bringing an Android invitee back to the session
after install is a follow-up, and only a new store binary's first launch can do
it.

**`utm_medium=qr` changed meaning with #6027.** Before it, every gym-page Play
link said `qr`, whether or not a code was scanned. After it, `qr` means the page
was reached from a printed code and a plain click on a gym page says `web`.
Annotate the deploy date and do not compare `qr` counts across it. The 3 tagged
installs in the 28 days before the change are gym-page clicks of unknown kind.

The Capacitor retirement screen keeps its bare store URLs. It sends someone who
already has the app to update it, which is not an install.

### Google Play

The four values go into the `referrer` param, which Play hands the app through
the Install Referrer API, and are repeated as bare `utm_*` params for
readability. The app parses source, medium and campaign into `install_source`,
`install_medium` and `install_campaign`, and keeps the whole string as
`install_referrer_raw`. The link id is read from that string, so it works for
every store binary already installed, with no app change. The query is under
"Link ids on Android installs" above; add `install_source`, `install_medium`
and `install_campaign` from the same person to break it down further.

Counts are small: 3 tagged Android installs in the 28 days to 2026-10-04.

### App Store

An App Store link carries `ct` (a campaign token of at most 30 characters),
`mt=8`, and `pt` (the App Store Connect provider id) when the build has one.
Apple reports downloads per campaign in App Analytics, in aggregate. Nothing
reaches the app, so nothing reaches PostHog.

- `ct` is the link id for an untagged visit (`hero`, `gym-page`,
  `gym-page.poster`), and `<utm_source>-<utm_campaign>` (or just the source) for
  a visit whose link named a source or a campaign. A link tagged with a medium
  and nothing else keeps the link id. Characters outside letters, digits, `.`,
  `_` and `-` become `-`.
- A single gym never appears in `ct`. App Analytics hides a campaign until it
  has at least 5 first-time downloads, which no one gym's page reaches, so all
  gyms share `gym-page` and `gym-page.poster`.
- **`pt` comes from `NEXT_PUBLIC_APP_STORE_PROVIDER_ID`**, a build-time variable
  of the web service. It must be digits only; anything else is ignored. **It is
  not set yet**: the provider id has to be read out of App Store Connect (it is
  the `pt` value in a campaign link generated there). Until it is set, links
  carry `ct` and `mt` with no `pt`, and App Analytics attributes nothing.
  Setting it needs a rebuild of the web service, like every `NEXT_PUBLIC_`
  variable.

## Session invites

The invite funnel, host to joiner (#6004). Before it only `Session Joined`
existed, and it over-counted.

| Step | Event | Where | Properties |
| ---- | ----- | ----- | ---------- |
| Host opens the invite sheet | `Session Invite Sheet Opened` | app | `sessionId` |
| Host sends the link | `Session Invite Shared` | app | `sessionId`, `method` (`copy_link`, `system_share`), `shareTarget` (iOS only) |
| Invitee without the app lands on www | `Session Invite Page Viewed` | www | `sessionId` (absent for `not_found`), `state` (`live`, `dormant`, `ended`, `not_found`, `unavailable`), `hasHost`, `hasGym` |
| Invitee taps a store button | `App Install Click` | www | `placement: 'join-page'`, `sessionId`, `platform` |
| Invitee with the app taps "Open in the app" on www | `Session Invite Open In App Clicked` | www | `sessionId` |
| Invitee joins | `Session Joined` | app | `sessionId` (and the older `session_id`, same value), `board_name`, `layout_id` |
| Invitee hits a dead end | `Session Join Outcome` | app | `sessionId`, `outcome` (`not_found`, `ended`, `host_away`, `sign_in_needed`, `error`), `stage` (`preview`, `join`) |

Read it with these limits:

- **`system_share` means different things per platform.** iOS reports a
  dismissed share sheet (nothing fires) and the app that was picked
  (`shareTarget`). Android reports neither, so there the event means the chooser
  was opened. Break the step down by `$os`; do not add the two.
- **A QR scan is invisible.** The invite sheet shows the code as soon as it
  opens. A scan happens on someone else's phone, so the host's side records
  `Sheet Opened` and nothing more.
- **www mostly sees invitees without the app.** An installed phone opens the
  app directly and never loads the page, so `Session Invite Page Viewed` is not
  "invites opened". It is "invites opened by someone who needs the app", plus
  the people whose link opened inside another app's built-in browser, which
  skips the app. `Session Invite Open In App Clicked` counts those who then
  asked for the app; it is a click, not proof the app opened.
- **Tie the funnel together on `sessionId`.** Every step carries it, `Session
  Joined` included from the #6004 deploy on. Joins before that deploy only have
  `session_id`. A landing on a link that names no session (`state: not_found`)
  has no `sessionId` at all: the text in such a URL is arbitrary and is kept
  out of analytics.
- **`host_away` is a good invite that cannot be joined yet.** The session is
  running, nobody is connected, and its wall is a spray wall that is not open
  to everyone, so the backend does not hand the board path to a link holder.
  The screen asks for the host to open the app. Count it apart from
  `not_found`.
- **`Session Joined` changed meaning.** It used to fire again for someone
  already in the session who opened the invite. It now fires once per genuine
  entry. Do not compare counts across the deploy.
- **`Session Started`** carries `sessionId` and `isPublic` (the "show this
  session live" switch). It no longer sends `isDiscoverable`, which was `false`
  on every event ever sent because no screen sets the field behind it.
- **`sign_in_needed` is rare by design.** The auth gate sends a signed-out
  invitee to login and replays the link afterwards, so this outcome only counts
  the cases that reach the join screen signed out.

## Retention

Weekly or monthly, with the start and return events named on the tile, the
internal cohort excluded inside any SQL, and only cohorts old enough to have
finished the period shown as final. Mark the current, unfinished period.

## Dates to annotate in PostHog

| Date       | Change                                                          |
| ---------- | --------------------------------------------------------------- |
| 2026-07-25 | Native events start carrying `environment` (legacy binaries never do) |
| 2026-09-11 | Known crawlers stop booting the www client (#5388)              |
| #5653 web and OTA deploy | www and browser app send `$raw_user_agent` |
| next Android store binary after #5653 | New Android installs send `install_channel` (use the expression above until then) |
| 2026-07-27 | Native people start being tracked before sign-in ("new people" regime 2 begins) |
| 2026-09-07 | Throwaway persons from 2.3.0 and 2.3.1 stop ("new people" regime 3 begins) |
| 2026-09-26 | The www crawler rule applies from here (first day of the window it was measured on) |
| #6027 mobile OTA | `Login Account Age Resolved` starts; login events carry `provider` and `account_age_read`; `Tick Logged`, `Set Active Climb` and `Climb Created` carry `boardType`; `Set Active Climb` carries `trigger` (`climb_saved` on a save); `Onboarding Gate Evaluated` gains the skip reason `replayed_board_link` |
| #6078 OTA (fill in the date when it ships) | The app stops sending `$create_alias` and stops identifying signed-out installs. Native `$identify` volume drops by most of its total, upgraded signed-out installs each start one new anonymous person, and the identity split is expected to fall from this date (see "Identity-split pitfall") |
| #6027 web deploy | www events carry `utm_*` and `gclid`; every Play link carries a link id (`utm_content`); `utm_medium=qr` on a gym install starts meaning a scan; `App Install Click` on /help starts sending `placement: 'help'` |
| #6004 web and OTA deploy | `Session Joined` stops firing for someone already in the session; `Session Started` sends `isPublic` and `sessionId` and drops `isDiscoverable`; the four invite events start; www `/join` pageviews become countable (the page no longer redirects on mount) |
| `NEXT_PUBLIC_APP_STORE_PROVIDER_ID` set | App Store campaign links start counting in App Analytics |

None of these repairs past data. Annotate them; do not backfill.
