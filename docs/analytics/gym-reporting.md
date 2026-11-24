# Gym Insights reporting contract

Gym Insights shows recorded Boardsesh board activity to staff. Access starts with the gym-edit gate and checks each board independently. A gym role gives no access to a private, unlisted, revoked, hidden or deleted board. A private configuration stays private when staff group it with a public configuration. The GraphQL endpoint returns counts and authorized climb references. Account IDs used to deduplicate counts stay inside the database.

## Open the dashboard

In the app (iOS, Android and Expo web), open **More → Gyms you run → Gym analytics**.
The gym page also offers **Staff tools → Gym analytics**, opening the same in-app
dashboard for that gym. Both entry points require gym edit access. On www, open
the gym's **Manage → Insights** tab (`/gym/[gym_slug]/manage?tab=insights`).

Set the gym's reporting time zone to activate the forward history coverage used
by return rates and busy times. When unset, the app shows reporting settings
above the report. This does not backfill unknown venue or occurrence evidence.

The app receives these changes through the normal staged OTA release process;
a merged mobile PR alone does not confirm delivery to an installed app.

## What counts

| Measure | Eligible records |
| --- | --- |
| Recorded climbers | Distinct identified accounts from a qualifying Boardsesh display or native tick, including attempts. One account is counted once across sources and selected boards. A display identifies the controlling account. An account whose identity is hidden in that board context contributes no identified-person count. |
| Confirmed displays | Persisted Boardsesh reports after the existing sustained-presence gate. Reports from deleted accounts may still count as displays. Kilter history and the Redis-only feed are outside the series. |
| Logged sends | One canonical native flash or send tick per distinct tick UUID. Synchronized upstream copies and imported logs do not count. A native tick remains native when upstream sync links to it. Separate repeat sends count, and attempt counts never multiply a send. |
| Tick activity | Authorized, explicitly attributed native attempts, flashes and sends. Unverified layout or feed fallback is never evidence of a venue. |

Native tick attribution is recorded after the backend verifies the named board UUID, matching presence board, persisted participation at the matching session wall, or an explicit compatible board edit. Retry deduplication remains the tick UUID. GraphQL clients that omit the timing metadata can still log and edit ascents. Their ticks have unknown reporting precision until an explicit supported time edit. Existing ticks with neither verified board provenance nor gym capture stay outside the gym series. Dated imports stay in the logbook without being attributed to its currently selected board.

A confirmed Boardsesh display receives its occurrence timestamp and original board/gym under the locked board sequence reservation. Durable confirmation is the reporting instant. Legacy Boardsesh reports used server UTC for `confirmed_at`, so their hour is usable when the board's provenance can be established. Clone merges could move legacy events into system listings without an original-board pointer. Legacy events for those listings and known serial-dedupe survivors are excluded when the original board cannot be independently established. Prior unknown display identity and deleted or currently anonymous accounts do not enter person cohorts. Moving an imported or anonymous event into another scope never identifies a person.

## Time and coverage

Reporting uses the gym's saved map location to determine an IANA time zone automatically when staff have not chosen an override. Existing gyms, newly created gyms and imported gyms use the same lookup. A coordinate change updates the automatic zone; an explicit staff choice remains authoritative. Clearing the override returns to automatic detection. The inferred zone is checked against PostgreSQL's supported IANA zones and is not written into the override column.

If a public, listed gym has only an address, an authorized report can resolve it through the address lookup provider before entering the reporting transaction. A single valid result supplies temporary location evidence bound to that exact address. It does not rewrite the gym's map coordinates or its staff override. Reports and forward activation recheck the address and public/listed state before using it. Private or unlisted gym addresses are never submitted automatically; staff can use a saved map pin or a manual time-zone override.

Missing, invalid, `(0, 0)`, ocean or ambiguous coordinates, an ambiguous address, unavailable provider or exhausted request budget leave the zone unconfigured with an explicit UTC fallback. Automatic location resolution can activate the existing forward observation contract, without backdating it or inventing historical activity. Changing the reporting zone changes bins and boundaries. Stored occurrence evidence and the logbook date are preserved. Local-only downstream metrics must indicate when the gym zone is unconfigured.

### Address lookup operations

The default is the same OpenStreetMap Nominatim search used by the web map picker, with `GYM_GEOCODING_URL` allowing an operator to switch providers without changing clients. The map picker uses an authenticated explicit Search/Enter request, rather than querying as someone types. Both automatic report lookups and submitted map searches share the backend's Redis cache and request admission. The report's automatic path only runs after gym authorization; it never performs HTTP inside a database transaction or while holding the activation lock.

The [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) limits application traffic to one request per second, requires identifying requests, attribution and caching, and forbids autocomplete. The shared budget admits at most one request every 1.1 seconds, with a separate per-address lease to avoid duplicate concurrent requests. Successful coordinates are cached for 30 days, missing or ambiguous results for 24 hours, and transient provider failures for five minutes. Budget contention is not cached as a negative result. Redis absence disables provider requests instead of creating an uncoordinated fallback. No sweep or recurring geocoding job is introduced.

Provider queries use a four-second deadline, an identifying Boardsesh User-Agent and no redirects. Address keys in Redis are hashes; outgoing HTTP tracing is suppressed and its breadcrumbs are isolated so raw addresses do not enter later diagnostics. The authenticated GraphQL map-search operation also suppresses address-bearing diagnostics. The report settings and map picker show OpenStreetMap attribution. Typed manual searches are deliberate submissions to the disclosed provider; they are separate from automatic lookup of stored public gym addresses.

Every report has one `asOf` UTC instant. For a selected 7, 30 or 90 days, convert `asOf` to the gym's local clock. The current window starts at that local clock minus N calendar days and ends at `asOf`. The previous window starts at the same clock minus 2N calendar days and ends at the current start. Both intervals include the start and exclude the end. Daylight saving changes can change their elapsed hours. PostgreSQL resolves repeated local cutoffs with the offset after the change and nonexistent cutoffs with the offset before the change, moving them forward by the gap. The current window ends at the original `asOf` instant even when its local clock is repeated. Boundaries are returned in UTC for display in the gym's configured zone.

An explicitly selected time or live save can carry an occurrence instant. A day-only edit records the author-selected calendar date and its zone, while preserving the actual `climbed_at` value supplied to the logbook. The selected date is validated against the log timestamp in that same author zone. The native writer binds the precision evidence to the exact stored UTC timestamp, including microseconds. Upstream synchronization can change the logbook timestamp. After a change, reporting precision is unknown until an explicit native time edit certifies the new value. An unchanged sync round trip keeps its evidence. PostgreSQL determines the full set of instants in the recorded author date, including either occurrence at a repeated midnight. The saved timestamp must still belong to that date under PostgreSQL's rules. Its time of day gives no additional precision. Only the gym zone defines report windows and calendar bins. A day-only tick counts for an overview only when the entire enclosing author span fits the window. It contributes to a gym-local date bucket only when its whole possible time belongs to that date's actual spans. This also covers zones that fall back to the previous date before returning to the same day. Day-only and unknown-time ticks never contribute to hourly bins. Unknown timing and overlapping boundary days appear in coverage. Future exact values and future dates stay out of metrics. Tick creation, sync and upload timestamps do not substitute for the actual occurrence.

The report gives the earliest eligible display and exact tick observed in the checked interval for the selected scope, where available. The interval is the preceding 365 elapsed days, including `coverage.observedSince` and excluding `asOf`. A missing date means there is no qualifying exact observation in that interval. These dates give no evidence of coverage before the checked interval and cannot justify historical zeros. A report with no proven activity tells the viewer about these coverage limits. The dashboard snapshot is refreshed on demand from the primary database. Indexed source scans run over the selected active, independently authorized board IDs and period. The earliest-observed probes use both bounds of the checked interval on each board and source index before taking the first permitted record.

### PostgreSQL calendar support

Reporting uses the standard IANA timezone files read by the database. The calendar samples UTC offsets at one-hour intervals over the needed civil-date spans, searches changed intervals to the UTC second, and intersects the resulting constant-offset segments with the requested civil dates. This handles shortened, repeated and skipped dates without converting a single ambiguous midnight into a date boundary.

The supported ISO civil inputs use timezone files with integral-second transitions more than one hour apart and offsets strictly within ±36 hours. The artifact audit enforces those limits and checks full 400-year POSIX-footer recurrence and the transition from explicit records to the footer. The runtime checks validity of named zones and the geometry it observes. Arbitrary substituted timezone files with two cancelling subhour transitions are outside this contract. PostgreSQL's timezone bytes come from its configured system root or bundled timezone directory. App-host and viewer timezone data do not establish the rules.

Backend CI audits its disposable PostgreSQL service. The portable and seeded image smoke tests audit the exact image bytes separately. For a local disposable PostgreSQL Docker container, run `python3 scripts/audit_reporting_tzdata.py <container> <database>`. It reads only standard timezone-rule files and PostgreSQL build metadata. Its output includes the image reference and config digest, timezone-manifest digest and measured transition and offset bounds. Run it after changing the installed timezone data or the tested image digest. The application needs no new database privilege or runtime configuration.

Raw board/time scans add up to four elapsed days for potentially overlapping date-only evidence. A valid author's actual date bounds that padding independently of the original UTC offset. After source and visibility filtering, the SQL shares projection work across distinct date/zone pairs and bounds it to 24,000 author offset samples plus 8,000 destination-zone samples. A changed bracket requires at most twelve extra steps. Unusable or uncomputed author periods remain timing uncertainty so they cannot produce new exact record counts. If only the gym-local date proof is missing, a well-dated record can still count in an enclosing absolute window. Exact instants do not depend on that work.

## Busy times

Busy times uses the 90 nominal calendar dates before today in the configured gym time zone. The overview's 7/30/90-day control does not change this interval. An authorized physical board selection applies to both. Named gym-local reporting is required even when the overview can still run with its labelled UTC fallback.

A covered date must have real elapsed time and must have begun at or after the observation start shared with the Reach report. It must already have ended at the response's as-of instant. A floor that lands within either occurrence of a repeated midnight excludes that entire date. Covered dates with no qualifying people remain in the denominator. A skipped date and a nonexistent hour contribute no eligible period. A partly present hour contributes one eligible period. A repeated hour combines both occurrences, counts each identified climber once and contributes one eligible period.

Weekday bars average identified person counts across all covered dates of the weekday. A qualifying display or logbook tick can count once per person across boards and sources, even if logged as an attempt. Date-only records count for the day when their whole possible occurrence time fits one gym-local date. The heatmap averages identified person counts per eligible date and local hour. Only verified occurrence instants enter it. An old or delayed upload never substitutes upload time for occurrence. Unplaced or unknown-time identified records can limit what is shown. A saved timestamp without any provable occurrence date cannot rule a log in or out of these dates. The report flags this evidence separately without assigning it to a cell or counting it as dated data. When some precise evidence exists, zero means zero qualifying precise records for that cell.

The chart lists the local dates, scope, evidence and denominators. An empty history, insufficient hour-level evidence and a recorded zero have separate states. The busiest summary uses the same rounded values displayed in the chart, with ties resolved by Monday-to-Sunday order and then local hour. It describes recorded Boardsesh use and supplies no occupancy, visitor or forecast estimate. The visual and numeric views stay within the same staff-authorized report and cache verification rules.

## Venue and physical board identity

The dashboard consistently requires current access to an active board linked to the canonical gym. Confirmed display snapshots and the native tick's gym at acceptance are checked against that canonical venue, including recorded duplicate-gym merges. A board captured while unlinked has a known null gym. It cannot gain a venue retroactively when linked later. Known snapshots from a prior gym cannot move into the new gym's history. A departed board stops appearing in the original gym. Historical results are partial if deletions, resource privacy or uncertain merge origins take records out of scope.

An exact tick occurrence time does not establish time-of-occurrence gym membership. Qualified ticks and trustworthy legacy display rows without a venue snapshot are labelled activity on boards currently linked to the gym. A re-attachment to the same gym can restore access to earlier eligible records captured for that same venue. These records never imply total gym attendance, duration of visits or reconstruction of wall membership.

Gym owners and admins can confirm that two independently readable configurations of the same LED board type represent the same physical wall. They can remove a mistaken relationship. Each verification records its actor, date, gym, root and configuration. The association groups the configurations only while both are active, authorized and linked to that gym or its canonical merge survivor. A real detach or move automatically revokes the old verification, including a leave-and-return in one transaction. The audit records the automatic revocation without assigning an actor. A board that returns needs fresh staff verification. A duplicate-gym merge moves the association to the canonical venue without revoking it, provided the merge pointer is written in the same transaction. Grouping never relies on board family, layout, angle, a shared serial or the presence of two boards in the same gym. Ordinary deletes stay deleted. A serial-dedupe tombstone can point at a survivor, but that pointer cannot grant access to the original source's activity. The survivor's independently captured activity is unaffected.

## Climbs, angles and detail rows

Activity joins on canonical climb aliases within the same board type. Historical records retain their own angle. Ticks retain their own mirror flag, and an older display with no orientation keeps it unknown. The legacy overview top-climb list pools orientations and preserves the original climb and angle response fields. Variant-based engagement and inventory comparisons maintain the documented type, climb, angle and mirror identity. The selected board's current angle does not replace a missing or invalid historical angle.

Authorization and attribution decide historic totals, reach, trends and busy-time activity. Retiring a climb or archiving a spray-wall reset does not remove otherwise authorized activity. An absent or restricted climb can never become an unauthorized detail row, even when a proven readable wall allows its old activity in aggregate. Current-inventory filters are reserved for grade inventory and active spray-wall rankings. LED engagement and angle reports work without a playlist or collection. Quiet-climb recommendations apply to spray walls only.

### LED board angle usage

Angle usage is reported separately for each physical LED board in the current window. Only independently readable, LED-equipped configurations contribute. Verified aliases can combine activity from several configurations of a physical board. The saved angle on the display or tick supplies the observation. The recording contract accepts 0–90° over supported LED models, with Grasshopper also accepting −5°. Picker rails, catalogue grades and current installation settings do not establish an event's historical capability. For example, a qualifying Woods tick recorded at 41° is a known-angle observation. The report describes recorded use. It supplies no measurement of wall position or list of angles available today.

Each angle counts distinct identified people across the qualified sources, including native attempts. The denominator is the distinct sample of identified people with at least one compatible recorded angle on that physical board. A person can appear in several numerators and once in the denominator, so the percentages can overlap. Climber-days count each identified climber once for each provable gym-local date at that angle. A tick can fit the selected window and still lack a provable gym-local date. Logged sends and confirmed displays use the shared source definitions, and are shown separately. Missing or unsupported angle values remain in an unknown activity count outside the rankings and the sample. All comparisons use the same gym-time window, reporting snapshot and coverage as the overview.

The staff dashboard uses the activity people chose to create as part of the product and does not enable tracking, write named telemetry, or change [product analytics consent](analytics-consent.md). A separate proposed public summary may live on the existing canonical gym page. It needs its own opt-in, independently publishable resource and activity rules, suppression, revocation and cache controls before any metric is released publicly. Staff Insights remains authenticated and `noindex, follow` with no sitemap entry. The clients hold reports in memory for the active account and scope, with a five-minute access verification window. When access needs revalidation, a reachable client checks again and an offline client hides the expired report. Typed access denial cancels and purges matching cached reports.

## Reach, return and weekly trends

The five overview cards use the selected gym or physical board and the two equal local-calendar periods above. Climbers recorded counts distinct identified accounts from qualifying displays and native logs, including attempts. First recorded here checks all earlier eligible records for those accounts, including records older than the two periods and older than the 365-day descriptive check. It means first in the records available to that report. A late earlier record can lower that count. When date precision cannot place an earlier record with confidence, its climber is listed in the number of uncertain classifications.

Came back divides the intersection of current and previous climbers by the number of previous climbers. A climber with older history who missed the previous period does not enter that numerator. Comparing against the previous return rate uses an additional immediately preceding period of the same local-calendar length. Rates require complete comparable underlying cohorts and a positive denominator. Percent change also requires a nonzero previous value. The sends card reports distinct loggers separately. Sessions are days with a send, once per identified climber on each definite gym-local date across all selected boards. A send with no definite gym-local date can count as a send without establishing a session.

The weekly chart always shows the last twelve gym-local Monday-to-Sunday weeks, independently of the overview range. The latest week ends at the report's as-of and is marked in progress. Zero means the eligible count in a covered slot is zero. Unavailable means the report cannot establish a zero. A visible positive count can have partial timing or attribution evidence. The selected bar gives its exact recorded count and calendar dates.

The backend stamps an immutable forward observation start in PostgreSQL on the first authorized report for a configured gym with a readable selected board. The activation write rechecks permission and accepted venue IDs. A response only uses receipts committed before its reporting snapshot and as-of. A canonical gym's floor is the latest from every accepted original venue. If a merged venue has no receipt, it starts at the actual activation time. The floor describes continuous availability of qualifying stored records under the current version for the selected authorized scope. Qualified captured records for unrelated or unlinked venues remain out even if a board later returns. An ordinary current-board attribution label does not by itself make a window temporally incomplete. Relevant unknown times, boundary-spanning dates and legacy records without independent venue capture limit the affected metrics. Only attested evidence constrains occurrence time. An unbounded eligible log can affect every nonempty window, even when its logbook stamp is years earlier. Distinct cohort coverage is assessed per person per window. An extra uncertain record adds no reach gap once that person is definitively recorded in that window. An unbounded attempt does not reduce send coverage. Scope and privacy are checked before both windows. Edits, deletions and late uploads still change the next report.

Recent activity is aggregated in SQL over the older of the three selected periods or the twelve-week chart. First-recorded probes restrict the board and identified candidate before touching earlier activity. Indexed existence checks can prove prior instants and older certified authored dates from the audited timezone envelope. The full civil-date proof runs only in a four-day candidate band at each first-recorded cutoff. Certified author days that exceed the calendar work budget use their audited possible interval as uncertainty. Missing or mismatched evidence is checked for remaining first-recorded candidates with a board/user existence probe. Window coverage uses a separate partial board index to check the scoped unbounded tick evidence without projecting historical calendars. The descriptive 365-day exact observations are independent of these probes and the observation floor.


### Deployment

Before applying the journaled reach migration to an existing deployment, prebuild both same-name indexes concurrently using the columns and predicates in the migration. The names are `boardsesh_ticks_reporting_unbounded_idx` and `board_climb_events_reporting_actor_time_idx`. Verify that both indexes are valid before the migrator runs. This keeps the index builds off the migrator's write-blocking transaction. Fresh databases build both indexes through the migration.

## Grade comparison and spray availability

Grade comparison is a private staff snapshot. Each selected installed board
contributes either its active spray-wall inventory or its compatible chosen
LED playlist. Current feeds, busy times and engagement use their own scope.
The report verifies access to a private playlist on every read, including for
a staff member who could see the board but can't access its selected playlist.

A current variant is the canonical climb, actual angle and original
orientation. An LED playlist's saved angle takes precedence on an adjustable
board, and a legacy row without an angle uses the board's angle. A fixed
installation includes rows at its angle. Supply counts each compatible variant
once per verified physical installation. A send must come from the exact
logical configuration that offered the variant. Both series use the same
current exact-angle reference grade. Their percentages divide by the visible
inventory and send totals separately.

Spray exposure starts at the first successful fenced observation of a
published, visible, intact variant on its current board and active published
photo version. Owner-only walls are outside the shared venue inventory.
A writer can stop the measured interval. After a change, new measured
availability needs another coherent observation. Gaps are unknown and prior
intervals remain available to eligible Quiet climbs reports. A reset clone
starts its own history. These timestamps record observed availability, with
no assumption about when a setter installed the climb. Exposure records
contain spray variants only.

Availability and history are read from bounded results. Scope or history
overflow never yields a partial denominator. Missing exposure does not hide a
valid current grade comparison. Both clients recheck private grade and picker
results after foregrounding, reconnecting or changing scope, and retire each
receipt after five minutes.

The web database login reaches the source writers but has no direct access to
the comparison mapping, exposure records or sequence. The auth fence verifies
the complete exposure trigger, function and journal dependency set before it
approves the new writer path.
