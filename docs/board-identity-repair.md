# Board identity repair

The clone-board repair CLI currently supports report-only discovery with `--backfill-serials` and `--merge --report`. Any `--apply` request fails before any database writes. Report-only discovery may read the database and write a requested CSV report; it never connects to Redis. No production correction or cache reset is authorized by this rebase.

The legacy repair writer predates the current board privacy policy, board-row then serial lock order, canonical merge tombstones, and reference handling. Both serial backfills and clone merges remain disabled until those contracts are integrated and independently reviewed. Moving private history onto a public gym board requires an explicit policy decision.

The exported legacy algorithm helpers remain covered against disposable fixtures. Their passing tests establish isolated behavior only and do not prove safety against the current production schema or concurrent writers.
