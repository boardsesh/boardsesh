# Owned synthetic auth rehearsal

This developer harness qualifies a bounded part of BA-04 PR10. Owner actions and release decisions remain in [#7430](https://github.com/boardsesh/boardsesh/issues/7430).

The only accepted target is a fresh PostgreSQL/Redis pair plus a Linux dependency image created on a verified local Docker Unix daemon. There is no database URL, restored-copy path, capability file, force flag, or production target input. The build context contains allowlisted tracked source, manifests, patches, and this pending fixture. It excludes operator environment/configuration, credentials, and host node_modules. Linux dependencies are installed with the frozen lockfile before isolation, and runtime images are bound to an original in-memory build receipt.

PostgreSQL owns a single labelled internal network with no requested or published host ports. Redis and the runtime inherit that exact container network namespace; all SQL, the race driver, and both backend workers run there against fixed loopback ports. The host verifies daemon/image/container/nonce ownership, namespace inheritance and actual kernel network namespace identity. The runtime is read-only, drops all capabilities, and receives no bind mounts or Docker socket. PostgreSQL DNS forwards only to its isolated loopback address.

Before constructing any SQL client, the runtime confirms its container/network namespace, refuses IPv4/IPv6 default routes and external DNS resolvers, and proves that a reserved TEST-NET address fails with no route. Each worker confirms the same namespace before importing application singletons. Fresh credentials arrive over protected stdin; child processes receive only an explicit environment whitelist and fresh shared test secrets. Reports contain keyed references, counts, outcomes, and timings, never account IDs, emails, tokens, hashes, or provider subjects.

SQL initialization derives the database name from the in-memory nonce. Each command checks the per-run marker before mutation. Cleanup reinspects every owned resource before its first deletion; changed metadata refuses cleanup. Private creation audits are cleanup evidence only and are never accepted as execution capabilities. No existing database or developer container is a target.

## Local commands

`vp run auth:rehearsal` and explicit `full` return not-ready/nonzero before Docker or SQL. Four synthetic cases cannot qualify the missing full rehearsal. `vp run auth:rehearsal:synthetic` selects only the bounded partial proof. No environment or force flag can enable full mode.

1. Run `vp exec tsx scripts/auth-rehearsal/prepare-images.ts` to prepare the two public pinned fixture images on the verified local daemon. It uses an empty temporary Docker configuration and never consults operator registry credentials.
2. Run `vp exec tsx scripts/auth-rehearsal/topology-proof.ts` for the actual namespace and no-route proof, followed by attested cleanup. It does not construct a SQL client or start auth workers.
3. After the independent topology qualification, run `vp exec tsx scripts/auth-rehearsal/index.ts synthetic` for the bounded two-instance races. The Linux dependency build happens before isolation; cached builds reuse the frozen dependency layer.

A missing image, changed daemon, unowned resource, unexpected publication/namespace, route, DNS resolver, or database marker refuses qualification. There is no force option. The preparation command does not accept image names or Docker endpoints. Private creation audits under the worktree's ignored `.boardsesh` directory permit a separate owner-reviewed cleanup when preparation refuses; they cannot authorize SQL or cleanup through the harness.

## Evidence limits

1. The bridge/reset scenario uses the real bridge and security-mutation transaction helper in two processes. A persisted, admitted canonical bridge is mandatory; old source and returned canonical proofs must be denied after reset.
2. Refresh/signout uses the mounted refresh handler and explicit dark native-generation core. A successful refresh, admitted child, consumed-parent refusal, and acknowledged child revocation are mandatory controls; all returned native proofs are checked on both readers. The production default remains legacy; Garmin queue preservation, original-key update safety and real watch QA remain activation gates.
3. Concurrent account reads prove source-identity binding only. A delayed account-A Set-Cookie arriving after account B signs in remains unqualified.
4. Reconnect uses the actual WebSocket server, periodic primary-cutoff sweep, and second-instance admission.
5. Writer switch, stop issuance, rollback, restored-copy invariants, and complete child egress isolation remain unqualified.

The earlier host-side topology was refused before SQL because Docker suppressed its host publication. It provides no rehearsal evidence. The isolated runtime topology and its actual egress proof require independent qualification; a network label or blank external-provider configuration alone is insufficient. A successful synthetic report must retain `partial-synthetic` and its blockers. It is not either of the two full A5 rehearsals and cannot close an activation gate.

Garmin is installed only on the owner's test watch; there is no shared/public release, and publication is planned for December. The unknown public-old-watch population is resolved. Queue preservation for the existing test ticks, update safety with the original signing key, and real watch QA remain open before activation/release. This inventory fact does not waive queue safety or authorize data loss.

## Reference invariants

The fixture records keyed identity/provider fingerprints and the actual single-column users-FK catalog. Stable reference counts must survive the intentional synthetic password/reset/session mutations. Authentication event, cutoff, refresh, and lineage counts change by design. This minimal schema fixture is not the complete restored production dataset or the 79-reference preservation audit. The final report names that missing qualification explicitly.
