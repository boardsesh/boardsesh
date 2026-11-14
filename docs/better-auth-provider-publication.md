# Unmounted explicit provider publication

This prerequisite for epic #6975 separates an explicit Google/Apple method
change from ordinary OAuth identity resolution. Rollout remains tracked in
#7430. No qualified flow reader, Settings broker, public route adapter or mode
activation is supplied here.

The server-only client uses the frozen private provider-security protocol with
explicit 192 KiB request and 128 KiB response budgets. It captures submitted
objects before I/O and checks operation, request, status, actual actor UID/SID,
binding/version and final candidate hash. It never retries an uncertain mutation
or forwards incoming cookies as service authentication.

## Qualified frame and issuer

Only a server reader of actual central possession may supply
`ProviderSecurityExplicitBoundFlow`. Purpose-encrypted flow material by itself
does not authenticate its claimed actor. The frame includes the actual source
kind/bytes, original credential proof and absolute expiry, provider/flow binding
and durable operation/reauthentication capabilities. A broker-pinned return URL
can further restrict publication. Neither a UID/SID nor a sealed claim can
reconstruct a canonical bearer.

The request-local NextAuth adapter exposes only the prepared actor as a virtual
existing provider owner. It refuses all adapter writes and email matching; the
ordinary profile-verification sign-in callback is not invoked. The prepared
proof must preserve UID, SID, original age and provenance while advancing the
generation exactly once. The ordinary JWT callback receives that proof, and
account-creation attribution is suppressed.

For a legacy source, the actual public NextAuth encoder issues the candidate.
Its `maxAge` is bounded to the original deadline, and the actual encoded JWE is
decoded and required to retain that exact expiry and the prepared claims.
Assigning `token.exp` alone is insufficient because NextAuth overwrites it.
Cookie expiry is capped separately. A canonical candidate is only the backend's
private opaque proposal; no framework JWE is substituted for it.

The server-only candidate issuer and synchronous response preflight are shared
with direct unlink commands. Unlink does not simulate an OAuth callback: the
issuer decodes the actual original JWE, validates its proof and deadline, copies
its profile claims and uses the primary SID, next generation and conservative
provenance before applying the same real-codec checks. Historical missing SID
and generation retain the centrally admitted credential lineage and default
generation; a rolling JTI never becomes that SID. An unguarded old `auth_time`
remains unknown and is removed from the candidate. For a canonical source the
actual bounded opaque token can use its original format; only the distinct new
backend proposal uses the current emitter format. The broker must still obtain a qualified
prepared command, check current admission and finalize its exact candidate; the
helpers do not authorize or perform a provider mutation.

## Buffered composition

The caller must compose the factory around the whole route response:

1. Run actual NextAuth provider verification, JWT/codec and event work.
2. Quarantine the entire framework session-cookie family, including clears.
3. Run existing response admission on the cookie-free response.
4. Finish partner/redirect/body work and synchronously build the cookie plan.
5. Finalize the exact candidate, then return the already-constructed response.

The optional admission completion callback is a server-local closure invoked
only after ordinary checks finish. The factory binds it to the exact
quarantined `Response`; an HTTP marker cannot acknowledge it. Future-generation
credentials are never passed to ordinary precommit admission.

There is no default cookie publisher. A real broker must inject the reviewed
#7474 exact-cursor codec and validate candidate kind/bytes, future cursor,
absolute expiry, observed names, capacity and layout before finalization. The
factory additionally bounds response bodies and headers and refuses correlation
cookie writes. Same-version rolling renewal and public bootstrap remain separate
qualification work.

Precommit failures publish no session write or clear and attempt bounded intent
abort. Cancellation or provider rejection before preparation aborts the bound
intent with a null preparation token. The backend re-admits the actor and exact
flow for that abort. Once finalization starts, an uncertain result is not aborted or retried.
The exact candidate and already-built response remain in this request's private
closure for one explicit bounded ACK recovery call. Recovery does not retrieve
credentials or repeat OAuth, JWT, events or finalization. A lost caller context
still requires the separately qualified broker recovery design.

## Ordinary OAuth guard

When provider-security mode is selected, the OAuth scaffold requires both
server-owned start and callback delegates, plus the selected backend OAuth
delegate. Missing/incompatible delegates refuse before token exchange or legacy
intent work. Start delegation receives only the state actually generated by
NextAuth; callback delegation receives the verified scoped flow after existing
Apple continuation handling. The identity-only legacy intent/resolve writer is
not used on that path. The qualified adapter must still run actual provider
verification before issuing an owned-provider or explicit mutation command.

The backend independently rechecks ordinary subject ownership before consuming
any legacy intent. That transactional fence and the broker's actual central
reader remain native/provider implementation scope; these frontend hook types
do not establish ownership themselves.

## Evidence limits

The client tests exercise bounded transport, copied inputs, correlation, source
kind and candidate hashes. The publication tests run actual NextAuth App Router
dispatch, Google OAuth with owned HTTPS discovery/token/JWKS transport, original
JWT callbacks, public JWE crypto, response admission and partner response work.
They reproduce actual provider cancellation/token rejection, late hook, encode,
clock, admission, body and UTF-8 cookie-capacity failures
and a lost finalizer reply followed by explicit same-candidate recovery.
Direct-issuer tests cover original known/unknown age, actual backend-verified
historical metadata, source-proof/deadline drift, UUID and other bounded opaque
canonical sources, proposal reuse, immutable buffered responses and header limits.

Those composition tests replace the primary admission and provider command
boundary with controlled synthetic receipts; they do not prove production ACLs,
real backend finalization or a mounted broker. The cookie plan is explicitly
fixture-owned. Real provider verification, selected-authority transactions,
private-role qualification, canonical-www cookie publication, supported browser
ordering and Settings integration must be joined and reviewed before activation.
No raw credential or durable capability belongs in MessageChannel or IndexedDB.
