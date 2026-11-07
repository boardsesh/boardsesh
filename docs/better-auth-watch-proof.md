# Disposable Garmin pairing proof

This supports [BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976)
and the compatibility work in [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975).
It is an isolated protocol proof, not a mounted replacement for the current watch
handlers or evidence that deployed watches have migrated.

## Preserved external contract

The current [`native-auth.ts` watch handlers](../packages/backend/src/handlers/native-auth.ts)
issue an eight-character code from `ABCDEFGHJKMNPQRSTVWXYZ23456789`, valid for
300 seconds. Allocation uses Redis `SET EX 300 NX` with at most five attempts.
Hand entry strips separators and changes letters to uppercase. `GETDEL` permits
one redemption across backend instances. The successful response is the existing
`{ jwt, refreshToken, expiresAt, userId }` native token pair.

The disposable facade exercises that contract with two independent Redis clients
and two native-authority instances sharing the same Postgres database. Pairing
and refresh responses pass the same recorded native/Garmin token-pair assertion
used by the identity proof: seven-day HS256 access JWT, unchanged issuer/audience
and user subject, plus an opaque 64-hex-character refresh secret with a 90-day
hashed database record.

## Authority and storage decisions

The code record contains a versioned, server-verified user/session binding.
`createPairingCode` validates the native access credential against the canonical
authority. Redemption consumes Redis state first, then calls the trusted internal
`issueForVerifiedSession` operation. That operation acquires the existing shared
transaction fence, verifies the user/session owner and expiry/cutoff, and calls
the existing native issuance policy. There is no separate watch password, JWT
or refresh policy.

A reset or logout between code issuance and redemption cannot create an active
descendant. If token issuance commits before reset and its response arrives
afterward, the returned tokens fail authoritative validation and refresh.
Pairing does not change the original authentication time; unknown legacy age
stays unknown.

`GETDEL` is intentionally not rolled back if later issuance or delivery fails.
This is the existing one-use behavior: a lost successful response requires a
new code, and replay cannot issue another pair. The prototype has no in-memory
pairing fallback when Redis is unavailable.

All Redis keys use an explicit `boardsesh:ba01:watch:<fixture>:` namespace,
separate from the production prefix. Test cleanup removes only that randomly
named namespace and always closes the owned Postgres database, including when
Redis setup or cleanup fails. No test calls `FLUSHDB` or `FLUSHALL`.

## Recorded evidence

On 2026-11-04, **26 tests passed** against real Postgres 15.17 and Redis 7.4.11.
They cover exact code lifetime/alphabet, hand entry, concurrent redemption,
handler recreation and watch refresh, real Redis expiry, malformed/unknown
codes, allocation collisions, Redis unavailability, post-mint response loss,
wrong-owner and malformed bindings, old/unknown authentication age, account
deletion, canonical expiry and revocation cutoffs, actual password-reset races,
and a deterministic late-response-after-reset sequence.

The changed source and tests passed `vp check` without findings and backend
TypeScript checking. Independent review requested the post-mint failure and
cleanup checks; those findings were fixed and re-reviewed. The independent
reviewer reran all **26 tests**, which passed in **3.59 seconds** with clean
Redis and Postgres teardown and no remaining actionable findings in this scope.

```sh
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres \
AUTH_PROTOTYPE_REDIS_URL=redis://127.0.0.1:15476 \
vp test run --config packages/backend/vite.auth-prototype.config.ts identity-watch-facade.test.ts --reporter=agent
```

The test defaults to the existing local/CI Redis service on port 6380 when
`AUTH_PROTOTYPE_REDIS_URL` is unset; the measured local run used a separate Redis
container on 15476. It fails when Redis is unavailable rather than skipping the
proof. Only local Redis URLs without URL options are accepted by its harness.

## Remaining compatibility gates

The production Redis format stores only a user ID. This prototype deliberately
rejects that unsupported value instead of inventing a canonical session or fresh
authentication. Migrating already-issued five-minute codes requires an explicit
bounded, owner-verified plan. That behavior is a known internal-format gap, not
a claim that all pending production codes work against this facade.

The proof creates pairing codes from canonical-backed native credentials. It
does not yet import old mobile/watch refresh records, accept historic native JWTs
without canonical session IDs, or prove the current web JWE pair-code surface.
It also does not replace HTTP handlers, CORS/rate limits, watch session-control
routers or push-device cleanup. Handler recreation is not a killed-process or
Redis/database recovery rehearsal. A real Garmin device and supported released
mobile builds remain required QA before production cutover.
