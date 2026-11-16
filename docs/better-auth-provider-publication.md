# Unmounted provider publication

> **Superseded by #7596.** This describes the browser binding design, which is being removed. See [better-auth-browser-session.md](better-auth-browser-session.md). This file is deleted together with its code.

This prerequisite for epic #6975 separates an explicit Google/Apple method
change from ordinary OAuth identity resolution. Rollout remains tracked in
#7430. #7596 deleted the selected flow reader, the explicit link publication
factory and the Google reauthentication web seam; B5 rebuilds the provider
flows on the new browser session. Public composition, Settings wiring and mode
activation remain incomplete.

The server-only client uses the frozen private provider-security protocol with
explicit 192 KiB request and 128 KiB response budgets. It captures submitted
objects before I/O and checks operation, request, status, actual actor UID/SID,
binding/version and final candidate hash. It never retries an uncertain mutation
or forwards incoming cookies as service authentication.

## Candidate issuer

For a legacy source, the actual public NextAuth encoder issues the candidate.
Its `maxAge` is bounded to the original deadline, and the actual encoded JWE is
decoded and required to retain that exact expiry and the prepared claims.
Assigning `token.exp` alone is insufficient because NextAuth overwrites it.
Cookie expiry is capped separately. A canonical candidate is only the backend's
private opaque proposal; no framework JWE is substituted for it.

The server-only candidate issuer and synchronous response preflight were shared
with the direct unlink commands. #7596 deleted that unlink publication and the
Settings link client; B5 rebuilds them on the shared-domain session. The
first-password writer still uses the claims-free path described here. That path
does not simulate an OAuth callback: the issuer decodes the actual original JWE, validates its proof and deadline, copies
its profile claims and uses the primary SID, next generation and conservative
provenance before applying the same real-codec checks. Historical missing SID
and generation retain the centrally admitted credential lineage and default
generation; a rolling JTI never becomes that SID. An unguarded old `auth_time`
remains unknown and is removed from the candidate. For a canonical source the
actual bounded opaque token can use its original format; only the distinct new
backend proposal uses the current emitter format. The broker must still obtain a qualified
prepared command, check current admission and finalize its exact candidate; the
helpers do not authorize or perform a provider mutation.

## Ordinary owned-account publication

The request-local owned sign-in factory keeps the browser's actual A credential
for central admission while NextAuth verifies Google or Apple. A separate
pending cookie family prevents NextAuth from automatically associating B's
provider subject with A. All adapter writes and email matching are refused.
The backend's existing `signin-prepare` result either preserves the same owner
without a new credential or fixes the distinct B owner, SID, generation,
provenance, expiry and canonical proposal. Apple never supplies a fresh age.

The actual JWT callback and installed public encoder run before finalization.
The factory removes the entire pending session-cookie family, waits for the
original A response admission and partner response work, buffers the response,
seals a metadata-only preparation carrier and checks the complete projected
browser Cookie header. Only then does it finalize the exact candidate. Failures
before finalization attempt cancellation; an uncertain finalization never
retries, aborts or publishes the pending candidate.

The next-request acknowledgment factory requires both physically observed
versioned A and B proofs, the preparation carrier, and current primary B
admission. It matches the complete prepared B proof and cursor, calls the exact
backend acknowledgment once, and rechecks primary admission before returning
only `recovered`. It emits no cookies and cannot recover credentials after
their bytes or the carrier were lost. Its production readiness remains false.

#7596 deleted the installed NextAuth proof that drove this factory through
Google/Apple discovery, token exchange and cookie publication. Restricted LOGIN
and real transaction composition, public mounting, selected anonymous sign-in
and real browser/device acceptance remain open.

## Evidence limits

The client tests exercise bounded transport, copied inputs, correlation, source
kind and candidate hashes. Direct-issuer tests cover original known/unknown
age, actual backend-verified historical metadata, source-proof/deadline drift,
UUID and other bounded opaque canonical sources, proposal reuse, immutable
buffered responses and header limits.

Those tests replace the primary admission and provider command boundary with
controlled synthetic receipts; they do not prove production ACLs, real backend
finalization or a mounted broker. The cookie plan is explicitly fixture-owned.
Real provider verification, selected-authority transactions, private-role
qualification, canonical-www cookie publication, supported browser ordering and
Settings integration must be joined and reviewed before activation. No raw
credential or durable capability belongs in MessageChannel or IndexedDB.
