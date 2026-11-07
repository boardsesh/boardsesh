# BA-01 browser-native transfer proof

This disposable proof covers the existing browser-fallback transfer exchange through the same canonical authority and native token issuer as the credential, social, refresh and watch proofs. No production route imports it. It does not switch a credential writer, use a production secret, change a client response, or establish rollout readiness.

## Released transport and retained behavior

The actual producer is `packages/web/app/lib/auth/native-oauth-transfer.ts`, called by the native OAuth browser callback. Its token is two parts: base64url JSON followed by a base64url HMAC-SHA256 over that encoded JSON, separated by a period. It is not a JWT. The required transfer fields are `userId`, `nextPath`, `iat` and `exp`. The producer gives it 120 seconds. The backend currently permits a signed lifetime up to 125 seconds and five seconds of clock tolerance.

The proof imports the actual web producer only from tests, with a synthetic test secret. Runtime backend code accepts an explicitly injected synthetic verification key. No backend source imports a web route or its environment secret. The real producer's OAuth-attempt cookie uses the same HMAC key but a different payload; it cannot be exchanged as a transfer. Standalone creation receipts and labelled sibling-purpose messages are rejected too.

The exchange returns the existing `userId`, `jwt`, `refreshToken`, and `expiresAt` native pair, with an optional valid `accountCreation` receipt. It delegates signing and persistence to `identity-native-facade.ts`: seven-day HS256 access JWT, existing issuer and audience, SHA-256-only storage of the opaque 90-day refresh token, and the same canonical session, owner and cutoff checks. It neither creates another password verifier nor another JWT policy. The existing shared native contract assertion verifies the pair.

Creation metadata remains optional. A receipt is returned only when its parsed user and provider match the signed transfer and the transfer includes a nonempty browser session identifier and a valid 32-character lowercase hexadecimal attempt identifier. Mismatched or malformed optional metadata is stripped while the otherwise valid signed sign-in remains usable, matching current endpoint behavior. HMAC verification fixes the entire user, attempt, provider and receipt tuple; callers cannot replace one field after issuance.

## Decisions and compatibility limits

1. **Transfer time is not authentication time.** `iat` dates the handoff from a browser, and `accountCreation.createdAt` dates account creation. Neither proves recent authentication. A new transfer lineage has unknown original authentication age: canonical `createdAt` is the epoch, `originalAuthenticatedAt` is null, and the access JWT has no `auth_time`. A transfer that maps to an existing live same-owner browser lineage retains that lineage's known or unknown age. Extending native expiry never freshens it.
2. **Released returning-user transfers lose source identity.** The current producer includes `authSessionId`, `attemptId` and `provider` only when all creation-proof fields are present. Passing `authSessionId` alone still produces an identifier-free token. Such a token cannot distinguish a stale browser session from post-reset authentication, even if its handoff `iat` is newer than the reset. A new unknown lineage therefore fails closed after any account cutoff or prior revoked, missing or expired lineage. A previously known, live explicit lineage may reuse its canonical session only if the native authority still accepts it. These cases require reauthentication through the new authority. Complete unchanged browser-fallback compatibility remains a migration readiness gate until the issuer supplies trusted source lineage and authentication evidence.
3. **Single use is durable and transactional.** Two independent facade instances share a database marker keyed by SHA-256 of the complete verified token. The same lifecycle advisory fence serializes reset, signout and native issuance. One transaction validates canonical ownership, consumes the transfer, creates or reuses its lineage, and mints the real native pair. A failure after minting rolls back the consumption marker, session changes, lineage, refresh and caller metadata. Handler recreation cannot replay a committed transfer. A lost successful response remains consumed, matching the released single-use protocol.
4. **Replay markers cover the whole accepted grace interval.** The installed verifier accepts while `exp >= floor(now / 1000) - 5`. Consequently the last accepted instant is the end of integer second `exp + 5`; marker cleanup is safe starting at `(exp + 6) * 1000`. The lineage separately preserves original `exp`. Canonical signature text is compared directly, preventing permissive base64 aliases from producing another replay fingerprint.
5. **Transport hardening is explicit.** The current backend verifier ignores `nextPath` and purpose labels. This proof requires the fields the legitimate current issuer supplies, rejects labelled sibling messages, requires safe integer timestamps and positive bounded lifetime, caps token length at 4096, and normalizes protocol-relative, backslash and ASCII-control callback paths to `/`. The exchange still returns no callback path. Unlike the current Redis/in-memory replay fallback, database failure cannot fall back to process-local acceptance. These are compatibility-strengthening decisions, not claims about the stock verifier.

The backend does not independently replay the original browser callback or revalidate its attempt cookie. The current callback owns that validation before issuing the HMAC transfer. Proving that caller uses canonical session state under reset/signout fencing, retaining source lineage for returning users, and choosing the production transport keys and replay retention policy remain rollout gates. The conservative rejection above is intentional until those gates are resolved.

## Verification and limits

`packages/backend/src/auth/prototype/__tests__/legacy-transfer.test.ts` uses a dedicated blank PostgreSQL database through the isolated auth-prototype test configuration. It covers actual-producer roundtrips, sibling-purpose rejection, immutable metadata, malformed and tampered transport, exact lifetime/skew boundaries, canonical signature aliases, unknown authentication age, mapped lineage reuse, wrong owners, source tombstones, deleted users, ordinary signout, cutoff-after-handoff behavior, concurrent two-instance redemption, handler recreation, lost responses and transaction rollback. Password reset races use the actual canonical reset endpoint; tests label concurrent request start order without claiming that scheduler order proves lock acquisition order. A pair minted before reset is also checked after reset completes: online validation and refresh both reject it.

These tests establish a local compatibility and security proof. They do not establish production browser-cookie provenance, live provider callback behavior, deployment safety, native device execution, or readiness to retire the released writer. No production service mounts this facade.

The author run passed **70/70** on 2026-11-04. Independent review requested an
additional ordinary-signout boundary regression, then reran **87/87** cases
(70 transfer and 17 existing native facade cases) in **3.83 seconds** with clean
database teardown. Selected lint/format checks passed; no actionable findings
remain within the documented fixture scope.

A later pending-watch review exposed a second signout boundary: deleting a fresh
canonical session without a legacy lineage had left no source denial. The shared
hook now persists that marker transactionally, and new admission uses the shared
denial query. An additional actual canonical-signout case proves source-less
transfer rejection while another mapped native session, refresh and handoff
remain usable. The final **71 transfer cases** passed in an independent
**163-case** source-denial/origin run in **12.68 seconds**; selected checks and
re-review are clean.
