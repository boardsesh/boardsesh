# Legacy native JWT clock compatibility

This is evidence for [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975).
The disposable BA-01 prototype verifier this page once described was deleted in
#7620. What remains is a test of the live exchange handler and `validateMobileJwt`.
The [implementation ledger](better-auth-implementation.md) owns the overall migration gate.

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
audience and signature with **60 seconds of clock tolerance**. A stricter
check (an exact seven-day maximum span, no future `iat`, no expiry grace) would
reject credentials the live validator accepts. No original authentication timestamp is present in the released

## Test

`packages/backend/src/__tests__/native-jwt-clock.test.ts` calls the actual
`handleNativeAuthExchange` handler and `validateMobileJwt`. Only the database,
CORS, Redis and logger are replaced. The real `SignJWT` signer runs unchanged,
and fake timers advance only the clock reads. It checks:

1. Tokens whose `iat` and relative expiry reads are 0, 1, 60 and 61 seconds apart all validate.
2. A producer node 1 and 60 seconds ahead of the validator validates.
3. A token keeps its original expiry, validates until 60 seconds after it, and
   is rejected from that exact instant.

Run it with `vp test run --project backend native-jwt-clock --reporter=agent`.
The signing key and user ids are synthetic. No production credentials or
database are read.
