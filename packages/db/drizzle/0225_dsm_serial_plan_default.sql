-- Round 5 of the DSM saga (#5352; earlier rounds #2378, #3856, #4105, #4235, #4528).
--
-- Postgres allocates a dynamic-shared-memory segment per parallel worker, out of
-- the container's /dev/shm. Docker's default is 64 MB. One `similarClimbs` plan
-- measured at ~33 MB of /dev/shm across 12 segments, so two concurrent parallel
-- plans exhaust the budget and the loser gets
-- `could not resize shared memory segment ... No space left on device`
-- (SQLSTATE 53100, dsm_impl.c / dsm_impl_posix).
--
-- Rounds 1-4 each wrapped one more call site in
-- `SET LOCAL max_parallel_workers_per_gather = 0` (`withSerialPlan`). Measured,
-- that guard is completely effective: under an identical, deliberately shrunk
-- DSM budget the unguarded statement raises 53100 and the guarded one returns
-- normally. And in Sentry every guarded resolver went quiet the day its guard
-- shipped. The strategy is what failed, not the guard: the backend has ~65
-- statements with the shape that can be promoted to a parallel plan, only four
-- were wrapped, and whether the planner picks a Gather for the other sixty
-- changes as the tables grow. Static review cannot finish that job, and it does
-- not reach the sync daemons, SSR, OG-image and cron paths that share the same
-- /dev/shm.
--
-- So set the default on the database instead of at the call sites. Every session
-- -- resolvers, background jobs, scripts, a human in psql -- starts with
-- per-gather parallelism off, which is the state the four fixed resolvers were
-- individually driven to anyway.
--
-- This is a DEFAULT, not a lock: a session that wants parallelism can still
-- `SET LOCAL max_parallel_workers_per_gather = <n>` inside a transaction, and the
-- whole thing reverses with
-- `ALTER DATABASE <db> RESET max_parallel_workers_per_gather`.
--
-- It cannot change results, only latency -- the same property `withSerialPlan`
-- already relies on. Measured on the dev catalogue (9.95M board_climb_holds
-- rows), the serial plan for the top offender is FASTER than the parallel one:
-- 2154 ms vs 4163 ms, because the parallel plan reaches for a Parallel Seq Scan
-- where the serial plan keeps the index.
--
-- Portability: plain SQL against a stock `docker run postgres:17`. No Railway
-- knob, no dashboard setting, no extension. `ALTER DATABASE ... SET` is a
-- pg_dumpall global rather than a pg_dump one, which is exactly why it lives in
-- a migration -- migrations are how every Boardsesh database gets built, so a
-- restored dump picks this up on the next `db:migrate` like any other change.
--
-- Existing pooled connections keep their old value until they cycle
-- (`idle_timeout` is 30s outside Vercel), so the change lands within about a
-- minute of the migration rather than instantly.
--
-- Fail-soft on purpose: `ALTER DATABASE ... SET` needs database ownership. If the
-- deploy role lacks it the migration must not block the release -- but a silent
-- no-op is how this bug stayed invisible for five rounds, so the backend reports
-- the effective value on `GET /health/db` (`maxParallelWorkersPerGather`). If the
-- warning below fires, that field reads something other than "0".
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET max_parallel_workers_per_gather = 0', current_database());
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING 'boardsesh: could not set max_parallel_workers_per_gather on database %; parallel-query DSM exhaustion (SQLSTATE 53100) remains possible. Check GET /health/db. (%)', current_database(), SQLERRM;
END
$$;
