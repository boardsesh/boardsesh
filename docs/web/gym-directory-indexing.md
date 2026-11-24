# Gym directory indexing

The directory and gym sitemap share `GYM_DIRECTORY_INDEXING_ENABLED`. It is off
unless the web environment sets it to exactly `true`. Deploying this change alone
does not lift the duplicate-cleanup hold.

## Eligible pages

When enabled, `/gyms`, `/gyms/kilter`, `/gyms/tension` and `/gyms/moonboard` are
indexable and appear in `/sitemaps/gyms.xml`, along with their locale variants.
Any query-string variant stays `noindex, follow`, canonical to its clean facet.
The existing server-rendered heading, explanatory copy, venue cards, pagination
and cross-facet links provide the page content.

The backend `publicGymSitemap` query enumerates only public, listed, live,
unmerged venues with nonempty slugs and valid latitude/longitude. It returns
only slugs and stored `updatedAt` timestamps. The directory requests the same
coordinate eligibility through `SearchGymsInput.requireLocation`; other gym
search consumers retain their existing behaviour. Private/unlisted gyms and
home walls remain outside the sitemap and keep their existing noindex metadata.

Merged aliases retain their existing permanent redirect, now preserving the
requested locale and allowed attribution parameters. Metadata uses the resolved
survivor slug for its canonical and translated alternates.

## Publication order

1. Deploy the backend schema before the web consumer: it adds `requireLocation`
   and `publicGymSitemap`. Keep the web indexing switch unset.
2. Review the automatic duplicate queue and incoming duplicate reports. Resolve
   confirmed duplicates using the existing audited admin `mergeGyms` mutation;
   dismiss distinct venues through the review queue. Obtain approval for merges
   that delete duplicate records or transfer control.
3. Re-read the queue and both old/new URLs. Confirm the survivor retains its
   boards and members, and every merged URL redirects permanently. The
   [22 November audit](gym-dedup-audit-2026-11-22.md) records the pending Mammoth
   merge and its exact approved direction.
4. Set `GYM_DIRECTORY_INDEXING_ENABLED=true` in the web environment. Verify clean
   directory HTML permits indexing, variants remain noindex, and the gyms shard
   contains only canonical venue URLs with real timestamps. Check
   `/sitemap.xml` advertises the shard without `X-Sitemap-Degraded: gyms`.
5. Inspect representative directory and venue URLs in Search Console, then
   monitor indexing exclusions and gym-page impressions weekly. Publication
   makes pages eligible; it does not prove Google has indexed them.

The sitemap reads visibility afresh and responds `private, no-store`, so later
unlisting withdraws a venue on the next shard request. Backend failures produce
503 responses rather than publishing an incomplete venue list. The index may
omit a failed gyms shard briefly under its existing degraded-cache policy.

A 7,000-venue cap leaves room for six locales and four directory routes within
one shard. The backend reads one extra row and throws on overflow. The sitemap
registry also enforces expanded URL and byte budgets; add pagination before
raising the cap. Directory routes have no invented last-modified timestamp.

To stop new directory/sitemap publication, unset the switch or set it to
`false`. This restores directory noindex and withdraws the gym sitemap entries.
It does not undo merges or change existing individual venue metadata.

## Search Console baseline

Observed in logged-in Chrome on 22 November 2026, Web search, 21 August through
20 November: 1.75k clicks, 60.7k impressions, 2.9% CTR, average position 8.8.
Three visible Foundation Climbing queries totalled 116 clicks. Those are query
counts, not a measured `/gym/` page segment. The gym URL filter could not be read
because browser access was restricted. Review snippets separately showed 197
invalid items; that issue is outside this change.

## Individual gym search metadata

Gym titles include the saved address and publicly listed catalogue board types
when available. There is no structured city field: the address is kept verbatim,
and coordinates are never converted into a guessed town. Without an address,
the fallback keeps the gym name and omits “climbing gym” for names containing
“climb” or “boulder”.

Descriptions use the same public board rows, with recorded, nonzero fixed angles.
Adjustable or unspecified angles are omitted. Board types on the gym summary
are not enough to claim a board is available. When board reads fail or return no
public catalogue boards, location copy or the existing description is used.
Share card copy, canonical URLs, index eligibility and sitemap rules stay the same.
