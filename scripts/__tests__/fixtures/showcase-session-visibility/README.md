# Native session visibility target

This fixture retains only the visibility Toggle's labels, bounds, checked states
and child structure from the GET-only hierarchy captured in CI run 41183472276.
The sibling JSON records the exact source SHA, artifact, query timestamps and
XCTest's observed tap. No account, device, avatar or credential data is retained.

Pinned Maestro 2.6.1 applies
[`Filters.deepestMatchingElement`](https://github.com/mobile-dev-inc/maestro/blob/cli-2.6.1/maestro-client/src/main/java/maestro/Filters.kt)
to the selector's basic filters in
[`Orchestra.buildFilter`](https://github.com/mobile-dev-inc/maestro/blob/cli-2.6.1/maestro-orchestra/src/main/java/maestro/orchestra/Orchestra.kt).
Allowing the bare title therefore selects the title child, whose relative tap
matches the observed `[181,466]`, outside the actual switch thumb. Requiring the
combined title and subtitle selects the Toggle; its `[369,487]` tap is inside the
observed thumb. The app's analytics event remains the runtime privacy gate.
