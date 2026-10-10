# SQLite locks across runtime reloads

## Failure and reproduction

An iOS JavaScript reload can replace the runtime while an offline download has an
open write transaction. SQLite permits one writer at a time, even in WAL mode. If
the old runtime's native connection is not closed, its transaction remains open
and every subsequent writer times out until the process exits.

This failure was reproduced on a physical iPhone with main `03ba15c9e2` during a
real Kilter download. The device had 35,127 Kilter Homewall climbs. A temporary
debugger hook invoked the normal development reload immediately after a real
`BEGIN IMMEDIATE` resolved, preserving the original promise result. No external
transaction or delay was introduced.

After reload:

- Reads succeeded, but sync checkpoints and privacy withdrawal repeatedly failed
  with `database is locked`.
- The new runtime's main handle reported no open transaction.
- A separate connection also failed to acquire the writer lock: 115 ms with a
  100 ms busy timeout.
- The lock survived retries; a full process restart released it.

Independent native tracing on a dedicated simulator and temporary database
confirmed that `AppContext.destroy()` ran during runtime replacement, but SQLite's
cleanup callback and `sqlite3_close` did not run for the old writer. The existing
context-destruction event was emitted only from `AppContext.deinit`; retained
contexts delayed that deallocation beyond the runtime's lifetime.

This is confirmed on current main, but the first affected binary has not been
established. The October 10 dependency update (#6280, `54f83cf945`) moved
Expo Modules Core 57.0.14 to 57.0.21 and SQLite 57.0.2 to 57.0.4. The implicated
context lifetime and SQLite cleanup methods are unchanged between those versions.
The same update also changed Expo Modules JSI, so this source comparison does not
prove identical reload behavior in older binaries. Dating the first failing
binary would require reproducing against an older native build.

Ordinary foreground/background transitions are a separate case. Three such
cycles during a larger Kilter Original download completed with zero errors in a
66-transaction sample; the slowest transaction took 85 ms. These observations do
not establish a result for Android or every production OTA reload path.

## Cleanup contract

The native patches deliver the existing context-destruction event once when the
runtime is destroyed, with deallocation as a fallback. SQLite handles that event
without invoking unrelated modules' `OnDestroy` callbacks. It drains admitted
native operations before closing the old context's connections, including the
separate connections used for exclusive transactions.

Cleanup must not target every connection with the same database path: a new
runtime may already have opened its own handle. Repeated lifecycle notifications
must not close connections twice. A longer busy timeout, a fresh JS wrapper, or
another retry cannot release a write transaction owned by an abandoned handle.

There is a second cleanup hazard to keep distinct: native `prepare` racing a
finalization scan can make `sqlite3_close` return `SQLITE_BUSY`. A host experiment
reproduced that race, but it was not the mechanism observed in the reload trace.
Draining native operations before finalization addresses that ordering risk.

## Native regression checks

`scripts/__tests__/expo-sqlite-runtime-teardown.test.ts` compiles the installed
patched Swift methods against Expo's vendored SQLite engine on macOS. Its five
scenarios cover retained contexts, recursive lifecycle delivery, operations
already admitted to the native queue, and cleanup from the same or another
module's queue. The fixture retains committed tick/outbox pairs, rolls back both
parts of an interrupted pair, and verifies that the replacement connection can
write. React and JSI plumbing are stubbed, so a rebuilt app remains necessary to
verify actual runtime event delivery.

The rebuilt simulator also passed two real runtime reloads in the same native
process. An unobserved replacement connection acquired the writer in 1 ms with a
100 ms busy timeout. A second run traced `closeAllDatabases()` closing the exact
old writer pointer with `SQLITE_OK`; committed tick/outbox rows survived and the
interrupted pair did not. Debugger pauses affect the traced run's wall-clock
timings, so that run establishes cleanup ordering rather than performance.

The physical iPhone test used native runtime fingerprint
`e3996f85807e227ee128deb47e61b655f58635b9` (arm64 debug image UUID
`DF58B33C-6CB2-37EE-8DD6-AEC86B7D6E92`). Kilter Original 12x12, sets 1 and 20,
40 degrees, was selected with more than 369,000 Original climbs stored. Reload
fired immediately after a real `board_climbs:kilter:1:10` transaction began.
The replacement runtime acquired a fresh writer in 1 ms at a 100 ms timeout,
catalogue authorization recovered, and downloads resumed. Native process 32582
survived the reload. This establishes lock recovery; completed-catalogue offline
browsing and cold-start checks are separate gates.

1. Reload during a real Kilter pull transaction. The replacement runtime must
   write and resume downloading without a force-quit.
2. Repeat during catalogue privacy repair and with a larger catalogue.
3. In a temporary database, retain committed tick/outbox pairs and roll back both
   sides of an uncommitted pair across reload.
4. Repeat foreground/background cycles and check the database remains writable.
5. Exercise app-initiated update reload separately before claiming that path is
   covered. Record the installed native build identity and native cleanup trace.

Use dedicated simulators and the repository's simulator lease. Do not clear an
existing climber's account or database to prepare a reproduction. Record SQL
operation shapes, durations and aggregate counts; omit credentials and row
contents. Debugger instrumentation must be removed before leaving the device.

## Shipping

This fix changes native code. Reloading Metro or publishing only an OTA cannot
update an already-installed binary. Validate the same reproduction with a newly
compiled client, then ship the matching native build. JavaScript privacy recovery
from #6286 remains useful for transient contention, but does not repair an old
binary's abandoned native connection.
