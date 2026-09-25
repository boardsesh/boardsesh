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
  deploy. About 12 Android people a week are still flagged bots by PostHog
  despite the UA, probably Play pre-launch test devices.

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

## Acquisition

These are separate counts. None of them is a funnel of the same people.

| Measure              | Event / property                                         | What it means                                                                                     |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Landing visits       | www `$pageview`, by page group                             | Visits, after the crawler caveats above.                                                         |
| Store clicks         | `App Install Click` (www), by `platform` and `source`      | Someone tapped a store button. Not an install.                                                    |
| Android install source | person property `install_channel`, event `Install Attributed` | From the Play Install Referrer, once per install. `campaign`, `organic` or `unknown`.              |
| iOS install source   | none                                                       | Apple gives us no referrer. Show iOS as unknown; do not infer it.                                 |
| New-user activation  | the Activation funnel above                                 | Counts people, not installs.                                                                      |

`Install Attributed` fires whenever the Play referrer has any `utm_*` param.
Play stamps organic installs too (`utm_source=google-play&utm_medium=organic`),
so 584 of the 663 people who fired it from 2026-08-23 to 2026-09-19 were
organic. It also fires on the first launch of an older install that never ran
the referrer code, so it is not a new-install count. Count campaign installs
with `install_channel = campaign` (sent from the #5653 fix onward); filter new
installs on `install_begin_timestamp`.

## Retention

Weekly or monthly, with the start and return events named on the tile, the
internal cohort excluded inside any SQL, and only cohorts old enough to have
finished the period shown as final. Mark the current, unfinished period.

## Dates to annotate in PostHog

| Date       | Change                                                          |
| ---------- | --------------------------------------------------------------- |
| 2026-07-25 | Native events start carrying `environment` (legacy binaries never do) |
| 2026-09-11 | Known crawlers stop booting the www client (#5388)              |
| #5653 deploy | www and browser app send `$raw_user_agent`; `install_channel` added |

None of these repairs past data. Annotate them; do not backfill.
