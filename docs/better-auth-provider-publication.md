# Unmounted provider publication

> **Superseded by #7596.** This describes the browser binding design, which is being removed. See [better-auth-browser-session.md](better-auth-browser-session.md). This file is deleted together with its code.

This prerequisite for epic #6975 separates an explicit Google/Apple method
change from ordinary OAuth identity resolution. Rollout remains tracked in
#7430. #7596 deleted the selected flow reader, the explicit link publication
factory, the Google reauthentication web seam, owned-account and anonymous
Google/Apple sign-in and the sign-in ACK; B5 rebuilds the provider flows on the
new browser session. What is left on www, in `packages/web/app/lib/auth/`, is
the server-only client (`provider-security-command-client.server.ts`), the
candidate issuer below (`provider-security-publication.server.ts`) and the flow
and actor-selection helpers (`provider-security-flow.server.ts`,
`provider-security-selection.server.ts`). No route or page reaches them any
more; their tests and the `auth-proofs` publication proof are their last
callers. The client's owned-account sign-in reply check has had no caller since
the owned sign-in publication went. The next #7596 slice deletes these four
files and this doc.

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
first-password web writer used the claims-free path described here until #7596
deleted it too. That path does not simulate an OAuth callback: the issuer
decodes the actual original JWE, validates its proof and deadline, copies
its profile claims and uses the primary SID, next generation and conservative
provenance before applying the same real-codec checks. Historical missing SID
and generation retain the centrally admitted credential lineage and default
generation; a rolling JTI never becomes that SID. An unguarded old `auth_time`
remains unknown and is removed from the candidate. For a canonical source the
actual bounded opaque token can use its original format; only the distinct new
backend proposal uses the current emitter format. The broker must still obtain a qualified
prepared command, check current admission and finalize its exact candidate; the
helpers do not authorize or perform a provider mutation.

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
