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
| Windows crawler, arm 1 | UA contains `Windows NT` and `Chrome/15x`, exactly one pageview, and its referring domain is `www.boardsesh.com` | 645 |
| Other self-referred single page | exactly one pageview whose referring domain is `boardsesh.com`, any other UA | 8 |
| Windows crawler, arm 2 | UA contains `Windows NT` and `Chrome/15x`, country `US`, at most two pageviews, no `App Install Click` | 94 |
| Kept | everything else | 274 |

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
| 2. Lit or ticked a climb | `Set Active Climb` or `Tick Logged` | `boardType = 'spray'` |

Ordered, unique people, native production, internal cohort excluded, both steps
inside 7 days of the first-ever `$screen`.

"Lit" on a wall with no lights is `Set Active Climb`: the climber made a climb
the one on the wall. "Took" is `Wall Taken`, the "I'm on it" turn on a wall
with no light kit.

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
definition; count it as its own measure. Its `boardLayout` is the empty string
on a spray wall, which is an accident of the layout table and not a classifier.

## Acquisition

These are separate counts. None of them is a funnel of the same people.

| Measure              | Event / property                                         | What it means                                                                                     |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Landing visits       | www `$pageview`, by page group                             | Visits, after the crawler caveats above.                                                         |
| Store clicks         | `App Install Click` (www), by `platform` and `source`      | Someone tapped a store button. Not an install.                                                    |
| Android install source | person properties `install_source` / `install_medium` / `install_campaign`, classified with the expression below | From the Play Install Referrer, once per install. `campaign`, `organic` or `unknown`. |
| iOS install source   | none                                                       | Apple gives us no referrer. Show iOS as unknown; do not infer it.                                 |
| New-user activation  | the Activation funnel above                                 | Counts people, not installs.                                                                      |
| Android link id      | `utm_content` inside person property `install_referrer_raw` ("Link ids on Android installs" below) | Which published link an install came from. Empty until www links carry one. |
| Sign-ups             | `is_new_account = true` on `Login Succeeded` or `Login Account Age Resolved` ("Counting sign-ups" below) | New accounts, native only. |

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
  and none of them has a `utm_content`, because no link we publish sets one
  yet. The www store-link change in #6027 is what fills it. The same
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
| #6027 mobile OTA | `Login Account Age Resolved` starts; login events carry `provider` and `account_age_read`; `Tick Logged`, `Set Active Climb` and `Climb Created` carry `boardType` |

None of these repairs past data. Annotate them; do not backfill.
