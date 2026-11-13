# Selected browser access to GraphQL and WebSocket

The private browser delegation command exchanges the browser's actual current
source credential for a short backend bearer. It does not issue a browser
session or qualify reauthentication. Public browser activation remains gated by
the complete BA-05 application proof; rollout is tracked in issue #7430.

## Issuance and primary admission

Only the private, service-authenticated command accepts a binding token and the
exact selected-version JWE or canonical opaque token. The backend performs
primary admission itself, captures the selected authority and session facts,
and encrypts the delegation with a backend-only key. No public signer accepts
an asserted account, SID or generation. The bearer contains hashes and session
facts, never the raw source token or a credential recovered from a stored SID.

The lease lasts at most 120 seconds on the PostgreSQL clock and cannot outlive
its source or binding. Every use rechecks primary authority, binding/version,
UID/SID, generation, original authentication age, ancestry and revocation. For
canonical credentials the primary predicate requires both the SID and the
exact source token's SHA256; the selected columns exclude the token itself.
Legacy credentials also require the original verification-key digest to remain
current. A lease never freshens authentication. Private login, password and
provider commands do not accept it as a source credential.

`bsbd1_` is an exclusive bearer family. Confirmed refusal, including expiry,
returns HTTP401 or closes WebSocket4401. Primary or key uncertainty returns
HTTP503 or closes1013. These outcomes cannot become an anonymous viewer.
WebSocket subscribe and delivery both recheck primary; an idle sweep rotates
through at most eight delegated sockets serially per round. Lease expiry is
checked locally for every captured delegated socket. Existing native and legacy
transport behavior retains its own admission contract.

## Keys, clocks and clients

Provision `BROWSER_DELEGATION_SECRET` only on the backend. It must contain at
least 32 UTF8 bytes and differ from the cookie/mobile, RPC, cron and deleted-email
keys. Never put it in a web or public environment. Key rotation immediately
refuses existing leases; valid current browser proofs can obtain new ones.
Keep compatible readers and their key available through the final lease and
in-flight request drain before any rollback to an older backend.

The private reply includes the exact database issuance time. The web checks
the issuer-clock duration, debits the entire observed roundtrip, and returns
an earlier effective expiry plus `usableForMs`. Browser and Expo web consumers
must debit their own roundtrip and use a monotonic in-memory deadline. They
must suppress delayed replies after account, SID, generation or cursor changes.
No bearer belongs in persistent browser storage or a coordinator channel.

## Evidence boundaries

The core tests use actual PostgreSQL and actual source cryptography, including
database-clock expiry. The transport fixture uses real Yoga/graphql-ws and
primary admission, with a controlled application event producer and isolated
credential factory; restricted-LOGIN command coverage is separate. Neither
fixture establishes complete application-browser, load, device or production
acceptance. Those remain explicit BA-05 and rollout gates.
