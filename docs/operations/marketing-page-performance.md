# Marketing page loading

The homepage and English app guides use `MarketingDocument`. It renders the
public header, page content, footer and consent controls without the application
playlist, profile bridge, snackbar or persisted React Query providers.
`ApplicationDocument` retains the providers needed by settings, profiles, gym
management and other interactive routes. The root imports these server documents
only in their respective branches.

## Account and consent

Marketing loads one guarded browser session owner asynchronously. The first
HTML includes a working sign-in link in a reserved account slot. Account state
never becomes an input to shared marketing HTML.

The device consent coordinator is available immediately. Signed-in preference
synchronization loads separately, after the session is accepted. Analytics stays
blocked while account authority is unresolved. The homepage beta section loads
its query dependencies near the viewport. Its in-memory client does not restore
the application's persisted queries; requests remain scoped to the accepted
account and login session.

The shared playlist hooks remain in use on mobile. Web playlist detail supplies
its own GraphQL transport and no longer needs a global playlist adapter. Profile
header bridges mount only for profile routes.

## Poster publication

The homepage poster has generated 360, 540, 640 and 720 pixel WebP variants. The
server HTML includes responsive `srcset` URLs from the immutable static catalog,
so the poster does not wait for the Next image optimizer. Publication and
freshness follow [the static asset contract](static-assets.md). Video playback,
reduced motion and data saver behavior remain independent of poster loading.

## Deployment warming

After successful origin smoke verification, Production Deploy runs
`scripts/warm-marketing-pages.ts`. It reads the public release identity, then
requests only the exact anonymous document paths admitted by the marketing cache
policy. Each request has no cookies, authorization, query string or Flight
headers. It consumes the complete HTML response and checks content, shared
caching and the document's build-stamped `boardsesh-release` metadata.

An older document can remain at an edge after origin health reports the new
release. The warmer reports that document as skipped and leaves its existing TTL
alone. It never purges caches, forces regeneration or reports old HTML as warmed
for the new release. Failures are advisory and cannot roll back a healthy deploy.
The runner warms only the edge locations reached by its requests.

## Verification

Use a production build for LCP comparisons; development compilation timings do
not represent page performance. Keep Lighthouse version, browser, device and
throttling settings fixed. Alternate routes, use fresh browser profiles and
record five trials per route, then repeat the batch. The acceptance target is a
default mobile Lighthouse median below 2.5 seconds for both `/` and
`/apps/kilter`. Record applied-throttling results separately.

Keep the release and requested asset fingerprints, HTML cache status, LCP
element, transferred bytes, phase timings, CLS and accessibility results with
each batch. Confirm sign-in, cross-tab sign-out, account switching during a
request, consent withdrawal, beta visibility, locale/canonical metadata,
navigation and zoom. Existing consented web-vitals events provide field p75;
report sample counts and avoid attributing mixed-release observations to one
change.

The current root still reads request headers for locale and route metadata.
These pages remain dynamically rendered at origin even though anonymous English
documents are cached at the edge. Build-time pre-rendering requires isolating
their route entries from that request-dependent root; adding
`generateStaticParams` to a child alone is insufficient.
