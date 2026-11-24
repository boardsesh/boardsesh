# Board app search pages

These are indexable marketing pages: `/apps`, eight `/apps/<board>` pages, and
`/compare/spray-wall-apps`. They answer broad app/download/compatibility searches
with a recommendation, factual comparison and switching limits. One canonical URL
per board also serves alternative and "best app" searches. `/boards` remains the
layout directory; `/spraywalls` remains the setup page.

## Publication contract

- The main content, links, ratings and comparison are in server-rendered HTML.
  Each guide starts with a board-specific recommendation, then a concise comparison
  and sections about using the app during a session. Jump links lead to the comparison,
  session details, compatibility, downloads and sources. The hub links to the board
  guides before asking readers to install. The publisher is identified near the lead.
- Only English is published. The other five catalogs contain the same English
  keys for catalog completeness, not translated pages. Metadata and the new
  sitemap shard advertise only English. Localized aliases redirect temporarily
  to English without changing the visitor's language preference.
- Product claims come from current code and linked primary sources. They do not
  imply a physical board was tested for this article. MoonBoard controller limits
  and one-way imports are explicit. An undocumented competitor feature is not
  described as absent. The Kilter guide attributes dated climber reports about
  import waits separately from Kilter's published estimate.
- App Store ratings are an app-wide, storefront-specific snapshot with a count,
  date and direct source. They do not establish board-specific superiority. No
  imported `Review` or `AggregateRating` rich-result markup is emitted. Existing
  cached community activity figures retain their own scope and fallback.

The PR author owns initial verification. Boardsesh maintainers check the sources
and App Store snapshot monthly and after relevant app/controller releases. Editorial
changes update the guide date; source and rating dates change only after checking
those claims. Pages never depend on
an App Store request at render time. The registry and catalogs hold the evidence;
`app-guide-pages.test.tsx` verifies the server output and metadata.

## Search Console comparison

The prelaunch exact-query and app-family extracts are in `search-console-baseline.json`. They cover
August 20 through November 20, 2026, final data. Missing reportable rows do not
prove zero impressions. Do not compare its tiny average positions as a stable
ranking baseline. There is no ranking or traffic forecast.

For each report, use final data for `sc-domain:boardsesh.com` and the same dates,
search type and query definitions. Fetch every page of rows. Keep worldwide and
US (`country equals usa`) as separate reports; US is already inside worldwide.
Record the release date and each URL's first confirmed index date after release.
Do not backfill these with the date the code was written.

Use these query filters (RE2), case-insensitively:

1. Broad exact app terms: `(?i)^(kilter( board)?|tension( board)?|moon[ ]?board|decoy( board)?|touchstone( board)?|grasshopper( board)?|so[ -]?ill( board)?|woods( board)?|spray[ -]?wall) apps?$`
2. Board/app family: `(?i)(kilter|tension|moon[ ]?board|decoy|touchstone|grasshopper|so[ -]?ill|woods|spray[ -]?wall).*app|app.*(kilter|tension|moon[ ]?board|decoy|touchstone|grasshopper|so[ -]?ill|woods|spray[ -]?wall)`
3. Comparison subset: use filter 2 AND `(?i)best|alternative|compare|comparison|versus| vs ` on the query dimension.

For OpenSEO, which exposes contains/equality filters rather than regex, fetch
`query contains app`, paginate to completion, then apply the board-family and
comparison expressions to the returned query keys. The checked-in family extracts
used this method, with both dimensions below and separate US/worldwide requests.
The regex filters can also be used in Search Console directly.

For each group, query once with dimensions `["query"]` for whole-site traffic,
and once with `["query", "page"]` for landing-page allocation. Report clicks and
impressions together. A guide gaining clicks while the homepage loses the same
number is redistribution, not additional acquisition. Query/page totals can also
differ because Search Console withholds some rows; retain that caveat. Do not sum
overlapping query groups.

Check indexing after deployment; then compare complete 28-day and 56-day windows,
accounting for first-index dates, reporting lag and small samples. A first-index
date requires actual inspection, not presence in a sitemap.

## Observed website outcomes

`scripts/posthog/seo-app-guide-queries.ts` contains the reproducible HogQL builder
for PostHog project 412845. It reuses the existing `$pageview`, `App Install Click`
and `Web App Opened` events. New finite `compare-*` placements also go into store
campaign links. Capture still uses the existing consent, host and bot guards.
No new identifier, consent counter or native attribution join is introduced.

The unit is a distinct observed browser session with a Google-referred first
observed pageview. The query reads a one-day entry lookback, excludes explicit
paid click IDs/media, and counts outcomes only at or after the landing within the
same session and reporting window. The final day is therefore outcome-censored;
use completed windows. Missing session IDs are excluded. Referrer stripping and
consent mean these are observed sessions, not all organic visitors.

The denominator and numerator use the same captured population. A session with
repeated store clicks counts once; a store click plus a browser open also counts
once in `action_sessions`. Store clicks and browser-open clicks are intent, not
verified installs or successful app loads. Never divide these counts by Search
Console clicks. Consent coverage is unknown.

The query excludes internal cohort 295337, known bots and the existing www crawler
rules from `docs/analytics/growth-metrics.md`, except its outcome-dependent US
Windows rule. Those short Windows/Chrome visits remain in the primary denominator
and its outcomes regardless of whether they click a store, open the browser app
or leave. `possible_automation_sessions` flags them without removing them. This
avoids excluding non-converters based on the outcome being measured. Other
heuristics can still remove real visitors. Only primary Google search hosts count;
Google product referrals such as Gmail and Docs do not. The fixture validates repeated events, cross-session and
before-landing actions, paid/direct/spoofed referrers, bots, missing session IDs
and retained existing-site traffic, including identical Windows visitors taking
each of the three actions. `seo-app-guide-validation.json` records the
exact executed fixture hash plus a bounded production syntax/field probe.

The result keeps each new page and `existing site` separate. US and outside-US-or-
unknown rows are disjoint; their sum is the observed worldwide total. Inspect
store placements separately when diagnosing which button was clicked. No
dashboard, scheduled report, outreach or tracking subscription is created by
these code changes.

Direct guide landings and same-language SPA navigation retain the existing
allowlisted inbound store campaign tags. A real document-language change reloads
the page and resets in-memory tags, as other language switches do. The new pages
do not promise cross-language campaign continuity.
