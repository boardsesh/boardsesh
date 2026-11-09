# Staged fixed system-owner lock order

This is a prerequisite for the current-store writer migration in #6977. It does
not activate an authentication authority, fence deployed roles, copy credentials,
or establish complete writer coverage.

## Default and scope

`CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE` accepts `legacy` (also the absent
or empty default) and `cooperative-staging`. Other values reject the operation
before its first write. Each adopted public operation captures this setting once
before asynchronous work and passes that captured mode into its transaction.
It does not reread configuration midway through an operation.

The conditional content participants are the admin gym merge, emptied stray-gym
retirement, gym deduplication CLI, spray version commit/publish, and legacy
account deletion. Their existing outer transactions acquire the common key before
their content locks when staging is selected. The normal production default
adds no lock or SQL to those paths. The backend refuses to start on an
unrecognised mode, so a typo fails the deploy rather than the writers.

Staged identity authorities always acquire the key after their existing enforced
projection lock, before cutoff, reservation and user-row locks. This applies to
the shared-board owner, recommendations account and hold-classifier account.
Historical creator/member UIDs copied by content writers cannot be assumed to
exclude either batch account. Staged account deletion also always preflights the
projection in a short transaction of its own, then takes the shared key before
account/wall/content work, while retaining its existing late human-user lock.
It takes the projection again last, after the user delete: see
[the deletion lock order](./better-auth-account-deletion.md#transaction-and-lock-order).

## Transaction contract

The leaf API in `@boardsesh/db/fixed-system-owner-order` borrows a Drizzle
transaction. It opens no pool, transaction or savepoint, reads no environment
file, creates no identity and owns no commit or retry. Its runtime transaction
shape check catches accidental root-database calls; it does not prove that the
caller entered before other locks.

The database-local key is the two-integer advisory namespace `0x42534155`, key
`1`. Identity authorities take it exclusively with one catalog-qualified
`pg_try_advisory_xact_lock` call. Content writers and account deletion take the
`pg_try_advisory_xact_lock_shared` form: they must exclude the identity
authorities but not each other, so a spray publish on one wall never refuses a
publish on another wall, a gym merge or an account deletion. A busy key rejects immediately with a typed error. There is no waiting loop,
automatic replay, or change to the caller's statement/lock timeout settings.
The caller's rollback releases its earlier transactional work too.

Acquire at the outer transaction entry before later savepoints. An artwork
savepoint rollback must leave this earlier key held; acquiring a lock only inside
a savepoint does not establish that prefix. PostgreSQL documents transaction
and savepoint lock behavior in its
[explicit-locking reference](https://www.postgresql.org/docs/18/explicit-locking.html).

For a fenced job command, preserve this order:

```text
existing run and active-job fence
  -> enforced projection manifest
  -> fixed system-owner key
  -> fixed identity cutoff / reservation / user FOR UPDATE
  -> content, if that caller has content work
```

Content-only participants enter the key before their existing gym and wall
locks. The deduplication CLI queues on its own lock first, so time spent waiting
there does not count against a key that never queues. Do not acquire a new projection manifest later while holding
that key; staged account deletion is the one exception, because holding the manifest through content would stall
every auth command, and a holder of the shared key waiting on the manifest cannot deadlock an authority whose key
acquisition never queues. Do not replace an existing identity `FOR UPDATE` with a weaker lock: its conflict with
foreign-key `KEY SHARE` is what lets the authentication-artifact check see an in-flight insert.
A pool-level advisory call cannot cover later autocommit writes.

## Error and commit boundaries

For an operation whose transaction rolls back, the GraphQL adapter reports a
fixed `SERVICE_UNAVAILABLE` error with HTTP 503. Private batch transport retains
its existing unavailable response. The CLI exits unsuccessfully and preserves
its single transaction for the complete selected apply. Busy is not `40P01`, so
the existing deadlock-only account-deletion retry does not replay it.

Stray-board attachment has two existing commits. A valid captured mode followed
by a busy optional retirement retains the successful first board move and the
existing best-effort no-fold result. Invalid configuration is rejected before
that first move. This slice does not turn a committed attachment into a 503 or
combine the two transactions.

Spray publishing enqueues artwork inside the wall transaction using a savepoint.
Art is a maintenance-delivery job with its own queue, generated run ID and
family-prefixed singleton key. Batch identity admission permits only the batch
queue's recommendations/hold-feature families. Source inspection found no wait
on the same batch run/job in these publish paths. Actual publisher-versus-fenced
batch races must still verify both orderings and the art ledger/job outcome:
publish success alone can conceal an optional enqueue error or deadlock.

## Gates that remain open

This selector is a process-local staging choice, not a deployment fence or proof
that another process cooperates. Do not enable this subset as a global safety
claim. Remaining serial deduplication, feed/tick fanout, notification/follow,
claim/grant/reassignment, shared-feed and location-worker producers need their
own actual outer boundaries and queue/attempt ordering closed.

The CLI keeps its whole-apply transaction, and spray carryover can span multiple
batches. Immediate acquisition failure bounds waiting, not how long a successful
transaction holds the key. Representative hold-time and contention measurements,
complete producer adoption, both-winner process races and deployed role fencing
remain prerequisites for activation. The fully migrated catalog proves the
observed FK surface; it does not prove those runtime properties.
