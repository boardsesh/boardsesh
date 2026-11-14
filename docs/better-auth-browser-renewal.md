# Selected browser rolling renewal

Implementation work for #6975; activation and browser/device gates remain in
#7430. Public readiness stays false. This flow preserves the released 30-day
rolling lifetime without claiming a new authentication event.

The private renewal protocol is separate from login and provider continuation.
Login permits a different UID/SID; provider continuation increments generation
and revokes other credentials. Neither supplies ordinary renewal's invariants.

Prepare admits the exact currently selected source and records hash-only
operation evidence in `auth_browser_renewals`. It freezes the authority epoch,
actual UID/SID/generation, original age and account-cutoff provenance, source
hash/deadline, binding version/revision and a second-aligned database-clock
target expiry 30 days ahead. Preparation lasts at most one minute and never
outlives the actual old source or binding. Pending live account-change intents
take precedence; ordinary session polling must not cancel a provider action.

Before finalization, the canonical WWW adapter must buffer the entire success
response, the future version-named proof, retained old proof and constant
relative correlation-cookie refresh. The complete next request must fit both
byte and pair limits. Legacy issuance verifies the actual NextAuth encoded JWE
against the exact frozen expiry; a second-boundary mismatch fails closed.
Historical no-SID sources retain `legacy_no_sid` even when their admitted
synthetic SID becomes explicit. A renewed `iat` or `jti` never proves age.

The final transaction re-admits actual source after lock waits and compares
every frozen field. Canonical renewal retains the same opaque token, extending
only its existing session expiry/update time. It preserves session creation,
original authentication and lineage evidence and refuses missing, revoked or
foreign rows. Legacy candidates must retain owner, SID, generation and
provenance; any matching canonical mirror keeps its existing opaque token.
The binding advances exactly one version and extends its database retention in
the same transaction. Its original fixed bootstrap deadline must not end an
otherwise valid rolling session. Old-source and operation deadlines, primary
cutoffs and authority are checked after real writes so failure rolls back all
changes.

Unknown commit outcomes publish no candidate cookies and never retry mutation.
Read-only acknowledgment requires the exact operation/preparation plus actual
old and new source possession and current primary selection. No operation row
stores or reconstructs a bearer. Retained operation expiry indexes support a
separately reviewed retention procedure; no existing data is deleted here.

Qualification must cover both authorities and credential kinds, unknown-age
and no-SID ancestry, preservation of unrelated sessions, renewal past the old
login/binding deadline, delayed older responses, lock waits, competing login /
logout / provider changes, exact encoding expiry, post-write expiry rollback,
whole-cookie capacity and uncertain completion. Missing-proof recovery and
supported-browser two-account cancellation remain separate acceptance gates.
