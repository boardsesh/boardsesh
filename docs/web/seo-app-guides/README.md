# Board app search pages

These are indexable marketing pages: `/apps`, one page per board app
(`/apps/kilter`, `/apps/aurora`, `/apps/moonboard`, `/apps/woods`) and
`/compare/spray-wall-apps`. Tension, Decoy, Touchstone, Grasshopper and So iLL run
builds of the same Aurora app, so they share `/apps/aurora`, with an anchored
section per brand. Their old `/apps/<brand>` URLs 308 to `/apps/aurora#<brand>`
from `next.config.mjs`. A localized alias takes two hops and ends in the same place:
`/es/apps/tension` 308s to its locale twin `/es/apps/aurora#tension`, which the
middleware 307s to `/apps/aurora` (the browser keeps the `#tension`); `/zh-CN/...`
is 307ed to English first, then 308ed. The hub keeps a
tile per board brand; the Aurora tiles link to their section. One canonical URL per
page also serves alternative and "best app" searches. `/boards` remains the layout
directory; `/spraywalls` remains the setup page.

## Content model and the importer

- Words live in `packages/shared/i18n/locales/<locale>/appGuides.json`, keyed by
  stable ids (`pages.<page>.comparison.rows.<row>.official`). `common` holds the
  page chrome and is edited by hand in `en-US`.
- Structure lives in `packages/web/app/lib/seo/app-guide-registry.generated.ts`:
  verdicts, winners, source ids, source URLs and checked dates, screenshots and
  counts. `app-guide-model.ts` holds the shared types and the competitor display
  names; `app-guides.ts` adds routes, art, help links and the claim gate.
- Writers deliver one JSON file per page in the writer-brief shape. Import them with
  `vp run app-guides:import -- <copy-dir>`. The importer validates length caps
  (cells 90 characters, "Pick Boardsesh if" bullets 80 and starting with the
  climber, FAQ answers two sentences, step text one sentence, meta descriptions 140
  to 155), counts, verdict values (`boardsesh`, `only-boardsesh`, `tie`, `official`,
  or `competitor` on the spray page), source ids, the honesty rule (one row the other
  app wins or ties) and hub link text. It refuses `[PENDING-…]` placeholders unless
  run with `--allow-pending` for a dev preview; `--draft` turns every rule into a
  warning for previews; neither import is committed. It writes the English text to
  all six locale folders (only English is published) and moves a page's "Updated"
  date only when its copy or structure changed.
- An "only in Boardsesh" row must cite a source; without one it renders as
  "Boardsesh does it better". The Google-certified Android contrast is a gated claim
  (`GATED_CLAIMS`): it renders only on the MoonBoard page and only while the
  `grapheneos` source is registered there. `app-guide-pages.test.tsx` enforces both.

## Publication contract

- The main content, links, ratings and comparison are in server-rendered HTML. Each
  page opens with the matchup and a byline that says we make Boardsesh, then the
  verdict ("Pick Boardsesh if" / "Keep the official app if"), what Boardsesh adds, a
  real `<table>` with a verdict per row (cards on phones over the same DOM), a
  session walkthrough, logbook import, an FAQ in `<details>`, "How we compared" and
  one sources disclosure grouped by the claim each source backs.
- Only English is published. The other five catalogs contain the same English
  keys for catalog completeness, not translated pages. Metadata and the
  sitemap shard advertise only English. Localized aliases redirect temporarily
  to English without changing the visitor's language preference.
- Product claims come from current code and linked primary sources. They do not
  imply a physical board was tested for this article. MoonBoard controller limits
  and one-way imports are explicit. An undocumented competitor feature is not
  described as absent.
- The App Store rating is a public, all-storefront sum: `vp run app-guides:rating`
  calls Apple's public lookup for every storefront (300 ms apart), adds up the
  rating counts and takes the count-weighted mean, and its output goes into
  `BOARDSESH_APP_STORE_RATING` with the date. Anyone can repeat it; App Store
  Connect may run a rating or two ahead of the lookup's cache, and the page shows
  the public figure. The line links to the US listing. It is app-wide and does
  not establish board-specific superiority. The
  JSON-LD is WebPage (with `dateModified` and an Organization publisher),
  BreadcrumbList, a MobileApplication for Boardsesh only, and an ItemList on the
  hub. No `Review`, `AggregateRating` or `FAQPage` markup is emitted. Existing
  cached community activity figures retain their own scope and fallback.

The PR author owns initial verification. Boardsesh maintainers check the sources
and App Store snapshot monthly and after relevant app/controller releases. Editorial
changes update the guide date; source and rating dates change only after checking
those claims. Pages never depend on an App Store request at render time.

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
for PostHog project 412845. `APP_GUIDE_PATHS` is derived from the guide slugs in
`app-guide-model.ts`, so it always lists the six live pages, and
`RETIRED_APP_GUIDE_PATHS` counts a landing on one of the five retired Aurora brand
URLs as `/apps/aurora`. It reuses the existing `$pageview`, `App Install Click`
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
each of the three actions, plus a direct `/apps/aurora` landing and one on a
retired brand URL. `seo-app-guide-validation.json` records the
exact executed fixture hash plus a bounded production syntax/field probe. When
the query changes, print `seoAppGuideFixtureQuery` and its SHA-256, run it with
PostHog SQL in project 412845, and record the hash and the returned rows; run the
production query over one day as the probe and record its rows and dates.

The result keeps each new page and `existing site` separate. US and outside-US-or-
unknown rows are disjoint; their sum is the observed worldwide total. Inspect
store placements separately when diagnosing which button was clicked. No
dashboard, scheduled report, outreach or tracking subscription is created by
these code changes.

Direct guide landings and same-language SPA navigation retain the existing
allowlisted inbound store campaign tags. A real document-language change reloads
the page and resets in-memory tags, as other language switches do. The new pages
do not promise cross-language campaign continuity.
