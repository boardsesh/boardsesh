# Identity import and reconciliation

Import uses the live mirror's `syncIdentity` primitive, committing one user at a time under the shared authority gate and user lock. Source credentials and provider subjects are read after locking. Exact bcrypt hashes and provider/subject pairs, including Facebook, are preserved. User IDs and verification timestamps stay in the original `users` table. OAuth tokens and sessions are never imported.

Import is deliberately unavailable until authority activation and live mirror writer/fence coverage code gates close. Neither this command nor a zero-difference report activates authority, enables mirrors, or proves every writer participates. There is no operator bypass.

The explicit operator URL and confirmed hostname use the shared connection policy: no `DATABASE_URL` fallback, remote certificate validation, SQL logging refused, bounded transaction timeouts. Reconciliation uses only a repeatable-read, read-only snapshot and can run before activation, labelled not ready. Exit status 2 means differences exist; 1 means execution failed. Reports contain counts and keyed digests only.

The digest key is 64 lowercase hexadecimal characters in an owner-only 0600 file. Its directory and the initially empty checkpoint directory must be owner-only 0700 directories outside every git repository. Symlink paths are refused. Immutable checkpoint files are created exclusively with mode 0600, one per completed batch, bound by keyed digest to host, port and database. Cursors never appear in command arguments or reports. A failed partial batch safely replays committed users. Corrupt or incomplete checkpoints fail closed; preserve them for investigation.

Batches default to 200 users (maximum 200), pausing 100 ms between batches. New users sorting before a saved cursor require live mirrors. Run full reconciliation after each import pass; reaching the end of a cursor is not completeness evidence. Keep the same digest key to compare reports. Reconciliation compares password bytes, provider/subject pairs, source generation and unexpected canonical rows. Shared IDs and verification timestamps have no second copy to drift.

Owner commands belong only in GitHub issue #7430. Implementation agents must never run these commands against production.
