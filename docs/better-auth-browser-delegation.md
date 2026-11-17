# Selected browser access to GraphQL and WebSocket

> **Superseded by #7596.** This describes the browser binding design, which is being removed. See [better-auth-browser-session.md](better-auth-browser-session.md). This file is deleted together with its code.

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

The www issuer (`browser-backend-token.server.ts`) and the server facade that
called it went in the PR that closed #7594. The Expo web lease consumers still
handle `bsbd1_` leases and are still dark. This page goes with them.

## Clients

The private reply included the exact database issuance time. The www issuer
checked the issuer-clock duration, debited the entire observed roundtrip, and
returned an earlier effective expiry plus `usableForMs`. Browser and Expo web consumers
must debit their own roundtrip and use a monotonic in-memory deadline. They
must suppress delayed replies after account, SID, generation or cursor changes.
No bearer belongs in persistent browser storage or a coordinator channel.
