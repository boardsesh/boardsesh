# BA-01 configured Facebook browser-provider proof

This supplements the [implementation ledger](./better-auth-implementation.md)
and [OAuth prototype evidence](./better-auth-prototype.md) for
[BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976).
It exercises the configured Facebook browser flow with **Better Auth 1.7.17**,
its real Drizzle adapter, and disposable Postgres databases. Production sign-in,
provider registrations, callback URLs, account linking and account records are
unchanged.

## Public APIs and pinned source

| Surface | Proof dependency |
| --- | --- |
| [`socialProviders.facebook`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/core/src/social-providers/facebook.ts) | Real authorization URL, code exchange, opaque-token app/user inspection, Graph profile lookup and subject comparison |
| [`mapProfileToUser`](https://better-auth.com/docs/authentication/facebook) | Recover an imported account's persisted email/name/verification only after its Facebook subject is established; never invent an address |
| [`/sign-in/social` and `/callback/:id`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/callback.ts) | Actual Better Auth state handling, redirects, cookie issuance and canonical session creation |
| [Generic state implementation](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/state.ts) | Signed state-cookie comparison, database-backed state and expiry, and the stock read/delete race |
| [Context defaults](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/context/create-context.ts) | Test mode skips origin validation unless explicitly configured; this proof sets `disableOriginCheck: false` and `disableCSRFCheck: false` |

The tested Graph path uses the pinned provider's `v24.0` authorization and code
endpoints, then `/debug_token` and `/me`. The test replaces only HTTP responses
from `graph.facebook.com`. Better Auth handlers, cookies, state verification,
provider logic, account lookup and Postgres remain real. Synthetic code exchange
is single use, checks the configured app credentials and exact declared callback,
and returns a synthetic opaque access token. No real Meta app, user token or
production account is used.

This is the opaque access-token/Graph browser path. It does **not** establish
Facebook Limited Login ID-token signature, audience or nonce behavior. The
pinned provider has a separate ID-token branch; the Graph assertions must not be
generalized to that branch.

## Results and decisions

`facebook-providers.ts` configures only the disposable Facebook client.
`facebook-browser.test.ts` records **22 passing tests** on 2026-11-04.

| Requirement | Observed result |
| --- | --- |
| Existing imported subject | A second authority completes the callback and returns the same application user ID; the stored provider subject remains unchanged |
| Changed provider email | Even when the changed claim matches another account, the imported subject authenticates its original owner and preserves the local email |
| Missing provider email | The supported mapping hook resolves the existing Facebook subject to its stored address; stored unverified state stays unverified |
| Unknown identity | An unknown subject without email fails with `email_not_found`; no placeholder email or account is created |
| Existing email, unlinked subject | Even a verified matching email fails with `account_not_linked`; no implicit provider link or session is created |
| State and cookie binding | Missing, corrupted or another flow's state cookie, substituted state, and completed-state replay fail before provider code exchange |
| Cancellation | `access_denied` returns to the validated error callback, preserves its existing query parameters, consumes state, and creates no session |
| Bad provider responses | Invalid/consumed codes, wrong app IDs, invalid tokens, mismatched Graph subjects and rejected profile responses fail without authentication |
| Provider token redirect | The pinned token exchanger refuses a redirect; no app credentials are forwarded to another origin |
| Declared callbacks | Authorization and token exchange use the explicit provider callback; request-query substitution cannot replace the stored successful destination; untrusted success/error destinations are rejected |
| Transaction failure | A post-session exception returns 500 and rolls back canonical session creation, account token updates and database state consumption |

Email fallback uses `(facebook, provider subject)`, after the opaque-token Graph
checks. Matching email alone never selects a migration owner. Disabled implicit
linking is an explicit prototype safety policy, not a silent production change.
The production migration still needs its reviewed account-linking/recovery UX.

## Stock callback race and guarded proof

Pinned `parseGenericState` reads the verification record and later deletes it;
it does not condition authentication on an atomic consume result. A deterministic
test uses the public `verification.delete.before` hook to hold both callbacks
after their reads. Two different valid provider codes then authenticate two
different imported subjects using the same state and cookie. The test changes
scheduling only. Its green characterization result records an unsafe stock
configuration; it is not a passing migration invariant.

The guarded tests run the same Better Auth handlers through the existing
transaction-bound prototype wrapper and shared Postgres advisory fence. Two
competing callbacks produce one authenticated result; the other receives
`state_mismatch` before exchanging a code. The same wrapper rolls back database
changes when Better Auth converts an exception into an HTTP 500 response.
This coarse global fence proves ordering, not production throughput or a
complete mixed-version credential-writer boundary.

An external provider's already-consumed code cannot roll back with our database.
After the injected failure, browser authorization must restart. The test does
not promise that restoring a database state record makes a consumed Meta code
usable again.

## Validation and remaining gates

```sh
vp check packages/backend/src/auth/prototype/facebook-providers.ts packages/backend/src/auth/prototype/__tests__/facebook-browser.test.ts
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres vp test run --config packages/backend/vite.auth-prototype.config.ts --reporter=agent facebook-browser
vp exec tsc --noEmit --project packages/backend/tsconfig.json
```

The focused tests, scoped lint/format check and backend typecheck pass. Final
combined validation is recorded separately in the implementation ledger.
Independent review reran all **22 Facebook cases** with strict origin/CSRF
settings, alongside transfer/native regressions: **109/109 passed** in
**3.92 seconds** with clean teardown. The reviewer approved the guarded behavior
and the explicit stock-race characterization; no actionable findings remain in
this fixture scope.

No real Meta application configuration, deployed callback migration, browser
cookie jar/TLS interaction with Meta, consent-screen behavior, provider outage
recovery UX, Limited Login flow, or first-party production rollout is proved by
this transport harness. Those acceptance gates remain open until their own
evidence is recorded.
