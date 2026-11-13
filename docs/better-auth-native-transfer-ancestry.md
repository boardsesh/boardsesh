# Native transfer and watch capability ancestry

This source continuation belongs to epic #6975; rollout receipts and all
activation work remain in #7430. It changes no schema, public request/reply field,
paired-watch refresh contract, production grant, deployed mode or activation gate.

## Transfer and refresh

A signed HMAC transfer carries only optional literal `legacy_no_sid: true`.
Present non-true markers are refused. A newly exchanged transfer with no source
SID is visibly unidentifiable too, so it is treated conservatively without forcing
a new login. A stable unmarked source keeps the existing distinct native family.

Unknown source ancestry is carried in the issuer-owned opaque SID namespace
`credential-web:v1:<canonical lowercase UUIDv4>`. Other versions or malformed
values in the reserved `credential-web:` namespace fail closed. Both the native
JWT SID and `mobile_refresh_tokens.session_id` already use opaque text. Every
refresh copies the SID and authentication time. No code-creation, exchange or
rotation time becomes a new authentication proof.

Native canonical binding uses `credential:native-refresh:` for this namespace.
The existing canonical reader consequently retains the account-cutoff requirement
even when an optional lineage row is absent. A conflicting canonical SID/owner or
lineage binding aborts rotation without overwriting the conflicting row. Native
signout explicitly retires both native lineage namespaces; it continues to end
the native domain and leaves the source website login admitted. A later explicit
canonical web logout of unknown ancestry uses the existing conservative account
cutoff and ends every historical raw/renewed alias. Replayed old logout cannot
end a later password login.

The issuer rechecks capability expiry after the user lock and before commit.
HMAC exchange retains the installed verifier's inclusive integer-seconds clock
tolerance; its final valid-until ceiling uses the same accepted window. This is
transport grace, never authentication age. Newly issued native pairs retain their
existing public lifetimes.

## Private watch capability v2

`AUTH_WATCH_PAIRING_MODE` defaults to `legacy`. Upgraded consumers always understand
v2; `source-bound-staging` enables its emitter. Native generation revocation also
requires this selector, while the existing Garmin activation blocker remains
unchanged. The selector is included in the existing cutoff-enforcement startup
prerequisites. No selector qualifies reader deployment or closes a rollout gate.

The public code remains eight characters. The private Redis value becomes strict
v2 JSON containing a unique nonce, source principal, source subject generation,
source SID/unknown ancestry, original authentication time or null, signed source
expiry, and bounded capability expiry. Native sources also retain their native
generation; web sources stay independent of native-only signout. The exact raw
JWE/JWS is cryptographically reverified against the middleware-admitted principal
and generation before creating the capability. Displayed session fields and
caller body fields cannot become its proof.

The capability lasts at most five minutes and is capped to signed source expiry.
Redis `PXAT`, the private absolute expiry and the public `expiresAt` agree. A
source that expires during Redis allocation is refused. Redis >= 6.2 was already
a backend prerequisite and supports this absolute-expiry command.

Consume compares and deletes the exact private value, including its nonce. A
replacement for the same user at the same code is a different capability. The
native issuer then locks the user and rereads primary state in the same issuing
transaction: changed subject generation, native-source generation, denied source
SID or an expired capability refuses minting. Once consumed, a capability is
terminal even when a cutoff or timeout refuses issuance. It is never restored
after a denied or uncertain mint. Replayed codes cannot change newer credentials.

Legacy plain-UID values remain readable only in legacy mode before an enforced
manifest and without any generation/denial evidence. Consumption takes the shared
manifest gate before the user lock and checks those premises in the issuing
transaction. A known enforced manifest or cutoff also refuses legacy code
emission before returning an unusable code. Staged/generation consumers refuse
unprovable old pending codes; that refusal does not revoke an
already-paired watch or its refresh credential. Invalid/expired values are refused
before minting and expire naturally in Redis.

## Bounded proof and rollout gates

The owned native-contract fixture creates a fresh local PostgreSQL database,
uses real Redis and mounted HTTP handlers, and executes unchanged recorded client
modules. The new composition proof covers marked and source-less transfers,
strict namespace/marker parsing, refresh/canonical binding with missing optional
lineage, owner collision rollback, native-only revoke, actual password reset,
source generation/native-generation checks, original age, near-source expiry,
terminal consume/replay, same-user Redis replacement and real in-flight primary
user-lock waits. All 20 recorded native releases parse prefixed opaque SIDs and
perform real refresh without changing a frozen source blob.

Canonical native HTTP cases qualify the existing core by replacing only the
mode lookup inside the test. Production startup and the Garmin guard stay intact;
these cases do not claim that canonical issuance is activated. Existing installed
client/fixture suites remain the independent compatibility controls.

Deploy compatible readers before either provenance-aware canonical binding or v2
watch emission. Drain the five-minute old-code window, retain the v2 reader/emitter floor during
rollback once cutoffs exist, never resume an old bare-UID issuer, retire old issuers and
verify actual roles, pools and signing/Redis capabilities before staged
consumption. Already-issued unmarked native credentials and ancestry previously
discarded by older issuers cannot be reconstructed from a UID/generation alone.
That historical qualification remains an explicit gate; this change forces no
logout of those existing credentials. Device/offline watch acceptance, pool
capacity, full writer fencing and production activation remain separate gates.
