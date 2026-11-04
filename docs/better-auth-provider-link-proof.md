# BA-01 explicit provider link and unlink proof

This disposable [BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976)
proof adds no production endpoint, dependency, schema, identity import or
credential writer. It uses pinned Better Auth **1.7.17**, the existing canonical
Postgres tables and the same provider verification adapters as sign-in.
The [implementation ledger](./better-auth-implementation.md) owns rollout status.

## Recorded decisions

The provider continuation policy is an **agent decision**, consistent with the
password experience; it is not an explicit user answer about provider policy.
A fresh, authenticated link or unlink replaces the requesting session with a
new session for that same user, preserving its original authentication time and
expiry. Previous sessions, native descendants, partner credentials and older
recovery/verification bindings are revoked. Linking never merges users,
reassigns an existing provider subject or changes local email/profile/verification.
The user's explicit password-specific choice remains documented in the
[password proof](./better-auth-lifecycle-proof.md).

The adapter forces `disableImplicitLinking: true`, `allowDifferentEmails: true`,
`allowUnlinkingAll: false` and `updateUserInfoOnLink: false` after caller options.
`trustedProviders: ['facebook']` applies only inside this explicit-link adapter.
For Facebook, a real app-bound `debug_token` result and matching Graph subject
establish ownership of the provider account. They do not establish mailbox
ownership. Graph's missing `email_verified` is never synthesized, and an
unverified local user remains unverified. An unknown matching-email Facebook
sign-in still returns `account_not_linked` with implicit linking disabled.
Google/Apple new-link verification rules remain unchanged.

An unlink must leave one usable, unambiguous configured sign-in method. A
credential method must have exactly one canonical credential row with
`accountId === userId` and a valid supported bcrypt hash. Stock email sign-in
cannot select a foreign `accountId`; duplicate credential rows are rejected
conservatively even if stock can currently authenticate one. A retained social
method must have a unique `(provider, subject)` owner and a fixed enabled
provider configuration with nonblank client identifiers, secret and any
explicit audience. This conservative complete-configuration check does not
claim that every native-only flow technically needs a client secret.

## Public interfaces and pinned behavior

| Public interface / pinned source | Evidence and required glue |
| --- | --- |
| [`linkSocialAccount`, `unlinkAccount`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/account.ts) | Actual provider verification and canonical account writes; stock link uses a valid session, while unlink's last-method check counts account rows rather than usable methods |
| [`linkOAuthAccount`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/oauth2/link-account.ts) | Explicit state-bound linking and separate implicit-linking policy; the adapter additionally rejects every ambiguous or foreign subject owner before writes |
| [`generateState` / `parseState`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/oauth2/state.ts) | Real database-backed OAuth state plus signed state cookie; a separate hashed-state receipt binds exact current user, session, provider, generation and freshness deadline |
| [Google/Apple/Facebook provider APIs](https://github.com/better-auth/better-auth/tree/v1.7.17/packages/core/src/social-providers) | Actual RSA/JWKS, issuer, audience, expiry, nonce, code exchange and Graph verification; fixtures replace only provider HTTP transport |
| [Plugin endpoints/hooks](https://better-auth.com/docs/concepts/plugins), [`dispatch.ts`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/dispatch.ts) | Supported adapters and a final public after-hook observer; pinned dispatch runs the global after-hook first, then plugin after-hooks in configured order |

The shared `credential-continuation.ts` extracts the previously proved password
business logic without adding a verifier or credential store. It selects the
persisted source by exact user/session ID/token, checks expiry, original
authentication provenance and revocation generation, and requires the same
source ID/token again at replacement. An older same-user session cannot replace
a later session. The canonical authority still owns password comparison/hash,
provider verification, account mutation, session creation and signed cookies.

All operations hold `pg_advisory_xact_lock(6975, 1)` inside the existing
whole-request transaction. The provider map callback observes only the subject
produced by the real verifier, checks ownership under that fence and rechecks
freshness after network work. The transaction commits before any response or
cookie is published. This coarse global fence is prototype evidence, not a
production throughput design.

## Terminal browser callback policy

The browser proof uses Facebook's real authorization-code path across two
independently constructed authorities. Before code exchange, a GET callback
must prove the current fresh canonical actor matches the stored intent's exact
user, session, provider and revocation generation. Wrong/unknown/stale actors
reject before consuming the intent. A validated receipt is consumed in the
outer fenced transaction; the provider/account/continuation work runs in a
savepoint.

Cancellation, provider rejection, policy denial and post-link failure roll back
that savepoint, preserving original accounts and sessions, while committing the
receipt's consumption. The user must start a new flow. This is an explicit
security-mutation-on-error exception for validated callbacks; password errors
continue to roll back the entire request. All failed `Set-Cookie` headers are
dropped, including pending session and state-cookie changes, to avoid clearing
a newer canonical login. A stale state cookie may remain until overwritten or
expired. Restored stock state is unreachable through the spent custom receipt;
any future mounted link callback must pass through this guard, with no raw
stock callback bypass.

Pinned dispatch can retain an explicit callback HTTP302 and success Location
after a later hook yields an APIError403. The final observer is appended after
every caller plugin and inspects the public final returned APIError or Response,
including policies installed through `options.hooks.after`. The wrapper returns
the actual denial status, rolls back the savepoint and commits only receipt
consumption. Tests assert403 without weakening the assertion to302.
The observer uses the public `isAPIError` classifier, including the base error
returned by supported `context.error()`, rather than one subclass identity.

Stock accepts form POST callbacks by redirecting to a same-path GET before
state exchange. With origin/CSRF checks forced on, a cookie-bearing untrusted
provider-origin POST rejects403. A cookie-less cross-site navigation POST from
Apple, Facebook or without Origin only normalizes to the same-path GET: it
does not exchange a code, consume an intent or create a cookie. The subsequent
GET without cookies rejects401; with the original canonical and signed-state
cookies it passes the strict actor/intent checks. This represents SameSite=Lax
cookies omitted on cross-site POST and returning on top-level GET. A trusted
same-origin form also normalizes successfully. No CSRF/origin option is disabled.

An actual Apple authorization-code fixture follows `response_mode=form_post`,
normalization and the authenticated token-endpoint exchange, returning a genuine
signed Apple-format IDtoken. Pinned Apple browser code decodes the trusted
token-endpoint IDtoken; it does not add the native branch's JWKS/nonce checks or
declare a browser IDtoken nonce requirement. Its ownership proof is the
authenticated authorization-code exchange plus state. Native Apple signature,
audience and nonce verification remain separately proved. These handler-level
transport tests do not prove real-browser SameSite policy across a redirect
chain, provider registrations or device behavior; those remain adoption gates.

## Automated evidence and limits

The provider suite has **51 passing cases**. The password suite has **32 passing
cases**, including its original28 plus plugin/global APIError and Response
denial publication regressions. Independent security QA approved the final
source and reran all **83 cases** successfully on isolated Postgres15 in27.05
seconds and Postgres18 in27.35 seconds, with clean teardown. Backend typechecking
and selected-file `vp check` pass with zero warnings/errors. Review evidence is
also tracked in the implementation ledger.

| Case | Required outcome |
| --- | --- |
| Native Google/Apple | Real signed subject ownership, distinct email, Apple nonce/returning missing-email mapping; wrong audience/issuer/signature/expiry/nonce rejects |
| Actor and ownership | Missing/old/unknown/future/stale-generation session, hostile origin, wrong actor, duplicate or foreign subject rejects; concurrent different-user linking has one owner |
| Unlink | Wrong owner/last usable method, ambiguous social or credential identity and empty configured audience/client reject; valid alternative permits unlink |
| Browser state | Real Facebook code and Graph exchange works across instances; account switching, missing signed state cookie, cancellation, replay, concurrent callback and aged intent cannot create another link |
| Lifecycle/failure | Real reset invalidates pending link; callback/reset and callback/Disconnect serialize; partner tokens stay dead and unrelated grants stay live; late403/500/redirect policy rolls back credentials and emits no usable cookie |

No production uniqueness migration, account settings UI, raw-route writer
cutover, provider registration change or real-provider credential validation is
claimed. Static provider configurations, indexed typed interaction storage,
production lock granularity, account deletion/collision operations and actual
browser/native device transport remain adoption work. Provider continuation and
the narrow Facebook trust setting require production policy review.
