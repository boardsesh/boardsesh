# Released native and Garmin source contracts

N1 records the public Git sources for 20 Android/iOS release tags spanning
2.2.0–2.7.0, the pre-G2 Garmin checkpoint, and the final reviewed G2 checkpoint
`73e85b88102caeed139f5df8ee0db3517f227cd4`. The manifest records full commit IDs,
Git blob IDs, SHA-256 digests and provider/SQLite callback ranges. Recording
preserves older unreferenced blobs. It does not prove installed builds, OTA
coverage, device behavior or Garmin SDK equivalence.

`vp run test:native-contract` runs the suite with one worker. It requires
`NATIVE_CONTRACT_DATABASE_URL` and `NATIVE_CONTRACT_REDIS_URL` pointing to isolated
loopback synthetic services. Every HTTP run creates a new random Postgres
database, applies the backend test schema, and closes the primary and admission
pools before dropping only that run's database. It never resets another database
or flushes Redis. CI runs the suite once, in backend shard 1.

The native harness compiles and executes the recorded modules with Vite/Oxc and
Node VM modules. It adapts native/keychain/cache/telemetry I/O, refuses unknown
imports, and executes the recorded account-creation receipt parser. Real HTTP
controls mount the current native handlers and use Postgres and Redis for
credentials, registration, synthetic signed Apple/Google identities, refresh
rotation, browser transfer replay and watch pairing. Provider JWKS transport
returns locally generated public keys; signature, audience, issuer and nonce
verification are real. Recovery tests pin the frozen web request paths and error
handling; they do not claim a mounted Next.js recovery implementation.

Frozen refusal controls execute each tag's interceptor and OAuth fallback hook.
The 2.2 provider controls execute recorded callback and SQLite cleanup function
ranges, with React state observed at the I/O boundary and the recorded checkpoint helper
executed against real in-memory SQLite. A warm
session whose proactive refresh fails becomes signed out and deletes unsynced
user rows, including pending mutations. Cold initial-false startup takes the
lighter cleanup path and does not delete those rows. Downloaded board reference
rows survive both. The suite preserves this limitation; the N2 token limiter
cannot repair frozen cleanup behavior or a lost single-use refresh response.

Garmin replay executes selected recorded function bodies after bounded syntax
translation: refresh completion/policy and PairingView/LoadingView consumers.
Storage/network/UI inputs remain adapters. This source-only replay is not a
Connect IQ SDK, simulator, watch or FIT run, and makes no sound/hardware claim.
No production runtime adopts `@boardsesh/auth-protocol/native-v1` in N1.

## Refresh-capacity fixture compatibility

The mounted overload probe presents a missing refresh secret. Its test-only
adapter selects the missing-secret capacity helper when the runtime has one,
then falls back to the earlier refresh-only and shared-auth helpers. Each
checkpoint still has to return the actual HTTP 503 body; the fixture never
substitutes a response or edits a frozen source recording.

On 2026-11-13, all 445 cases passed against the revised #7447 runtime
`4d9552e87a`, using only the native-contract test tree, its Vitest configuration,
the pure `native-v1` test helper and that helper's package export as an overlay.
Every other runtime file remains the exact target commit. This source-contract
execution does not close installed-client, original-key Garmin update,
hardware, full-rehearsal or activation gates in #7430.
