# Unmounted canonical-www proof cookie codec

This BA05 prerequisite adds a server-only codec, not a public route or an
authentication decision. The backend supplies the authoritative binding digest
and selection version. The reader selects only that exact cookie family; it
never chooses the highest cookie version or falls back to a legacy cookie.
Rollout remains tracked in #7430 and public bootstrap remains unqualified.

The stable `__Host-boardsesh.browser-binding` correlation cookie has a constant
relative 30-day Max-Age. Only a future qualified canonical-www coordinator may
publish it. Ordinary proof candidates cannot emit or clear it. The dedicated
builder validates an exact HTTPS serving/canonical origin and the digest of its
32-byte opaque token. The pointer alone cannot authenticate or retrieve a proof.

An actual source proof uses the name
`__Host-boardsesh.browser-proof.<bindingId>.<selectionVersion>`, with numbered
chunks when needed. Its canonical base64url envelope contains only version 1,
the explicit `legacy-jwe` or `canonical-token` kind, and the exact raw source.
The codec does not decrypt, verify or authorize that credential. The backend
must still verify source possession and all current selected identity,
generation, age/provenance, authority and deadline evidence.

All emitted cookies use Secure, HttpOnly, Path=/ and SameSite=Lax, with no Domain.
They are host-only on www; the static app accesses them through credentialed
requests to that exact origin. Duplicate names, base-plus-chunk ambiguity,
missing/gapped/noncanonical chunks, malformed envelopes and size overflow are
refused. A missing current proof remains missing even if valid older, future or
different-binding cookies are present.

Cleanup clears only exact names observed on the request whose binding matches
and version is strictly older than the backend cursor. It never invents chunk
deletions or clears current/future/different-binding/correlation names. Cleanup
is bounded to 16 headers; leftover older names remain ineligible for selection.
Same-version chunk-layout changes fail before publication rather than deleting
current names. Their working renewal protocol remains to be qualified.

The trusted server-only `retainObservedProofCookies` option defaults to false.
A provider result planner may pass literal true to retain the exact old actor
proof needed for a bounded ACK. This emits no older-proof cleanup and counts
every actual old proof and operation carrier toward projected capacity; it does
not filter or hide observed headers. Malformed option values fail closed.
The projected next request must also fit the reader's 128-cookie-pair limit.
This counts unrelated cookies, retained proofs and every future proof chunk;
only exact overwritten or explicitly cleared names leave the projection. A
candidate that fits the byte budget but exceeds this count fails before the
caller can mutate credentials or publish headers. Exact-capacity replacements
and observed older-family cleanup remain readable.
Initial provider finalization must retain both actor possession and recovery
capabilities until next-request ACK is qualified. Complete reply/header loss
without the exact candidate still needs separate fresh same-owner recovery.

`buildBrowserProofCookieCandidate` is synchronous and immutable. Call it before
a credential/selection mutation, then retain the backend transaction/receipt
and publication fences. It bounds each cookie header, aggregate Set-Cookie
headers, source size/chunks and the projected next Cookie header after applying
the exact planned writes/clears to the complete observed header. Unrelated
cookies and duplicate unrelated names count toward capacity and are preserved.
The conservative projected-cookie ceiling is 8 KiB; callers may reserve a smaller
budget. These are library ceilings, not proof of actual ingress/proxy settings.
The caller must derive proof Max-Age from the admitted actual source deadline;
the codec must never turn a requested TTL or an envelope kind into authority.

The projection knows only the observed snapshot. Unseen delayed responses may
still introduce additional old families. Total header capacity across pending
callbacks, browser storage limits and working cleanup/recovery therefore remain
coordinator/deployment qualification gates. No production header limit changes
are made here.

## Owned evidence and explicit counterexample

The scoped unit suite checks exact-cursor selection, both kinds, strict envelope
and chunk rejection, host-only scope, bounded observed cleanup, immutable plans
and source/response/projected-request/layout failures before a mutation callback.

The explicit HTTPS Chromium fixture uses real NextAuth JWEs and canonical tokens
created through the actual authority in a fresh disposable database. A is already
possessed before its response is held. B then signs in, either as another UID
or the same UID with a new SID. Releasing A's old version and old-name cleanup
preserves B's exact UID/SID/source. The JWE cases use real chunked proof cookies;
a foreign binding remains untouched. Correlation alone yields no identity or
proof header. Actual signed oversized and header-overflow candidates leave the
fixture's mutation counter unchanged. This is a codec/transport proof, not a
production database-transaction or mounted route proof.

The same-version renewal control intentionally reproduces a remaining failure:
two actual JWEs retain the same UID/SID/generation/original age and issuer
lifetime, but are issued at different times. Releasing the earlier cookie after
the later renewal restores its older signed expiry. At that old deadline the
browser loses admission although the later source is still valid. This passing
characterization is evidence AGAINST claiming rolling renewal fixed. Credential
revision names or canonical publication serialization must resolve it; binding
metadata must never substitute for the missing/expired actual proof.

The joined result-recovery fixture adds the shipping central reader and private
browser/provider HTTP clients and handlers over an explicit disposable database.
It uses the actual provider finalizer and ACK transaction for both selected
authorities and source kinds. Chromium installs the real host-only proof and
sealed operation cookies. A deliberately truncated body preserves the old actor
and exact new candidate for the next request; dropped complete headers or an
unknown finalizer reply cannot reconstruct the absent candidate. Delayed original
headers remain inert after a later actual coordinator login. Header planning
uses the complete actual incoming cookie header before the first mutation;
oversized unrelated cookies or a missing actual actor leave credentials intact.
Only owned accounts, loopback listeners and synthetic provider ownership are
used. The private handlers receive the explicit fixture database; restricted
LOGIN qualification remains separately proved by the credential-writer suite.
This does not mount the application catch-all, prove real provider consoles,
qualify whole-application browser publication, or close the complete-header-loss
fresh-proof recovery gate. The required compatibility CI task runs after its
existing Chromium installation, with a targeted web-auth source filter.

```sh
vp test run --project web packages/web/app/lib/auth/__tests__/browser-proof-cookies.test.ts --reporter=agent
AUTH_PROTOTYPE_DATABASE_URL='<explicit owned localhost admin URL ending /postgres>' \
  vp test run --config packages/web/auth-prototype/browser-proof-cookies.vite.config.ts --reporter=agent
vp exec tsc -p packages/web/auth-prototype/tsconfig.json --noEmit
```

Only owned loopback www/app HTTPS origins and synthetic accounts are used.
WebKit is not installed and remains unqualified. Concurrent distinct-binding
bootstrap, complete primary SSR/session/ws reader adoption, broker publication,
mixed-version retirement, rolling renewal and usable missing-proof/account-switch
recovery remain open. No public routes, selectors, credentials or deployment
settings are activated by this slice.
