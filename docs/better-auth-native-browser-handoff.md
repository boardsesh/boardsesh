# Selected browser to native sign-in

The selected browser callback uses a backend-owned, single-use `bsnh1_` transfer
capability. It sends the existing native client to the unchanged
`/auth/native/exchange` endpoint and keeps its `{ jwt, refreshToken, expiresAt,
userId }` response. Released clients do not need a new token parser. Legacy
browser transfers retain their existing path.

The callback observes the actual browser source, privately asks the backend to
issue the capability, then re-observes that source before publishing the deep
link. It never decodes a `bsbd1_` backend delegation as a browser cookie, retrieves
a source token by SID, or signs a transfer from public session metadata.

## Authority and lifetime

The two fixed capability families share primary source validation, but have
separate prefixes, AEAD contexts, audiences and backend-only keys.
`NATIVE_BROWSER_HANDOFF_SECRET` must contain at least 32 bytes and differ from
the configured browser, delegation, private RPC, cron and deleted-email keys.
The web runtime does not receive this key. Native transfer tokens are bounded
to 4,000 ASCII bytes so the unchanged 4,096-byte native request body can hold
the JSON wrapper.

Issuance admits the real source and browser binding under the current authority.
The capability expires at the earliest of 120 seconds, the original source
deadline and the binding deadline. Redemption rechecks the source, exact binding
version, authority, account generation and SID denial on primary. Canonical
sources require both SID and the SQL hash of the originally presented token;
only metadata is selected. Legacy sources retain their issuer-key digest.

Original authentication age and unknown-age ancestry are copied. Issuance,
navigation and callback time do not create fresh authentication. A successful
exchange keeps the existing native access and refresh lifetimes; the transfer
capability's two-minute deadline does not become their lifetime.

## Atomic redemption and maintenance

The native issuer runs on the same qualified connection and transaction as
source admission and the spent-capability insert: authority gate, user, browser
binding, receipt, then native credential creation. The receipt uses both
server-derived primary-key fields in `verificationTokens`, under the dedicated
`ba03-native-handoff-v1:` namespace. It stores only the capability hash and
absolute expiry. Repeating a live spent capability returns 409. An issuer error
or lost final database deadline rolls back both writes. Unknown commit
acknowledgement returns 503 and never reconstructs a token pair.

The explicit `private-native-handoff-v1` contract extends the reviewed
first-password contract with `mobile_refresh_tokens INSERT`. Earlier contracts
continue to reject that extra permission. The existing minute worker drains
native receipts through a compatible qualified credential connection, including
while browser rollout is off; there is no content-connection fallback. One run
removes at most 1,000 expired rows, skips locked rows, and compares the legacy
timestamp-without-timezone column against database UTC time. Host-clock skew
cannot make a live capability replayable. No new migration or timer is needed.

## Qualification still required

Public browser readiness remains false. This slice does not qualify native
registration, password/provider login or refresh on the restricted writer,
retire their existing issuers, change production grants or activate the browser
coordinator. Keep the qualified connection available through capability expiry
and receipt cleanup before downgrading its profile. Actual supported-browser
callback, deep-link and released-device checks remain rollout gates in #7430,
alongside the original owner rehearsal, history/Flight isolation and retirement
evidence. The epic remains open until those gates are met.
