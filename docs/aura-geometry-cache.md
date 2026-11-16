# Aura geometry artifacts

Aura can reuse geometry across themes, selected hold sets, swipes and editing pulses. Classic and custom spray walls do not use these artifacts. Tension's public catalogue Spray layout does. The small shipped manifest lives in `packages/mobile/src/lib/aura-assets/generated/manifest.json`; it stays empty until publication has verified every referenced CDN object. Generated `.aura` binaries are build artifacts, never source files.

## Generate and publish

1. Run `vp run generate:aura-geometry -- --out /tmp/boardsesh-aura-prebuild`. This walks the 51 catalogue configurations at their native resolution, invokes Rust twice per configuration, compares exact hashes and byte lengths, then writes `manifest.candidate.json` and `generation-report.json`. A failed configuration prevents release of the manifest.
2. After the publisher workflow is merged to `main`, run the **Aura Geometry** GitHub workflow with `publish: true`. It uses the existing Production `STATIC_ASSETS_*` credentials, conditionally writes missing immutable `static/v1/<sha256>.aura` objects under the existing CDN cache rule, verifies signed storage reads and public `assets.boardsesh.com` reads, then exports `manifest.verified.json`. Format revision 2 remains in each artifact and its manifest. The workflow never overwrites or deletes historical objects and never pushes to the repository.
3. Put the verified manifest into the shipped manifest path in the catalogue rollout PR, before releasing expanded eligibility. A local operator with the same credentials can run `vp run publish:aura-geometry -- --out /tmp/boardsesh-aura-prebuild --release-manifest packages/mobile/src/lib/aura-assets/generated/manifest.json`. This updates the shipped file only after every object passes verification.

The repository's Production environment permits only the `main` branch. A feature branch can regenerate and test artifacts, but cannot use that environment to publish them. Merge the format and cache prerequisites first, publish and verify the objects from `main`, then review the populated manifest with the catalogue rollout. Keep the shipped manifest empty until that verification finishes; do not change environment rules to publish a draft branch.

Public verification requires a full byte-verified GET with an edge cache HIT. A MISS is consumed and retried at most three times; missing cache headers, DYNAMIC and BYPASS fail publication. This prevents releasing a manifest whose objects are reachable but bypass the configured CDN cache.

The manifest records the geometry and atlas format revisions, geometry identity, exact native dimensions, compressed SHA-256 and byte length, maximum glow reach and 135% pulse support. Each hold's field is independently compressed with the Rust deflate implementation. Runtime assembly calculates the current selection's outline caps, LED covers and participation, while colors, veil, falloff and marks use the current appearance. Native code rechecks the expected file hash and each requested hold's identity and bounds. An incompatible circle, seed treatment or wider glow generates geometry locally.

## Phone storage and downloads

The selected board is prefetched first, followed by enabled offline boards, with shared geometry deduplicated. One transfer runs at a time under the existing unmetered-network policy. Leaving the foreground, losing connectivity or selecting another board cancels irrelevant transfers. Every download streams into a private partial file, stops before exceeding its declared byte length, and checks its full hash before atomic publication. Incomplete and corrupt files remain unavailable to rendering.

Compressed downloads occupy at most 256 MiB in `aura-geometry-v2`. Before admission, old entries are evicted, preferring offline boards within the ceiling. Native-generated compressed geometry lives separately in `aura-generated-v2`, bounded by both 256 MiB and four entries. Native preparation serializes admission and reads `.offline-scopes.json` as a retention preference; offline entries still obey both limits. These are maximum storage limits, not reservations.

A view captures a verified local prebuilt path or local-generation choice once when its static configuration changes. Finishing a download publishes no render event and cannot interrupt a swipe or edit. Missing modules, files, disk space, incompatible geometry or failed integrity checks fall back to local generation; existing resource and readiness failures still fall back to PNG. Board-download completion does not wait for this optional cache, and offline climbing remains available without it.

## Verification

Cache tests cover exact-resolution selection, format invalidation, byte and entry limits, offline retention, serialized transfers, metered launch, interrupted/truncated/overlong bodies, checksums, failed evictions, disk exhaustion and rapid cancellation/reselection. Publication tests prevent a manifest release on nondeterministic regeneration or failed local, storage or CDN verification. Run `vp test run --project mobile --reporter=agent src/lib/aura-assets` and `vp test run --project scripts --reporter=agent aura-geometry`.

Host preparation and offscreen comparisons do not establish visible-ready latency, physical frame timing or process peak memory. Record the actual physical phones, source and artifact identities, cache state and sample counts for alternating baseline/candidate runs. Keep verified prebuilt hits, local-generation misses, process restarts and warm gestures separate. Native frame-capture overhead must stay outside the primary CPU and process-memory measurements.
