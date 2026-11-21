# Revocation follows the selected identity authority

Part of [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975).
Owner actions and rollout gates remain in
[#7430](https://github.com/boardsesh/boardsesh/issues/7430).

Administrative revocation and explicit logout of a legacy credential without a
known login lineage advance the account credential generation. Under Better
Auth, the canonical credential and provider rows must advance with that cutoff.
Otherwise an unchanged password is still stored at the old generation and a
fresh sign-in cannot use it.

Both operations now use the same transaction-bound generation receipt as password
changes. They revalidate the selected identity authority, record the cutoff and
security event, advance every canonical identity row, and reverse-mirror the
current identity into the rollback store before committing. A stale canonical
import or failed mirror aborts all of these writes. Current-store selection
retains its existing optional forward mirror.

Legacy logout records a first-party-only event. Administrative revocation also
revokes partner credentials. Native-only logout remains separate: it advances
the native generation without changing account or canonical identity generation.
Repeated legacy logout from the old generation leaves a later login alone.

## Local verification, 2026-11-13

The authority suite passed **278/278 tests across 25 files**, including ten new
real-PostgreSQL revocation cases. The new cases exercise both selected stores,
exact password bytes, provider generation consistency, old-cookie denial, fresh
password sign-in, writer rollback, stale canonical imports, actual reverse-mirror
failure, repeated logout, and native-only logout. Each suite creates and drops
its own local database. Test admission I/O is redirected to that owned database.

These results do not qualify production grants, deployed historical issuers,
installed clients or hardware, mounted renewed-cookie behavior, or a full
restored-copy switch and rollback. The separate renewed-web-lineage proof covers
the mounted web path. Existing activation assertions remain in place. No
production authority, mode, identity, or account data changed.
