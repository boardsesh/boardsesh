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
  the public figure. The line links to the US listing. Beside it, the Google Play
  figure is the public US listing as shown (`BOARDSESH_PLAY_RATING`, dated), not
  the Play Console's default. Both are app-wide and do not establish
  board-specific superiority.
- "What climbers say" quotes verbatim public store reviews from `quotes.json`
  (imported into `APP_GUIDE_QUOTES`, never into the translated catalog), one to
  three per page, marked `lang="en"`, linked to the store listing and shown
  without stars. App Store reviewers appear by nickname, Play reviewers by first
  name and last initial. The
  JSON-LD is WebPage (with `dateModified` and an Organization publisher),
  BreadcrumbList, a MobileApplication for Boardsesh only, and an ItemList on the
  hub. No `Review`, `AggregateRating` or `FAQPage` markup is emitted. Existing
  cached community activity figures retain their own scope and fallback.

The PR author owns initial verification. Boardsesh maintainers check the sources
and App Store snapshot monthly and after relevant app/controller releases. Editorial
changes update the guide date; source and rating dates change only after checking
those claims. Pages never depend on an App Store request at render time.

## Search Console comparison

### Release and indexing receipts (#8122)

The six guides went live on **2026-11-24** (production deploy `b228496c5`).
Release dates below refer to this guide rollout; the homepage and `/boards`
already existed. The dates below record our first confirmed post-rollout
inspection, not the exact time Google added a page to its index.

| URL path | Guide rollout date | First confirmed indexed after rollout | Day-zero observation |
| --- | --- | --- | --- |
| `/apps/kilter` | 2026-11-24 | 2026-11-24 | Indexed; self-canonical; crawled 18:42:09 UTC |
| `/apps/moonboard` | 2026-11-24 | 2026-11-24 | Indexed; self-canonical; crawled 18:42:09 UTC |
| `/apps/aurora` | 2026-11-24 | 2026-11-24 | Indexed; self-canonical; crawled 18:46:08 UTC |
| `/compare/spray-wall-apps` | 2026-11-24 | 2026-11-24 | Indexed; self-canonical; crawled 18:48:10 UTC |
| `/apps` | 2026-11-24 | 2026-11-24 | Indexed; self-canonical; crawled 18:48:10 UTC |
| `/apps/woods` | 2026-11-24 | 2026-11-24 | Indexed; self-canonical; crawled 18:54:22 UTC |
| `/` | 2026-11-24 | 2026-11-24 | Existing index refreshed; self-canonical; crawled 19:00:12 UTC |
| `/boards` | 2026-11-24 | 2026-11-24 | Indexed; self-canonical; crawled 19:00:12 UTC |

The initial inspection found the guides and `/boards` unindexed. The final
day-zero URL Inspection API check returned **Submitted and indexed** for all
eight URLs, with successful fetches, indexing allowed, and matching Google-
selected/user-declared canonicals. The homepage's final crawl is after rollout;
it was already indexed before these changes. The exact final inspection fields
are retained in `rollout-2026-11-24.json`.

On November 24, Search Console accepted both
`https://www.boardsesh.com/sitemap.xml` and
`https://www.boardsesh.com/sitemaps/app-guides.xml`. The index initially showed
"Couldn't fetch", then changed to **Success**; Kilter's inspection subsequently
listed both submitted sitemaps as discovery sources. Submission and discovery
do not establish indexing. Both public XML endpoints returned 200 as Googlebot;
the shard listed exactly the six canonical guides. A final Search Console
recheck showed **Success** for both submissions, with **6 discovered pages**
on the guide shard.

All eight ordered URL Inspection requests returned **Indexing requested**.
The dated checks are scheduled in the Codex chat automation
`app-guide-indexing-and-crawler-checks`, evaluated at 09:00 Europe/Amsterdam;
it also handles monthly upkeep and reports only meaningful changes.

The 18:46 UTC public HTML probe returned 200 for all six guides, each with its
own www canonical, an H1, a `BreadcrumbList`, and no `noindex` or `X-Robots-Tag`.
This checks the deployed markup, not Google's Rich Results Test verdict.

All six live guides passed Google's Rich Results Test on November 24:

| Path | Result receipt | Detected valid items |
| --- | --- | --- |
| `/apps/kilter` | [19:57 CET test](https://search.google.com/test/rich-results/result?id=CitA-TrYLHVHuW4pURl1jA) | Breadcrumbs, Software apps |
| `/apps/moonboard` | [19:58 CET test](https://search.google.com/test/rich-results/result?id=6WiEYjgTTAjIygVfzRWV2Q) | Breadcrumbs, Software apps |
| `/apps/aurora` | [19:59 CET test](https://search.google.com/test/rich-results/result?id=D-3Wolk2opwELjO48mMYaA) | Breadcrumbs, Software apps |
| `/compare/spray-wall-apps` | [20:01 CET test](https://search.google.com/test/rich-results/result?id=h0U1GA1vpJgyfWuBzw7KeA) | Breadcrumbs, Software apps |
| `/apps` | [20:03 CET test](https://search.google.com/test/rich-results/result?id=08g64bBLN27Rm6Q5KdII3Q) | Breadcrumbs, Carousels, Software apps |
| `/apps/woods` | [20:04 CET test](https://search.google.com/test/rich-results/result?id=QUc4MYuQKxVoNPTFAdbn1g) | Breadcrumbs, Software apps |

The [homepage test](https://search.google.com/test/rich-results/result?id=eWMVjwQUAX8Y55G2SzqXPA)
detected one valid Video item. The
[`/boards` test](https://search.google.com/test/rich-results/result?id=DGCAGxKElgtIUus9mNlNmg)
crawled successfully with no rich-result items detected. Its first attempt had
a server connection error; the retry succeeded. No breadcrumb enhancement is
claimed for that existing directory page.

Google reported Software apps as valid with non-critical issues, rather than
the ineligible verdict anticipated in #8122. This is the observed validator
result, not a guarantee of rich-result display. No ratings were added to
structured data to change eligibility.

Bing imported and verified `https://boardsesh.com/` from Search Console on
November 24. The initial import displayed a fetch failure; after the retry and
a refresh, the property appeared as verified. The canonical www sitemap index
`https://www.boardsesh.com/sitemap.xml` was explicitly submitted and appeared
in Bing's sitemap table as **Submitted / Processing**. This records accepted
submission, not completed processing or indexing. Bing's initial reports can
take up to 48 hours to populate.

The Perplexity exception from #8130 was applied through the repo's production
workflow at 19:30:22 UTC. All eleven allowed documents returned 200 as
PerplexityBot, while the login page and all six training-crawler probes remained
403. See `docs/operations/cloudflare.md` for the managed-rule conflict, scope
and deployment receipt, and `rollout-2026-11-24.json` for the exact probe results.

Use these dated checkpoints, based on the release date (Europe/Amsterdam):

| Date | Work due |
| --- | --- |
| 2026-11-25 | Day 1 crawler load |
| 2026-11-26 | Day 2 URL inspection and canonical comparison |
| 2026-11-27 | Day 3 crawler load |
| 2026-12-01 | Day 7 indexing, canonicals and crawler load |
| 2026-12-08 | Day 14 link/indexing recovery and crawler load |
| 2026-12-15 | Day 21 crawler load |
| 2026-12-22 | Day 28 complete-window search/outcome comparison and crawler load |
| 2027-01-19 | Day 56 complete-window search/outcome comparison |

Allow Search Console reporting lag before comparing a complete window. Monthly
source/rating upkeep starts December 24. Nice-to-have content/design changes
in #8122 are separate from the day-zero release gates.

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

### AI-search referrals

`seoAppGuideAiReferralsQuery` in the same query module measures first observed
www session landings on the six guides (including the spray comparison) from
the exact referral hosts `chatgpt.com`, `perplexity.ai`, and `claude.ai`. Retired
Aurora guide paths map to `/apps/aurora`. A later guide visit from an internal
link is not an AI landing. Paid click identifiers/media, missing session IDs,
internal cohort 295337 and the existing bot classes are excluded; short
Windows/Chrome visits remain counted with a separate automation flag.

The Google query and its executed fixture hash are unchanged. The separate
`seo-app-guide-ai-fixtures.ts` fixture covers session deduplication, returning
people, internal navigation, lookback boundaries, timestamp ties, spoofed
referral domains, bots and paid traffic. Its actual PostHog execution and the
bounded production probe are recorded in
`scripts/posthog/seo-app-guide-ai-validation.json`. The day-zero probe
`[2026-11-24 17:55, 18:45 UTC)` returned no rows. This is a partial window over
captured, consented sessions, not evidence of zero AI referrals, citations,
installs or crawler requests. Missing referrers and unknown consent coverage
remain limitations. Use the query's bounded date window for later comparisons.

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
