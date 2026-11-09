# BA-01 authenticated password mutation proof

This is an isolated proof for [BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976),
tracked in the [implementation ledger](./better-auth-implementation.md).
It adds no production routes, credential writes or account migration.

## User decision: keep the current device signed in

On **2026-11-04**, the user explicitly chose to keep the current device signed in
after an authenticated password set/change while revoking all other credentials.
Forgotten-password reset still revokes every session.

The prototype replaces the requesting session with a new canonical session and
cookie. The previous requesting cookie, its native tokens, other sessions,
partner credentials and superseded recovery links stop working. The new cookie
belongs to the same user and preserves the original proven authentication time
and session expiry. No bearer token is returned to browser JavaScript.

This supersedes the initial implementation draft that signed out the requesting
device too. That draft was not a production behavior change.

## Supported APIs and stock differences

The tested packages remain pinned to Better Auth **1.7.17**. The proof delegates
password validation, current-password comparison, hashing and credential-account
writes to the same transaction-bound Better Auth authority. It adds no second
password verifier or credential store.

| Public surface or pinned source | What the proof establishes |
| --- | --- |
| [`auth.api.changePassword` and `auth.api.setPassword`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/update-user.ts) | Actual canonical credential mutations, including existing-password and password-policy rejection |
| [`freshSessionMiddleware`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/session.ts) | The prototype requires the original authentication to be within the configured five-minute window |
| [Supported plugin endpoint/context APIs](https://better-auth.com/docs/concepts/plugins) | Authenticated adapters call the server-only password API and create the replacement through `context.internalAdapter.createSession` |
| [`databaseHooks.session.create.before`](https://better-auth.com/docs/concepts/database) | Preserve original authentication age/expiry during replacement; the authority stamps trusted revocation eligibility afterward |
| [Public cookie helpers](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/cookies/index.ts) | Issue the new signed HttpOnly cookie through Better Auth |

Stock change/set-password use `sensitiveSessionMiddleware`, which checks
authoritative session validity rather than freshness. Both accept an unknown-age
fixture session, and neither invokes `onPasswordReset`. Tests record these
observations separately from the guarded requirements.

`setPassword` is a **server-only API**, not a stock public HTTP `/set-password`
route. The explicitly named `/prototype-lifecycle/set-password` adapter is a
disposable proof endpoint. The same applies to the prototype change-password
adapter; this is not a claim of an adopted web/native settings contract.

The existing web set-password route promotes a null verification timestamp on
the assumption that every social provider verified the email. This proof retains
the imported verification boolean/timestamp: adding a password alone does not
prove email ownership. A real signed Google fixture with an unverified email
remains unverified after setting its password. Production adoption must review
this deliberate policy difference.

## One transaction, separate age and revocation eligibility

Each adapter request holds the shared Postgres lifecycle advisory fence and uses
one transaction-bound authority. It verifies a live requesting session, original
authentication provenance and the current revocation generation before calling
the credential API. On success, the same transaction:

1. Applies the real Better Auth credential mutation.
2. Advances the authority's revocation generation and revokes old descendants.
3. Supersedes legacy recovery bindings and newer canonical password-reset rows.
4. Creates and checks a replacement session for the same user.
5. Prepares the new cookie, returning it only after the transaction commits.

The replacement's `createdAt` and `originalAuthenticatedAt` retain the proven
original authentication time. Its new `revocationGeneration` is a trusted,
non-input authority field, independent of wall-clock ordering. The typed
persisted row must match the new user/ID/token, generation, original age and
expiry before cookie publication. Old compromised session lineage is not copied
into the replacement.

For example, a login at 12:00 followed by a password change at 12:04 keeps the
same device signed in, but a freshness-gated operation at 12:05:01 still requires
reauthentication. Ordinary native refresh continues to work without rewriting
the original `auth_time`.

Two mutations in the same millisecond still advance separate generations.
An ahead-clock cutoff is retained rather than cleared or lowered; a genuine
newly authenticated session and its replacement bind to the current generation.
An obsolete generation cannot change credentials even if its signed cookie and
authentication age would otherwise be valid.

The authenticated change-password call disables stock `revokeOtherSessions`
replacement creation because this adapter owns the final continuation. It does
not publish a stock replacement and then revoke it. The user's selected policy
revokes partner credentials too; unrelated accounts and their connections remain
usable.

The isolated [provider link/unlink proof](./better-auth-provider-link-proof.md)
reuses this policy through `credential-continuation.ts`. The shared helper binds
replacement to the exact requesting user, session ID and token, and retains the
existing original age, expiry, hook composition and revocation checks. Provider
continuation is a separate agent decision; it does not broaden the user's
password-specific answer. Password failures still roll back the whole request.

## Automated evidence

`lifecycle-mutations.test.ts` exercises real Postgres and independently created
authorities. Social-only session fixtures use genuine RSA-signed Google tokens;
only the provider JWKS HTTP response is synthetic.

| Scenario | Required observed behavior |
| --- | --- |
| Set/change success | Exact password bytes and stable identity preserved; new cookie works; old requester and other credentials reject |
| Freshness/provenance | Old or unknown age, mismatched generation, missing authentication and an untrusted origin reject before a credential mutation |
| Set password on social identity | One credential account is created, the existing provider subject remains unchanged and unverified state is retained |
| Concurrent set/change | Two authorities using the same old cookie produce one successful mutation and one rejection; only the winning password works |
| Refresh versus change | Any successfully issued old-session descendant rejects once the mutation commits |
| Partner credentials | Actual PKCE-issued access/refresh tokens stop working; unrelated connections continue |
| Recovery and legacy bridge | Bound old links, delayed old-link import, canonical reset tokens and an old signed native artifact cannot restore access or an old password |
| Current native continuation | The exact requesting session's old access/refresh reject; the replacement supports native issue/refresh/validation without renewing authentication age |
| Forgotten reset after continuation | A newly issued valid reset link revokes the set/change replacement cookie and native pair without creating another session |
| Equal/ahead clocks | Generations advance at one millisecond, and a future cutoff remains intact while the authorized replacement works |
| Failure boundaries | Credential-write, revocation, replacement-create, prepared-cookie and late-policy failures roll back; no uncommitted cookie is returned |

Every unsuccessful adapter result rolls back, including a late 403 after an
injected credential write. A provider-translated 500 also rolls back and strips
all pending `Set-Cookie` headers. Failures leave the original password, sessions
and revocation state intact; a retry through a recreated handler commits the new
state without restoring an old hash.

Validation uses the repository's `vp` toolchain:

```sh
vp check packages/backend/src/auth/prototype/lifecycle-mutations.ts packages/backend/src/auth/prototype/__tests__/lifecycle-mutations.test.ts
AUTH_PROTOTYPE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15475/postgres vp test run --config packages/backend/vite.auth-prototype.config.ts --reporter=agent lifecycle-mutations
vp exec tsc --noEmit --project packages/backend/tsconfig.json
```

Measured counts, final validation and independent review are recorded in the
implementation ledger. The fault-injection authority cannot disable this proof's
freshness, origin or CSRF checks.

The final author run on 2026-11-04 passed **28/28** in **25.87 seconds**.
Independent review reran all **28 successfully in 24.76 seconds** with clean
teardown, plus clean selected lint/format checks. The reviewer requested exact
requester-native access/refresh rejection and forgotten reset after both password
operations; those cases are included and re-reviewed. No actionable findings
remain within the documented fixture scope.

## Remaining lifecycle gates

Canonical email verification, email changes and provider link/unlink mutations
are not completed by this password-focused proof. Their supported API hooks,
single-use ownership, revocation and rollback requirements still need separate
evidence. The existing legacy verification/recovery proof remains independent.

Browser cookie continuation is demonstrated here. Native SecureStore handoff,
current-device response compatibility, offline state, account switching and the
deployed web/mobile settings UI still require adoption and device QA. The trusted
native issuance method used by tests is not a public user-ID exchange endpoint.

The global advisory fence proves ordering in this disposable setup, not a
production writer-fencing or scalability design. No restored-production
rehearsal, production collision resolution or migration rollout is authorized by
these results.
