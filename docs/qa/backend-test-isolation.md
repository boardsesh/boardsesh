# Backend test database isolation

Backend integration tests create throwaway PostgreSQL databases. Local worker names include a
stable hash of the checkout root, for example `boardsesh_backend_test_w1_0123456789ab`. The root
comes from the test helper's module location, so running from the repository root or
`packages/backend` uses the same namespace. Separate checkouts with the same Vitest pool ID
use different database names.

The three backend migration replay suites use the same suffix on their own `bs_*_replay_w1`
databases, including their existing forced teardown. Standard worker cleanup matches only the
current namespace and validated pool IDs. It does not clean another checkout's databases,
unsuffixed legacy databases, or migration replay databases. Names remain below PostgreSQL's
63-character identifier limit, and worker names retain `boardsesh_backend_test_w` for destructive
test guards.

Set `BOARDSESH_TEST_DB_SALT` to a distinct nonempty value for separate runs in the same checkout.
The explicit salt replaces the checkout root as the hash input; reusing a salt across checkouts
intentionally reuses the same namespace. Empty or whitespace-only salts count as unset.
CI keeps the legacy unsuffixed names when no salt is set. An explicit salt is honored in CI too,
and unsuffixed CI cleanup never selects salted databases.

This isolates PostgreSQL database names, not every shared service. Redis still selects logical
database `VITEST_POOL_ID % 16`, so concurrent runs can collide there; tests that change cluster-wide
roles also share a PostgreSQL server. Keep backend integration runs serialized with the existing
`/tmp/boardsesh-backend-tests.lock` convention. A distinct salt does not make whole backend suites
safe to run concurrently. Pure namespace tests use synthetic catalog names under
`packages/backend/vitest.unit.config.ts` and never connect to PostgreSQL or perform teardown.
