# Growth metrics contract

Which PostHog events and filters the growth dashboards count, and why. Project
412845. Written for #5653. The live insights are configured in PostHog; this
file says what they are supposed to count, so a tile can be checked against it.

Every figure here is a count of PostHog people, except active users (below),
which come from our own database. None of them is a count of verified humans
or store installs.

## Active users (canonical DAU, WAU and MAU)

The canonical active-user numbers are the `Active Users Snapshot` event, not a
count of PostHog people. The backend writes one `user_activity_days` row per
signed-in climber per UTC day per platform whatever their analytics consent,
and the scheduler's `snapshot-active-users` job sends one event a day with the
counts (see [analytics-consent.md](./analytics-consent.md)).

- **Filter:** `event = Active Users Snapshot` (distinct id
  `system:active-users`, `$lib = posthog-node`). One event per counted day, dated
  midday UTC of that day; a re-run reuses the same event uuid, so it does not
  double a day.
- **Properties:** `day`, `dailyActiveUsers` (that day), `weeklyActiveUsers`
  (7 days ending that day), `monthlyActiveUsers` (30 days ending that day),
  and per platform with a suffix: `dailyActiveUsersWeb`, `…Ios`, `…Android`,
  `…Unknown`. A climber on two platforms counts once overall and once on each.
- **Who counts:** signed-in climbers only. Signed-out visitors are not in it,
  and a signed-out climber who declines analytics can't be counted anywhere.
- **Platform:** `unknown` until the web and app clients send
  `x-boardsesh-platform` / `clientPlatform` (PRs B and C of #2644).
- **PostHog MAU is no longer comparable.** Once the consent prompt ships (PRs B
  and C of #2644), PostHog only sees climbers who chose "Allow", so a
  people-based MAU tile drops by the share who declined or never answered.
  Read growth from the snapshot; read behaviour (funnels, retention) from
  PostHog people, knowing they are the consenting subset.

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
| Backend            | `$lib = posthog-node`                                             | Server-side events. Only a production backend sends (`packages/backend/src/services/analytics/posthog.ts`). Since #2644 none of them is a person: each has its own random distinct id, so never count people on them. |
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
- Before 2.6.0, `Signup Completed` is email registration only. Apple and Google sign-ups show
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

Product analytics reports cover only people with a current Allow. Apple Ads'
download, spend and acquisition-cost reports remain available independently of
the Boardsesh analytics choice. From the 2.6.0 iOS binary, the first-party
AdServices integration connects consenting campaign-attributed people to
verified signups and later activity. App Store
Connect campaign-link tokens below are a separate aggregate measurement.
See [Apple's reporting definitions](https://ads.apple.com/app-store/help/reporting/0023-reporting-options-and-definitions).

| Measure              | Event / property                                         | What it means                                                                                     |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Landing visits       | www `$pageview`, by page group                             | Visits, after the crawler caveats above.                                                         |
| Landing source       | www `$pageview` and every www `track()` event: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid` | The tags on the URL the visit landed on. Absent on an untagged visit. See "Campaign params on www". |
| Store clicks         | `App Install Click` (www and browser app), by `platform`, `source` and `placement` | Someone tapped a store button. Not an install. |
| Android install source | person properties `install_source` / `install_medium` / `install_campaign`, classified with the expression below | From the Play Install Referrer, once per install. `campaign`, `organic` or `unknown`. |
| iOS install source   | Apple Ads `apple_ads_*` person properties from the 2.6.0 iOS binary; App Store Connect campaign tokens separately | AdServices can connect consented Apple Ads attribution to a person. App Store campaign-link tokens (`ct`) remain aggregate-only; missing attribution stays unknown. |
| New-user activation  | the Activation funnel above                                 | Counts people, not installs.                                                                      |
| Android link id      | `utm_content` inside person property `install_referrer_raw` ("Link ids on Android installs" below) | Which published link an install came from: on www, the button's `placement` ("Store links" below). Empty before the #6027 web deploy. |
| Sign-ups             | `Signup Completed` from 2.6.0; historical `is_new_account` estimates separately ("Counting sign-ups" below) | Verified new accounts, native only; returning logins do not convert. |

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

On Android, `Install Attributed` fires whenever the Play referrer has any `utm_*` param.
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

### Apple Ads (iOS)

The native token and response contract follows
[Apple's AdServices Attribution API](https://ads.apple.com/adsdam/us/en_us/documents/help/0028-apple-ads-attribution-api/2025-03-25/AdServices-API-v3.pdf).

This requires a new 2.6.0 iOS binary. An OTA cannot add the native AdServices
module to an older binary; Android and browser targets do not acquire tokens.
Only a current Allow starts acquisition and exchange. Tokens stay in memory,
travel to our backend and Apple, and never enter logs, PostHog or disk.

`Install Attributed` uses `attribution_provider = apple_ads` and the same
allowlisted properties as the person's `$set_once` properties:

| Property | Meaning |
| --- | --- |
| `apple_ads_attribution_status` | `attributed` or `unattributed`; Apple's negative result does not prove organic acquisition. |
| `apple_ads_org_id`, `apple_ads_campaign_id`, `apple_ads_ad_group_id` | Required positive Apple IDs, represented as strings without numeric precision loss. |
| `apple_ads_keyword_id`, `apple_ads_ad_id` | Optional positive IDs; absent when Apple does not supply them. |
| `apple_ads_conversion_type`, `apple_ads_claim_type` | `Download`, `Redownload` or `PreOrder`; optional `Click` or `Impression`. |
| `apple_ads_country_or_region`, `apple_ads_supply_placement` | Optional region and supported App Store placement. |

Development dummy responses never publish. Invalid responses, exhausted
retries, a missing native module and unanswered/declined consent leave the
source unknown. There is no fallback from these outcomes to `organic`.
Filter iOS campaign reports on `attribution_provider = apple_ads` and
`apple_ads_attribution_status = attributed`. Report `unattributed` separately:
it is an explicit negative Apple Ads result, not the Android `install_channel`
classification. Missing status remains unknown. The publisher accepts only
`attributed` and `unattributed`; test and retry statuses never reach PostHog.
The bounded retry sequence makes at most three exchanges with one token,
waiting at least five seconds between attempts. Apple tokens expire after
24 hours; a later foreground attempt obtains a fresh token after a cooldown.

The install is assigned once to its first verified account. An anonymous
publication can precede that assignment; signing in attaches person
properties without repeating the install event. Signing out or switching
accounts clears pending attribution and prevents transfer to another account.
Withdrawal cancels outstanding work and clears campaign data, retaining only
the ownership/deduplication marker. A late result can enrich an already-sent
signup through person properties; it never sends that signup again.

Use `attributed` people for a campaign conversion report. This HogQL example
counts unique consenting production iOS people observed during the selected
window, their verified signups in that window, and board activation within
seven days of their first observed screen in that window. Replace both window
bounds together. Include only the new binary's builds when comparing release
cohorts; this query does not claim that its first observed screen is a new
store install, nor that returning accounts are new users.

```sql
WITH campaign_people AS (
  SELECT
    person_id,
    toString(person.properties.apple_ads_campaign_id) AS campaign_id,
    minOrNullIf(timestamp, event = '$screen'
      AND timestamp < '2026-11-01') AS first_open,
    minOrNullIf(timestamp, event = 'Signup Completed'
      AND timestamp < '2026-11-01') AS signup_at
  FROM events
  WHERE timestamp >= '2026-10-01' AND timestamp < '2026-11-08'
    AND properties.$lib = 'posthog-react-native'
    AND properties.environment = 'production'
    AND properties.$os = 'iOS'
    AND person.properties.attribution_provider = 'apple_ads'
    AND person.properties.apple_ads_attribution_status = 'attributed'
    AND person_id NOT IN COHORT 295337
  GROUP BY person_id, campaign_id
)
SELECT
  campaign_people.campaign_id,
  uniqExactIf(campaign_people.person_id, first_open IS NOT NULL) AS observed_first_opens,
  uniqExactIf(campaign_people.person_id, signup_at IS NOT NULL) AS verified_signups,
  uniqExactIf(campaign_people.person_id,
    activity.event = 'Climb Sent to Board Success'
    AND activity.timestamp >= first_open
    AND activity.timestamp < first_open + INTERVAL 7 DAY) AS board_active_in_7_days
FROM campaign_people
LEFT JOIN events AS activity ON activity.person_id = campaign_people.person_id
WHERE activity.timestamp >= '2026-10-01' AND activity.timestamp < '2026-11-08'
  AND activity.properties.$lib = 'posthog-react-native'
  AND activity.properties.environment = 'production'
  AND activity.properties.$os = 'iOS'
GROUP BY campaign_people.campaign_id
```

For ad-group or keyword cuts, use the corresponding person properties. Keep
absent keyword IDs in an unknown bucket rather than dropping those people.
Use the separate spray-wall activation definition above for spray-wall crews.

Apple Ads reports spend, taps, downloads and acquisition cost for all eligible
campaign traffic. PostHog reports only consenting people whose attribution
was available, and can identify accounts across installs. Do not divide Apple
spend by these signup counts and label it Apple's acquisition cost. Show the
two populations and their date windows separately; App Store `ct` links below
are yet another aggregate measurement.

Before closing #6285, record evidence from a real campaign and the released
2.6.0 binary: one fresh attributed download, fresh email/Apple/Google signup
including browser fallback, returning-account login without conversion,
declined and withdrawn consent, and an account switch without transferred
campaign properties. Check PostHog event UUIDs and account ownership, and
confirm App Store privacy disclosures describe advertising measurement and
product analytics. Simulator, mocked and TestFlight dummy responses prove
code paths only; they do not prove real campaign attribution.

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

From the 2.6.0 integration for #6285, native `Signup Completed` covers verified
email registration and genuinely new Apple/Google accounts, including browser
OAuth fallback. The backend proves account creation; entering through the
registration screen and an account younger than 24 hours are not proof. Its
event UUID is stable per account and its timestamp is the account creation
time. Current Allow and the verified account's SDK identity are required.
Missing metadata from older clients/backends remains unknown.

Use `Signup Completed` for the new campaign report above; keep the historical
age-based read below for earlier builds. Do not union the two as event counts.

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
- Before 2.6.0, `Signup Completed` is email sign-up only. Apple and Google find or create the
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

Link ids today: `hero`, `help`, `gym-page`, `gym-page.poster`, and since the
store buttons of #6027 `climb-view` (a climb page, in both the config-tuple and
the `/b/{slug}` tree), `climb-list` (a board's climb list), `spray-climb` (a
climb on a spray wall) and `gyms-directory` (`/gyms` and its three board
pages). `help` covers the /help index and its seven sub-pages; tell them apart
by `$pathname` on the click. `site-banner` is the iOS Smart App
Banner, which has a campaign token and no click event (below). Reserved for a
button still to come (`AppInstallPlacement` in
`packages/web/app/lib/app-install-event.ts`): `join-page`. The link id equals
the `placement` on the matching `App Install Click`, so clicks and installs
join on it: event `placement` on one side, the `utm_content` inside
`install_referrer_raw` on the other. Do not use the event's own `utm_content`
property for this; that is the visitor's landing tag ("Campaign params on www").

A climb, list or spray climb page shows one store, picked in the browser after
it loads: Google Play on Android, the App Store on an iPhone or iPad, both on a
desktop. The HTML itself always has both store links. Those pages are stored at
the Cloudflare edge for 24 hours with no user-agent split (`docs/cloudflare.md`),
so the HTML cannot be about whoever asked for it first. A crawler, and a reader
with JavaScript off, gets both.

**`utm_medium=qr` changed meaning with #6027.** Before it, every gym-page Play
link said `qr`, whether or not a code was scanned. After it, `qr` means the page
was reached from a printed code and a plain click on a gym page says `web`.
Annotate the deploy date and do not compare `qr` counts across it. The 3 tagged
installs in the 28 days before the change are gym-page clicks of unknown kind.

The Capacitor retirement screen keeps its bare store URLs. It sends someone who
already has the app to update it, which is not an install.

### The iOS Smart App Banner

Www pages carry an `apple-itunes-app` meta tag (root layout, #6027;
`packages/web/app/lib/smart-app-banner.ts`), so Safari on an iPhone or iPad
shows its own banner: "View" for someone without the app, "Open" for someone
with it, handing the app the page's URL without its query string.

Two groups of pages differ. `/kiosk/*` and `/embed/*` have no tag: a kiosk is a
gym's wall display and an embed sits inside someone else's site. `/auth/*` has
the tag without a URL to hand over, because a reset link is nothing without its
query string and the app's reset screen reads one without it as invalid.

**Its taps cannot be counted.** Safari fires no event when the banner is shown
or tapped, so there is no `App Install Click` for it.

**Its downloads can, once the provider id is set.** The tag carries the
`site-banner` link id as a campaign token (`affiliate-data=ct=site-banner`, plus
`pt` when `NEXT_PUBLIC_APP_STORE_PROVIDER_ID` is set), the same way a store
button does, so App Analytics lists them under the `site-banner` campaign after
5 first-time downloads. Not yet confirmed: no banner download has been seen in
App Analytics. Until one is, a rise in iOS downloads with no matching rise in
`App Install Click` is the banner.

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
| `NEXT_PUBLIC_APP_STORE_PROVIDER_ID` set | App Store campaign links start counting in App Analytics |
| #2644 PR A backend deploy | `Active Users Snapshot` starts (first event the morning after). Backend events stop carrying a user: Live Activity events and `Tick Climb Not In Catalog` get a random distinct id each, so distinct-person counts on them stop meaning anything |
| #2644 PRs B and C ship | PostHog capture needs consent: people-based counts drop to the consenting subset (see "Active users") |

None of these repairs past data. Annotate them; do not backfill.

## Growth dashboard extension: October 2026

Dashboard [Growth: monthly baseline](https://us.posthog.com/project/412845/dashboard/2170056)
adds engagement distribution, newcomer progression, acquisition retention and
contribution reporting. Reusable HogQL definitions live in
`scripts/posthog/growth-queries.ts`. This extension uses existing events and
adds no product tracking.

| Insight | Content |
| ------- | ------- |
| Who comes back: board-day distribution | Bucket sizes, population shares, returners and the overall weighted rate. |
| Weighted retention: adjacent 28-day windows | Completed board and app return rates on the fixed grid. |
| Newcomer activation: 28-day preview and 56-day funnel | Ordered registration-to-board-day progression with eligible counts. |
| Acquisition quality: first-touch sources | Independent activation outcomes, observation maturity and source quality. |
| Acquisition cohorts: app retention | Weekly acquisition cohorts returning with a screen view. |
| Acquisition cohorts: board retention | Weekly acquisition cohorts returning with a successful board send. |
| Acquisition cohorts: engagement contribution | Completed-period contribution history and shares of the active base. |

The first two extend existing insights; the other five are additions. The Apple
Ads status text card describes missing inputs without inventing acquisition or
cost figures. Existing activity tiles stay on the dashboard.

### Shared population, dates and identity

All product activity uses native production events and excludes internal cohort
`295337`. Count canonical PostHog `person_id`, not event `distinct_id`, devices,
accounts or reported installs. A merged person is counted once; the unresolved
identity splits described above remain a measurement limit.

Calendar reporting uses a fixed 28-day UTC grid anchored to **2026-10-09
00:00:00 UTC**. Intervals include their start and exclude their end. Each
retention observation compares a preceding period with the following,
non-overlapping period. Publish it only after both periods have ended. The
historical trend advances one 28-day period per point; adjacent observations
reuse a period as the previous point's return period and the next point's
starting period, so trend points are not independent samples.

Native production tags begin on 2026-07-25. Omit retention comparisons whose
preceding period starts before that date: those intervals contain days before
this population was recorded. On this grid, **2026-10-09 is currently the only
fully covered, completed retention point**. The trend gains its next point on
2026-11-06; it must not fill earlier points with incomplete legacy coverage.

Default activity reporting covers 168 days. The daily view retains activity
from the latest fixed-grid boundary minus 168 days, so the raw refresh can cover
up to 195 days and never truncates the oldest complete reporting period.

The newcomer registry retains up to 365 days of acquisitions and their native
activity. This allows all six 28-day age intervals to mature before people age
out; source-quality totals cover this same acquisition horizon. Older or unclean
people remain in the existing/unclassified contribution group. The versioned
`ACQUISITION_HISTORY_DAYS` constant can extend longer comparisons. Each matrix
has at most 53 weeks × 6 intervals, within its explicit 400-row bound.

Event scans are bounded by dates and event names. Newcomer first-ever checks inspect
older events only for candidate identities; they must still check every library
and environment. The
`growth_native_person_days` view aggregates daily activity;
`growth_native_newcomers` holds first-ever acquisition, cohorts and milestones.
Both shared views are materialized and refresh daily. Show the refresh time
and do not label incomplete periods as final.

### Engagement distribution and weighted retention

A board-active day is a UTC calendar date with at least one `Climb Sent to Board
Success`. Multiple sends on one date count as one day. A successful Bluetooth
connection alone does not count. Buckets are mutually exclusive: 1, 2–3, 4–7
and 8+ days in the preceding period.

The bucket table shows unique people, share of all preceding-period board-active
people, returning people and return percentage. A return is at least one
successful send in the following period, irrespective of its frequency. The
overall row and trend use **sum(returners) / sum(previous-period people)**;
averaging the four bucket percentages gives the wrong denominator.

Verified baseline: preceding **2026-08-14 to 2026-09-11**, return
**2026-09-11 to 2026-10-09**, all endpoints at midnight UTC.

| Previous board-active days | People | Population share | Returned | Return percentage |
| -------------------------- | -----: | ---------------: | -------: | ----------------: |
| 1 | 870 | 42.88% | 343 | 39.43% |
| 2–3 | 678 | 33.42% | 437 | 64.45% |
| 4–7 | 371 | 18.28% | 299 | 80.59% |
| 8+ | 110 | 5.42% | 107 | 97.27% |
| All board-active people | 2,029 | 100% | 1,186 | **58.45%** |

Reconcile these totals with the existing activity and return insights using the
same population and exact dates. The app-retention comparison retains its own
app-active denominator: people with at least one `$screen` in the preceding
period, returning with at least one `$screen` in the following period.

### Newcomer progression and observation maturity

Use first-ever newcomers as defined above, starting **2026-09-07**, after the
documented throwaway-identity regime. Require a first native production `$screen`
and exclude events before it. Exclude people whose first-entry app version is
2.3.0 or 2.3.1. Android candidates use verified released store builds
`2001018` (2.4.0) and `2001108` (2.5.0); maintain that allowlist after confirming
new releases. Newly observed 2.6 builds are not yet verified and do not qualify.
Phantoms and internal people are excluded. Do not replace the first-ever test
with the first production-tagged event or count a returning account's fresh
installation as an acquisition.

The six-stage progression is first app screen, registration, first successful
board send, second distinct board-active day, fourth distinct board-active day,
then a successful send during days 28–55. Registration and board-day milestones
must occur during days 0–27 and in that order. Day 0 is the UTC calendar day of
the first screen; activity on that day still has to occur at or after the first
screen's timestamp. The ordered funnel counts distinct board days after
registration, beginning with the first qualifying send. Show each stage's
people, percentage of entrants, and percentage of the previous stage. The
completed funnel includes only newcomers
whose entire 56-day window has elapsed. A separate first-28-day preview includes
the first five stages for completed first periods; the full funnel remains
pending until its 56-day observations mature.

Registration evidence is `Signup Completed`, or `is_new_account = true` on
`Login Succeeded` / `Login Account Age Resolved`, deduplicated per person.
Recover missing evidence from a valid `person.properties.first_seen_at` account
creation timestamp: shared `buildCohortPersonProperties` writes it with
`$set_once`. Explicit registration evidence takes precedence when it conflicts
with that property. Invalid, missing or out-of-window evidence remains unknown;
an old account timestamp must not turn a returning account into a new sign-up.

Show people with no successful send, plus overlapping subcounts with observed
`Climb Search Performed` browsing or `Bluetooth Connection Success` without a
send. Missing send evidence means **no observed successful board send**, not
proof that the person has never climbed. Browsing and connection success do not
count as board activation or retention. Keep the existing spray-wall activation
definition separate: spray walls cannot emit successful Bluetooth board sends.

As of **2026-10-10**, no clean newcomer cohort has a completed 56-day observation.
Do not publish a zero retention rate for those pending cohorts.

### Acquisition quality and cohort retention

Group newcomers by acquisition week (Monday UTC). Retention periods are relative
to each person's acquisition day, not calendar reporting buckets. App retention
requires `$screen`; board retention requires `Climb Sent to Board Success`.
Both matrices show full cohort size and retention percentage. Their linked
“Acquisition retention: eligible and retained cohort counts” table shows the
exact eligible and retained people for each 28-day age period. A cell's denominator includes only people whose full
period has elapsed; immature cells are pending. People with no board day remain
in the eligible board-retention denominator.

Source comparisons show newcomers, registration conversion, first-send
conversion, 2+ first-period board-day conversion, exact Day-28 app and board
retention, days-28–55 app and board retention, and mean first-period board-active
days. Mean board days includes zero-day people. Source conversions measure
independent outcomes among all eligible newcomers; board outcomes do not require
the ordered funnel's registration stage. First-period outcomes use newcomers
with a completed first 28-day period; exact Day 28 requires completion
of that UTC day, and subsequent-period retention requires all 56 days. Label
app and board return definitions separately.

First-touch attribution chooses the earliest meaningful acquisition-linked web
landing or timestamp-matched install evidence, independently of later campaign
interactions. Play attribution is eligible only when immutable
`install_begin_timestamp` is within the 24 hours
before `first_native_at`, the earliest native production event (not the first
screen). Older-install referrers remain unknown for this acquisition. The live
www schema does not yet carry UTM event properties; parse verified
`$current_url` at the earliest linked landing when it carries meaningful attribution for initial tags and
use acquisition-linked referrer evidence. Do not assume UTM event properties
exist or assign an unrelated later web campaign to a native acquisition. Keep
the evidence and campaign fields beside the derived source.
Sources are verified Reddit/community, known organic store discovery, Apple
Ads, direct/unknown, and other identifiable sources. Known Android organic
discovery is distinct from unknown iOS acquisition. A missing referrer, iOS
device, store-button click or App Store campaign aggregate proves neither an
organic install nor an Apple Ads acquisition.

### Contribution and Apple Ads readiness

The cohort-contribution table groups by acquisition cohort and completed
calendar activity period. It shows board-active people and their share of all
board-active people in the same period, board-active person-days, successful
board sends, `Tick Logged` events, submitted grade ratings, submitted quality
ratings and `Climb Created` events. These are observed contribution counts,
not unique published climb or database-record counts. Tick events with
`hasDifficulty = true` or `hasQuality = true` count the respective rating
submissions. Report draft creations separately; a creation event does not prove
publication, and later draft publication cannot yet be counted reliably.

The Apple Ads status card prepares the dashboard without fabricated metrics.
The new 2.6.0 integration's property and report contract is documented in
[Apple Ads (iOS)](#apple-ads-ios); it still requires real campaign evidence
before these dashboard metrics can be populated.
The proposed **A$500/month** is a budget, not observed spend. Keep actual AUD
spend, store-reported installs, attributed first opens and product outcomes
separate until reliable person-level attribution exists. Future costs divide
matching campaign/cohort spend by attributed installs, registrations, first
board-active people, people reaching 2+ board days, or retained board-active
people in days 28–55. Retained-user costs use only mature acquisition cohorts.
Campaign, keyword and country breakdowns require corresponding attribution and
cost evidence; country on an activity event alone is not ad targeting evidence.

Missing inputs and known limits:

1. Person-level Apple Ads attribution, campaign/keyword/country evidence, and
   actual AUD spend and install reports are unavailable.
2. iOS has no install referrer; reliable anonymous web-to-iOS acquisition joins
   and known organic App Store attribution are unavailable.
3. Remaining unresolved registration evidence and historical phantom identities
   can undercount registration or split people. Validate evidence coverage.
4. Unique published-climb identifiers and draft-to-publication evidence are
   missing. Creation-event counts must not be called unique published climbs.
5. Completed 56-day clean newcomer cohorts do not yet exist. Older acquisition
   regimes and incomplete windows must not fill the gap.

### Versioning and validation

Export the reproducible definitions with
`vp exec node --import tsx scripts/posthog/export-growth-dashboard.ts`. The export
includes two materialized views, four existing-insight updates, five dashboard
additions and three saved detail insights. `deployment.json` records their live
IDs; use updates for those IDs rather than creating duplicate insights. Read
`latest_history_id` before a view update and pass it as `edited_history_id`.
After changing a view, run a full refresh and check its status before forcing
insight refreshes. Preserve dashboard membership and all existing tiles.

Export synthetic integration queries with the same command plus `--fixtures`.
Execute those queries through PostHog, then refresh `fixture-validation.json`
with each query's SHA-256 and returned rows. The local test verifies that the
current exact HogQL matches the executed query and checks bucket edges, stale
refresh boundaries, distinct dates, registration ordering, invalid account
dates, first-touch precedence and 28/29/56-day observation maturity. It uses
recorded synthetic SQL results; it does not contact live PostHog during CI.
`live-validation.json` records the independent count reconciliation.

As of 10 October: 452 clean newcomers have complete first-28 observations;
394 registered, 201 sent a climb, and 121 reached two board-active days. The
ordered registration-first funnel has 198 first senders, 119 two-day users and
63 four-day users. Those smaller counts reflect its registration prerequisite.
No one has a mature 56-day observation yet. Latest-period contribution totals
reconcile to all 2,387 board-active people.
