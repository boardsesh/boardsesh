# Legacy web credential proof

This proof supports [BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976)
and [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). The verifier
began in the prototype and moved to `packages/backend/src/auth/legacy-web-credentials.ts`
when partner consent (#6981) started reading the www session with it. It does not
satisfy the authority cutover gate.

## Cryptographic and identity boundary

The fixture producer is the installed NextAuth **4.24.15** encoder. Verification
uses its empty-salt HKDF context, `NextAuth.js Generated Encryption Key`, and
only `dir` / `A256GCM`. The helper receives an explicit legacy verification key;
it imports neither NextAuth runtime code nor a web authentication module.
Separate purpose, audience and issuer labels are rejected rather than guessed.

Every accepted credential has a verified subject, integer issue/expiry claims
and a signed lifetime bounded by the nominal 30 days plus the explicit encoder
clock-read allowance below. Since #6981 (F5) the web jwt callback writes
`auth_time` on a completed sign-in, and never on a rotation or a native
transfer, so the verifier now reports it as `originalAuthenticatedAt`. A
missing claim, one that is not a whole positive number of seconds, one more than
60 seconds ahead of the reader's clock, and one after the cookie's own `iat`
(beyond the same skew) all read as unknown; the session itself stays valid.
Where several copies of one login are accepted, the earliest sign-in counts, and
none if any copy lacks one. The attribution timestamp is never read as a sign-in.
Partner consent is the one production reader (`auth/partner/first-party-session.ts`);
the prototype's canonical bridge still ignores it. The current web callback's explicit `authSessionId`
identifies a stable login; NextAuth regenerates `jti` during rolling encoding,
so an unpersisted `jti` cannot establish durable lineage. Credentials without
explicit lineage require a conservative account cutoff in a later bridge.

## Explicit clock policy

The helper follows the existing backend's **60-second** JWE clock tolerance in
[`validateNextAuthToken`](../packages/backend/src/middleware/auth.ts). This is
deliberately different from the installed NextAuth browser decoder's
**15-second** expiry tolerance; it is not a claim that all current transports
have identical validity rules.

Future issue times are bounded to 60 seconds. The result preserves the signed
`expiresAt` separately from `validUntil = expiresAt + 60 seconds`, and exposes
`clockToleranceSeconds`. A token is rejected at `validUntil`. Clock grace never
proves fresh login.

The installed encoder obtains `iat` through jose's `new Date()` and then reads
`Date.now()` separately to compute `exp = now + maxAge`. Crossing a second
boundary between these calls creates a genuine cookie whose signed span is
30 days plus one second. A separately named **60-second encoder clock-read
allowance** permits that boundary and bounded process pauses; a span beyond
30 days plus 60 seconds is rejected. This does not add time to the signed
`expiresAt`, change `validUntil = signed exp + 60 seconds`, or widen the
cutoff margin. The helper preserves those separate timestamps explicitly.

A bridge must compare the verified issue time **minus the skew allowance**
against an account cutoff. Otherwise an old token minted on an ahead-clock node
could appear newer than a reset. This helper deliberately does not read
revocation state: joined reset/sign-out/bridge tests and the canonical
transaction boundary remain required before migration.

## Cookie selection and cleanup

Both secure and plain historical names support bounded, contiguous numeric
chunks. Conflicting duplicate values, base-plus-chunk ambiguity, malformed
chunk sequences and excessive sizes fail closed. Valid credentials for
different users or established logins also fail closed, independent of order.

A cryptographically invalid or expired alternate secure/plain candidate cannot
override another verified credential. The accepted proof retains the exact
recognized cookie names, including stale alternate chunks, so a successful
handoff can clear them. This does not weaken structural conflict checks or use
identity claims from an invalid token. Valid rotations combine only when their
user and explicit lineage match; their issue and expiry bounds remain
conservative.

## Recorded evidence

On 2026-11-04 the decoder suite passed **56 tests**, using the installed encoder,
real HKDF/JWE verification, cross-node clock fixtures, expiry-grace boundaries,
cookie/chunk conflicts, stale alternate account claims and independent encoder
clock reads at one second, 60 seconds and beyond the allowed boundary. The two changed
source/test files passed `vp check` with no lint or type findings.

```sh
vp test run --project backend packages/backend/src/auth/__tests__/legacy-web-credentials.test.ts --reporter=agent
```

Independent review found the initial zero-skew and invalid-alternate policies
could reject ordinary supported sessions. The explicit backend policy above
replaces those choices. Production cookies, account isolation, bridge cutoffs
and browser rollout still require joined acceptance evidence in the
[implementation ledger](./better-auth-implementation.md).
