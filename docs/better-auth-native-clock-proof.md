# Legacy native JWT clock compatibility proof

This is isolated evidence for [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975)
and BA-01. It changes only the disposable prototype verifier and its tests; the
deployed native issuer, request handlers and authentication middleware are
unchanged. The [implementation ledger](./better-auth-implementation.md) owns the
overall migration gate.

## Actual producer and observed gap

The existing `packages/backend/src/handlers/native-auth.ts` public
`handleNativeAuthExchange` handler calls its private `generateTokenPair` function.
That function uses the installed, real `jose.SignJWT` implementation:

```ts
new SignJWT({ sub: userId })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setIssuedAt()
  .setIssuer('boardsesh')
  .setAudience('boardsesh-mobile')
  .setExpirationTime('7d')
  .sign(signingSecret);
```

`setIssuedAt()` and relative `setExpirationTime('7d')` read the clock separately.
A second boundary can therefore produce a genuine signed `exp - iat` of
604,801 seconds. A bounded process pause can increase that difference further.
The response's `expiresAt` uses another independent `Date.now()` read and is not
a substitute for the signed expiry.

The installed `middleware/auth.ts` `validateMobileJwt` verifies the issuer,
audience and signature with **60 seconds of clock tolerance**. The initial
prototype instead required an exact seven-day maximum span, no future `iat`,
and no expiry grace. Those stricter assumptions rejected otherwise supported
credentials. No original authentication timestamp is present in the released
producer's JWT; its rolling `iat` cannot establish recent authentication.

## Explicit prototype policy

| Bound | Decision |
| --- | --- |
| Nominal JWT lifetime | Keep seven days. |
| Separate encoder reads | Allow at most 60 additional seconds in the signed `exp - iat` span. A 61-second excess rejects. This is a named, bounded admission policy, not evidence that the old producer enforces that limit. |
| Expiry transport grace | Match the installed backend's 60-second tolerance. Preserve signed `expiresAt` separately; expose `validUntil = exp + 60 seconds`. Acceptance ends exactly at `validUntil`, not after it. |
| Ahead-clock issue time | Permit at most 60 seconds relative to the receiving server. The current middleware does not independently enforce an `iat` ceiling; the prototype's ceiling is explicit rather than inferred from jose's expiry tolerance. |
| Authentication age | Released JWTs remain unknown-age and create an epoch/non-fresh canonical session. An optional synthetic `auth_time` beyond the receiver's current time rejects, even if its `iat` lies within the ahead-clock allowance. |
| Revocation cutoff | Compare the conservative `raw iat - 60 seconds` with the persisted cutoff. An ahead-clock credential cannot present itself as a new login after a security mutation. |
| Stored expiry | Retain raw signed expiry in lineage state; the canonical bridge's initial transport bound uses `validUntil`. No original authentication time is refreshed. |

Encoder-read allowance and transport grace are separate bounds. A valid signed
span can consequently reach seven days plus 60 seconds, and its accepted
transport lifetime adds the existing 60-second expiry tolerance. This does not
prove arbitrary issuer stalls or clock offsets remain compatible. Production
writer fencing, lineage admission and the broader migration gate still apply.

## Reproducible evidence

`legacy-native-clock.test.ts` invokes the actual public exchange handler with a
real HMAC transfer fixture. Only database insertion, CORS, Redis availability,
logging and HTTP request/response I/O are replaced. The actual private token
producer and real `SignJWT` signer run unchanged. A controlled Date constructor
advances only the two no-argument clock reads used by jose; the test decrypts
nothing and verifies the resulting actual JWT signature and claims.

The receiver and canonical bridge run against an owned disposable Postgres
database. The tests cover:

1. Actual issuer spans of seven days, plus one second, and plus 60 seconds;
   plus 61 rejects.
2. Actual issuer nodes one and 60 seconds ahead; 61 seconds ahead rejects.
3. Raw expiry retained during installed expiry grace, acceptance at its last
   millisecond, and rejection at the exact exclusive boundary.
4. An already-known lineage whose raw `iat` is ahead of a persisted cutoff;
   its conservative lower bound rejects on both recreated handlers.
5. Unknown age/freshness, future synthetic authentication time, and durable
   rejection after canonical sign-out and handler recreation.

The independent reviewer confirmed that jose's `requiredClaims` verifies
presence without enforcing a string subject. Six adversarial re-signing cases
cover numeric, object, array, null, empty and blank subjects. The prototype
explicitly requires a nonblank string before returning a user ID or querying
identity state. These are malformed-claim fixtures, not claims about what the
released producer emits.

Author validation on 2026-11-04: **17 cases passed**, comprising the original
11 clock cases and six reviewer-requested malformed-subject regressions. The
same run with the existing legacy bridge suite passed **35 cases across two
files**. Run:

```sh
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres \
  vp test run --config packages/backend/vite.auth-prototype.config.ts \
  legacy-native-clock.test.ts --reporter=agent
```

The signing key and user records are synthetic. No production credentials or
database are read. Independent re-review passed **35/35 cases in 6.73 seconds**,
with clean teardown and selected lint/format checks. The reviewer rechecked the
runtime subject guard, all six signed malformed-subject regressions and the
clock/expiry boundaries; no actionable finding remains in this proof scope.
