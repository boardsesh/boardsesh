# BA-01 pending legacy Garmin pairing proof

This disposable proof covers codes that were already pending when authentication moves to the canonical authority. No production router uses the adapter, no production Redis prefix is accepted, and no credential writer is switched.

## Actual released format

`packages/backend/src/handlers/native-auth.ts` currently allocates eight characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789`, stores the **raw user ID** as the Redis value using `SET NX EX 300`, and returns the code and expiry. The value has no JSON envelope, browser/native session identifier, authentication time, creation timestamp, or original source-token identifier. The existing pair endpoint normalizes hand entry by removing separators and whitespace and uppercasing, then consumes the key with `GETDEL`.

The proof seeds that actual raw UUID value in a randomly named, isolated Redis namespace and exercises real Redis through two independent clients. It preserves eight-character hand entry and normalization. It rejects JSON values rather than interpreting them as raw IDs. The current canonical watch facade retains its versioned user/session JSON binding and owner/revocation checks; neither reader falls back to the other format.

## Decisions

1. **The window is fixed by a permanent database epoch.** Trusted migration setup supplies a non-future cutover instant. The adapter copies the supplied Date before any await and commits `legacy-watch` in the existing durable migration-epoch table before consuming Redis. Another caller cannot choose a different cutover after a restart, a failed issuance, or ordinary verification-token cleanup. The legacy admission window ends at cutover plus 300 seconds. No schema or production migration is added.
2. **Only remaining lifetime is usable.** A Redis script atomically reads `PTTL` and executes the real `GETDEL`; it never writes or renews expiry. Missing, non-expiring, zero/negative or greater-than-300-second remaining TTL fails closed. Admission ends at the earlier of the observed remaining TTL and the fixed cutover deadline. The local observation starts before the Redis request to avoid extending validity by its network latency. Canonical issuance checks that deadline again after obtaining the lifecycle fence. The lineage retains that bounded original expiry, while the successfully issued native refresh keeps its existing 90-day contract.
3. **A code does not establish authentication age or source session.** New canonical sessions use epoch `createdAt`, null `originalAuthenticatedAt`, and no JWT `auth_time`. Neither cutover, remaining TTL nor code redemption becomes a recent login. A raw code cannot identify which source session authenticated the user; new admission therefore rejects account cutoffs and historical revoked, missing, expired or wrong-owner source lineages. Canonical user deletion also rejects pairing. This uses the same source-denial helper as the other legacy adapters.
4. **Signout creates durable source denial.** Independent review found that a fresh canonical session without a legacy lineage could previously be deleted by canonical `/sign-out` without leaving a denial marker. The shared lifecycle hook now records a revoked marker in the same SQL transaction. That marker blocks a previously pending source-less code without revoking another live canonical session or partner grant. The proof tests actual canonical signout of a native-credential session and checks that another session remains usable.
5. **Redis consumption is at most once; SQL issuance is atomic.** Native issuance uses the existing `withIssuanceTransaction` helper, canonical owner/cutoff checks and token policy. A failed SQL transaction rolls back its session, lineage and real native refresh mint. Redis `GETDEL` has already happened and is not rolled back. A crash, lost Redis reply, SQL failure or rollback can therefore lose a pending code. The adapter never restores it, retries issuance from memory, or claims a distributed transaction between Redis and PostgreSQL. A committed lineage additionally rejects replay if that same pending key is restored from an old Redis snapshot. A lost successful pair response cannot redeem the key again.

## Readiness gates and evidence limits

Raw values cannot prove that they were issued before cutover. A fixed 300-second horizon and Redis TTL only bound their admission. Before product use, trusted operators must provide an authenticated pending-key snapshot/source or fence the old issuer so it cannot create source-less codes during the window. Redis and SQL snapshot/restore coordination is another operational gate; the proof does not claim exactly-once recovery across independent backup restoration. The new JSON-bound code policy must remain authoritative for codes created after cutover.

Source-less codes after any relevant revocation require reauthentication through the canonical authority. This intentionally rejects ambiguous artifacts rather than treating a recent Redis entry as a new login. It is an explicit compatibility limit, not full migration readiness.

`legacy-watch.test.ts` uses dedicated local PostgreSQL and Redis, two independent Redis clients and UUID namespaces. Cleanup removes only keys in those owned namespaces. Tests cover the actual raw format, normalization, exact native response, unknown age, remaining TTL and cutover boundaries, epoch immutability, concurrent consume, recreation, lost responses, JSON separation, deleted users, source denials, canonical and native signout, actual reset races, Redis unavailability, and failures after consumption and real minting. Concurrent cases identify request start order without claiming that scheduler order proves lock acquisition order. The deterministic reset-between-GETDEL-and-issuance case proves that resetting in that gap cannot recreate access.

These are local compatibility and security proofs. They do not exercise a physical Garmin watch, production signing keys, production Redis, a production route, or an actual deployment cutover.

The author run passed **40/40 cases** on 2026-11-04. Independent review reran
those cases with the related bridge, transfer, refresh and explicit-origin
regressions: **163/163 passed in 12.68 seconds**, with clean teardown. A separate
**66/66** old/new watch run also passed. The canonical-signout finding was fixed
and re-reviewed; selected lint/format and backend TypeScript checks pass.
