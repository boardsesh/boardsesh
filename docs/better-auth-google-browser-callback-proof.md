# BA-01 Google browser authorization-code callback proof

This isolated [BA-01 #6976](https://github.com/boardsesh/boardsesh/issues/6976)
proof closes the configured Google browser callback evidence gap. It adds only
tests and this document. Existing provider/password/handoff implementations,
production routes, schema and dependencies remain unchanged.

## Actual flow and assurance boundary

The test calls the configured pinned Better Auth **1.7.17** public sign-in and
explicit-link APIs, obtains the real Google authorization URL, and sends the
callback through a second independently constructed authority sharing the same
disposable Postgres database. Only external provider HTTP transport is replaced.
No account, state, session, cookie, verifier or adapter method is mocked.

The authorization URL must use the configured Google client, canonical callback,
`response_type=code`, expected scopes, random state and PKCE S256. The actual
token request to `https://oauth2.googleapis.com/token` must send the same
redirect/client credentials and a verifier matching the original challenge.
The fixture token endpoint consumes each code once and returns a genuinely
RSA-signed Google-format IDtoken. Endpoint errors and redirects are rejected.

The assurance is **authenticated authorization-code exchange plus state and
PKCE**, under the configured provider token-endpoint trust boundary. In this
pinned browser branch, Google's `getUserInfo` decodes the IDtoken returned by the
token endpoint. It does not independently fetch JWKS or run the native IDtoken
verification function. The test asserts that the only provider HTTP request is
to the Google token endpoint; a signed fixture alone is not proof that the
browser path checks that signature, audience, issuer, expiry or nonce.
Those native-token checks are independently covered by the existing
[identity](./better-auth-prototype.md) and
[provider link](./better-auth-provider-link-proof.md) proofs. This document does
not transfer native assurance claims to the browser branch.

| Pinned public source | Observed role |
| --- | --- |
| [`signInSocial`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/sign-in.ts) / [`linkSocialAccount`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/account.ts) | Start configured browser authorization through actual public APIs |
| [`google.ts`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/core/src/social-providers/google.ts) | Google authorization URL, token endpoint and IDtoken profile decoding; separate native verifier |
| [`validate-authorization-code.ts`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/core/src/oauth2/validate-authorization-code.ts) | Actual code/verifier/redirect/client token request and redirect refusal |
| [`callback.ts`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/api/routes/callback.ts), [`state.ts`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/oauth2/state.ts) | Canonical callback, signed state cookie and database-backed state consumption |
| [`link-account.ts`](https://github.com/better-auth/better-auth/blob/v1.7.17/packages/better-auth/src/oauth2/link-account.ts) | Existing provider-subject mapping and disabled implicit email linking |

## Evidence

The new `google-browser-callback.test.ts` uses the existing synthetic configured
Google clients and imported identity planner. It proves:

1. An imported Google subject signs into its stable user even when its changed
   provider email belongs to another local user. Neither local account is merged
   or reassigned, and the unrelated user's cookie remains usable.
2. A new subject with a new email creates one canonical identity through the
   actual callback. An unknown subject with an existing user's verified email
   returns `account_not_linked` without attaching an account or issuing a session.
3. Cancellation, missing signed state cookie, failed code exchange and a token
   endpoint redirect create no session. Consumed callback state cannot be reused;
   a new flow remains usable after cancellation.
4. An explicit fresh browser link with a different provider email preserves the
   local identity/verification and original session age/expiry while replacing
   the requester through the existing reviewed continuation. Linking another
   user's subject rejects409 and consumes the validated custom intent, preserving
   both existing owners and the original actor session.

This is a handler/transport integration proof. It does not contact Google with
real client credentials, validate a registered redirect in Google's console, or
exercise actual browser navigation/SameSite policy, consent UI, real-device
deep links or production routing. The migration's production cutover and
provider-registration gates remain in the implementation ledger.

Independent security QA approved the final source/document and reran all **9
cases** successfully on isolated Postgres15 (2.50 seconds total) and Postgres18
(2.46 seconds total), with clean teardown. Backend typechecking and selected-file
`vp check` pass with zero warnings/errors. No runtime change was needed.
