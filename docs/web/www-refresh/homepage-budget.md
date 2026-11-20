# Homepage HTML budget

The `typecheck` job checks rendered production homepage HTML after its existing `vp run typecheck`. JavaScript, root CI and translation-catalog changes all run this job, including JSON-only translation PRs. The checker calls the homepage assertion from `scripts/production-smoke.ts`: **60,000 gzip bytes**, using Node's default `gzipSync`, HTTP 200 and a server-rendered H1. The same assertion remains in post-deploy smoke.

```sh
vp exec tsx scripts/check-homepage-budget.ts
```

An existing artifact from another checkout can be inspected without rebuilding:

```sh
vp exec tsx scripts/check-homepage-budget.ts --web-dir /absolute/checkout/packages/web
```

The English H1 comes from that target checkout's `marketing.home.hero.title`, so a stale or unrelated page cannot pass just by containing any H1. Both the top-level and standalone `BUILD_ID` must match, and the standalone server entry must exist. Missing or incomplete output fails clearly; the checker never runs another build.

## Representative server-rendered content

A loopback GraphQL fixture supplies twenty deterministic beta rows with thumbnails, unique handles and hashed UUIDs, plus nonzero community statistics and gym-directory counts. The current fixture's usage numbers are **123,400** and **5,678,000**; they are test values, not published business figures. The checker requires real requests for both `GetRecentBetaLinks` and `GetCommunityStats`, and checks the first and last beta handles plus the formatted usage numbers in the actual server-rendered main content. Strings appearing only in RSC scripts or HTML attributes do not count. First-row handles cannot be confused with row ten.

The normal browser user-agent, exact H1, visible fixtures, status and HTML checks prevent an empty fail-soft page, redirect, error response or crawler-only shell from passing the budget.

## Isolation and failure behavior

The runner copies the existing `.next/standalone` into its own temporary directory, preserving internal symlinks and excluding `.env*` files and `.next/cache`. It starts the copied server with a minimal explicit environment. Prior runtime caches and developer/CI credentials are not inherited. A socket guard permits only the loopback fixture endpoint; database, vendor and other network connections fail the check. No browser or external image request is needed.

Readiness has a twenty-second ceiling, the complete runner has a sixty-second deadline, and the CI step has a two-minute timeout. Responses have a five-MiB read ceiling. Failures include bounded child-server output. Success, errors and handled interruption clean up both servers and only the temporary directory created by this invocation. The original artifact and a running development server are left intact.

## Task-cache evidence

Vite+ uses automatic output-write tracking for `build:web`. The inspected local verbose dry-run baseline recorded 9,352 outputs, including `packages/web/.next/BUILD_ID` and `packages/web/.next/standalone/packages/web/server.js`. The bundled Vite+ cache documentation says those recorded outputs are restored on a cache hit. This verifies the expected restoration set; a fresh cache-hit restoration was not executed during this campaign because it could have fallen through to a prohibited extra build. The runtime artifact preflight makes a missing restore visible in CI rather than silently rebuilding. No task-cache configuration change was needed.

## Validation and performance limits

The existing integrated production artifact `LXAWVm_DzTPHwyzFa1Gs-` passed with the populated fixtures and exact “Board night, sorted.” H1: **287,712 uncompressed UTF-8 bytes, 36,980 gzip bytes**. The checker and production-smoke suites passed 44 tests, and the scripts typecheck passed. Regression fixtures cover oversized poorly compressible HTML, missing SSR data, wrong headings, missing artifacts, copied secrets/cache, child startup failure, network restrictions and catalog-only CI wiring.

Astra recommended this bounded HTML gate without adding an LCP gate. It measures the delivered HTML payload, not browser rendering or physical-device speed. Physical-phone LCP remains unverified; no baseline, traffic or A/B measurement is required by this gate.


Final integrated rerun after the reviewed merges: build `P1mq-Uboo8bDK17yyWnPC` passed all 64 repository typecheck tasks and the new checker, with **287,713 raw / 36,977 gzip bytes**, twenty beta rows and the expected H1. The separate actual-data production response is **285,734 raw / 37,716 gzip bytes**. Both remain below 60,000 bytes. The public prerequisite's independently compiled homepage also passed at 39,159 gzip bytes after narrowing its outer and nested providers.
