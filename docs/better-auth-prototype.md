# BA-01 OAuth prototype evidence

This is the disposable OAuth portion of [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975),
tracking [BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976).
The [implementation ledger](./better-auth-implementation.md) owns overall gate
status. These experiments do not mount production routes, change the active
credential writer, migrate accounts, or authorize partner launch.

## Exact dependency and API references

The prototype pins `better-auth`, `@better-auth/oauth-provider`, and
`@better-auth/drizzle-adapter` to **1.7.17**, the stable release published on
2026-11-04. All three packages declare MIT licenses. Dependency resolution is
recorded in the root lockfile; Node and Drizzle remain the repository's pinned
toolchain. See the [release](https://github.com/better-auth/better-auth/releases/tag/v1.7.17),
[auth manifest](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/package.json),
[provider manifest](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/package.json),
and [adapter manifest](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/drizzle-adapter/package.json).

| Supported surface | Use in this proof |
| --- | --- |
| [`oauthProvider` options](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/src/types/index.ts) | Authorization code and refresh grants only; PKCE S256; custom application scopes; opaque tokens; explicit lifetimes |
| [Public provider exports](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/src/index.ts) and [`getOAuthProviderApi`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/src/token.ts) | Authenticate clients and hash presented tokens without implementing another client-secret verifier |
| [Provider schema](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/src/schema.ts) | Drizzle-generated disposable tables, including immutable `authorizationCodeId` carried through refresh descendants |
| [Discovery implementation](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/src/oauth.ts) | RFC 8414 path insertion and OIDC path append; exact issuer equality |
| [Consent deletion](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/src/oauthConsent/endpoints.ts), [token rotation](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/src/token.ts), and [revocation](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/oauth-provider/src/revoke.ts) | Characterize lifecycle gaps before applying explicit prototype guards |

Updates must pin these packages together, inspect upstream security advisories
and lifecycle changes, regenerate the disposable schema when needed, and rerun
the isolated Postgres suite with independent security review. A later package
version does not inherit this proof automatically.

The schema generator uses a connection-free Drizzle adapter and disables resource
seeding for generation only. Better Auth initializes plugins eagerly, and the
OAuth plugin normally seeds its configured resource rows during initialization;
a seemingly lazy postgres-js client would therefore still attempt database I/O.
The offline-generator regression completes plugin initialization while rejecting
any PostgreSQL client construction. Actual protocol tests continue to use real
Postgres. Their environment awaits both authority initializers before exposing
the fixture, and bounds admin connection, statement and lock waits so database
cleanup cannot silently outlive the test hook.

## Configuration decisions

The synthetic issuer is `https://auth.boardsesh.test/api/auth`; its resource is
`https://api.boardsesh.test/v1`. Discovery is requested at
`https://auth.boardsesh.test/.well-known/oauth-authorization-server/api/auth`
and `https://auth.boardsesh.test/api/auth/.well-known/openid-configuration`.
The metadata must return the same complete issuer and the corresponding
`/api/auth/oauth2/*` endpoints.

Access tokens last **3,600 seconds**, refresh tokens **90 days**, and codes
**60 seconds**, matching the [accepted contract](./partner-api.md). Refresh
permission requires `offline_access`. Rotation has no reuse grace interval.
Tests check actual persisted expiries, token hashes, and successful rolling
refresh on day 30 and day 91. `openid` is enabled to exercise OIDC discovery in
this experiment; this is not a decision to add OIDC scopes to the public partner
contract. With `disableJwtPlugin: true`, access tokens stay opaque even when
bound to a resource. The provider consequently stores confidential-client
secrets encrypted; access and refresh token lookup values are hashed.

Anonymous and dynamic client registration remain disabled. Fixture clients are
created through the provider's server-only admin API. Per-client resource links
are explicit. These fixtures do not prove a developer registration product.

## Stock behavior versus guarded behavior

`oauth-provider.test.ts` runs actual Better Auth handlers and the Drizzle
adapter against a newly created local Postgres database. Two independently
created authorities share that database. Tests never substitute a memory
adapter or mocked database. Stock characterization assertions describe observed
limitations; their green result does not mean the contract is satisfied.

| Requirement | Stock 1.7.17 observation | Guarded prototype proof |
| --- | --- | --- |
| Code and refresh single use | Conditional consumption prevents two successful redemptions; source documents an unclosed refresh-issuance/invalidation transaction race | Whole-request Postgres transaction plus a shared advisory lock serializes competing instances |
| Refresh-family isolation | Consumed-token reuse invalidates every grant for the same app/user | Authenticated middleware deletes only the matching immutable authorization-code family; another grant for the same app/user survives |
| Cross-client revocation | The consumed-refresh revoke branch invalidates a supplied client/user family before checking token ownership | Known cross-client refresh tokens reject refresh or return RFC 7009's successful no-op for revocation, without reaching stock cleanup |
| Expired consumed-token revocation | Stock revoke can reach broad cleanup even after the old token expires | An expired token is a successful revocation no-op; a later independent grant survives |
| Revocation input normalization | The endpoint accepts whitespace and Bearer/DPoP token presentation; a raw-only guard would miss those lookup values | The same exported normalization helper runs before guarded lookup, and opposite supported token-type hints search the actual known token type |
| Product Disconnect | Deleting provider consent alone leaves existing tokens and refresh credentials usable | One transaction revokes every token family, consent, and pending code for the connection, and advances a persisted connection generation |
| Consent ownership | A signed query is not a stored interaction tied to the person and session that saw the screen | A digest identifies a single-use interaction bound to user ID, session ID, connection generation, and expiry |
| Failure during mint | A handler may turn an exception into HTTP 500 before the transaction caller sees it | A 500 response forces rollback; an injected post-mint failure leaves no token rows and does not consume the code |

The family middleware calls the provider's exported client authentication API
before token lookup or deletion, including for public clients whose registered
method is `none`. Wrong or missing confidential-client secrets cannot revoke a
family. Active token issuance still runs through the provider; the middleware
does not issue OAuth credentials or implement its own password/client policy.

Consent tests cover account switching, another session for the same account,
query tampering, interaction replay, narrower scope approval, later scope
expansion without widening old tokens, Disconnect against issuance, stale
consent after Disconnect, and explicit reconnect after handler recreation.
Ordinary RFC access-token revocation preserves the refresh credential.

The reconnect guard follows both supported authorization transports: GET query
parameters and form POST body parameters. A POST request's URL query cannot
override the body client or bypass renewed consent. A final independent review
added a regression for this distinction, including completing the resulting
consent and redeeming its code. Joined reset/redemption regressions also verify
that a pending code cannot recreate a partner family after password reset: the
provider requires the original canonical session, which reset revokes. Both
race orderings leave no usable partner descendants.

Validation on 2026-11-04: **43 OAuth integration tests passed** against local
Postgres. The reviewer-requested cases include raw, whitespace, Bearer, and DPoP
presentations for both independent-family and cross-client consumed-token
revocation, expired consumed ancestors, and incorrect supported token hints.
The finalized isolated suite passed all **144 tests in 9 files**, including clean
database teardown and the offline schema-generator regression. The source
passed backend TypeScript checking; the exact run commands and
combined validation totals are recorded in the implementation ledger.

## Limits that keep the production gates closed

The transaction guard deliberately uses one coarse Postgres advisory lock for
all prototype auth operations. It proves ordering and rollback, not production
throughput. Every production request path, credential mutation, and worker would
need the same reviewed authority boundary. The prototype scans its tiny
verification fixture table to remove pending connection codes; production needs
explicitly owned and indexed interaction records and cleanup policy.

The suite proves persistence across authority/handler recreation, not a killed
operating-system process or database recovery. The real-browser/proxy evidence
and any remaining first-party/native proofs are recorded separately in the
implementation ledger. Provider signatures use synthetic keys in the identity
suite; no production OAuth credentials are used.

The cookie `get-session` test shows that an OAuth bearer token does not create a
first-party Better Auth cookie session. It does not prove every production
GraphQL, native/watch, developer-management, or WebSocket guard. App-specific
subject identifiers, production CORS/rate limits, developer consent screens,
pending-workout revocation, operational monitoring, and a scalable writer fence
remain separate acceptance work. No production account collision counts or
ownership conclusions are inferred from these synthetic fixtures.
