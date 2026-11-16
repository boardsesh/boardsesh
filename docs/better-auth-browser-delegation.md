# Selected browser access to GraphQL and WebSocket

The private browser delegation command exchanges the browser's actual current
source credential for a short backend bearer. It does not issue a browser
session or qualify reauthentication. Public browser activation remains gated by
the complete BA-05 application proof; rollout is tracked in issue #7430.

## What #7596 removed

The backend half is gone: the private delegation command
(`/api/internal/auth/browser-delegation/v1/issue`), `bsbd1_` admission on
GraphQL, REST and WebSocket, the idle WebSocket sweep of delegated sockets, and
the `BROWSER_DELEGATION_SECRET` key, which nothing reads now. A `bsbd1_` bearer
is an unrecognised token: anonymous where authentication is optional and 401
where it is required, like any other unknown bearer. The PostgreSQL core and
transport tests went with it.

The client half below is still in the repository and still dark. The www issuer
(`packages/web/app/lib/auth/browser-backend-token.server.ts`) posts to the
removed command, so it can only fail closed. The Expo web lease consumers still
handle `bsbd1_` leases. This page goes with them.

## Clients

The private reply includes the exact database issuance time. The web checks
the issuer-clock duration, debits the entire observed roundtrip, and returns
an earlier effective expiry plus `usableForMs`. Browser and Expo web consumers
must debit their own roundtrip and use a monotonic in-memory deadline. They
must suppress delayed replies after account, SID, generation or cursor changes.
No bearer belongs in persistent browser storage or a coordinator channel.
