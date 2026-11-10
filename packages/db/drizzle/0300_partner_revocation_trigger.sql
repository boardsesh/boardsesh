-- Partner OAuth revocation: a password write ends every partner connection for
-- that climber, in the same transaction, wherever the write comes from.
--
-- What this adds. public.partner_revoke_user(text) and two triggers on
-- user_credentials that call it: one on INSERT, one on UPDATE OF password_hash
-- when the hash actually changes. Every password path is listed, with a test,
-- in packages/backend/src/auth/partner/__tests__/partner-revocation.test.ts.
--
-- Live on deploy: the deployed web and backend write through this the moment the
-- migration commits, before any partner row exists. So the only thing a password
-- write gains while there are no partner rows is one lock on the climber's users
-- row and seven index lookups that find nothing. No partner table is written, so
-- the write takes no ROW EXCLUSIVE lock on any of them.
--
-- Lock order. Issuers take users FOR SHARE, then the connection row, then provider
-- rows. This function takes users FOR NO KEY UPDATE first and only then touches any
-- partner table, so it cannot deadlock against an issuer: an in-flight refresh makes
-- it wait, then READ COMMITTED re-reads and removes the token that refresh just
-- committed. A later issuer waits for this write, then finds the connection revoked.
-- Account deletion needs a lock that conflicts with FOR SHARE too, so it still waits
-- for issuers.
--
-- FOR NO KEY UPDATE and not FOR UPDATE, because every foreign-key insert that points
-- at users holds FOR KEY SHARE on the row until it commits. FOR UPDATE would queue a
-- password change behind each of them, so a climber resetting during a Kilter or
-- Aurora sync page would wait for that page. FOR NO KEY UPDATE conflicts with FOR
-- SHARE and stronger and leaves FOR KEY SHARE alone. An issuer must therefore take
-- FOR SHARE explicitly: a foreign-key check alone is not excluded by this lock.
--
-- Staged reset (password-recovery.ts) takes users FOR UPDATE before writing the
-- hash, so the lock here is re-entrant. Legacy reset (web route) writes the hash
-- first: the executor locks the user_credentials row before a BEFORE UPDATE
-- trigger runs, so this path is credentials row -> users row, the reverse of
-- account deletion (users row -> cascade to credentials row). For the same climber
-- at the same instant that can deadlock; Postgres aborts one side after 1 s with
-- 40P01. Deletion retries on that (retryAccountDeletion); the legacy reset surfaces
-- it as a failed request and the climber retries. With no partner rows the reset
-- does not need the lock and carries on, with one exception: when emailVerified IS
-- NULL the route then updates users itself, outside this function. If deletion has
-- held users for over 5 s by then, the reset is the later waiter, gets the 40P01 and
-- returns a 500, where without this trigger deletion would be the victim.
--
-- This function takes no advisory locks. fixed-system-owner-order.ts is unaffected:
-- its advisory key stays acquired first, by the callers that use it.
--
-- Failure policy, by failure mode. "Partner rows" means a live connection or any
-- token, consent, ancestry, consent-screen or oauth_session row; a connection that
-- was already revoked does not count on its own:
--   no partner rows, no contention      write succeeds; nothing to revoke, nothing written
--   users row absent                    no-op; the FK or the UPDATE reports as today
--   a users lock wait passes 5 s, or a deadlock, and
--     no partner rows visible           write succeeds, no revocation: nothing to end,
--                                       and a partner feature must not break a password
--                                       change
--     partner rows exist                write fails (55P03 / 40P01), rolled back whole,
--                                       retryable. The password must not change while a
--                                       token outlives it (one transaction, by design)
--   statement_timeout or a cancel       write fails (57014), rolled back whole, retryable,
--     during the wait                   with or without partner rows. It is the caller's
--                                       deadline or an operator's stop, not a partner
--                                       failure, and carrying on would run past both
--   any other error in the revocation   write fails and rolls back. Accepted: a trigger bug
--                                       fails resets. The stop is partner mode `off`, then
--                                       the owner disables these triggers
--   REPEATABLE READ or SERIALIZABLE     write fails (55000). Those snapshots cannot see a
--                                       token committed during the lock wait. No credential
--                                       writer uses them today
--
-- The 5 s bounds each lock wait, not the total: a new holder starts a new wait.
-- Foreign-key holders no longer count, so a wait now means an issuer, or a transaction
-- holding users FOR UPDATE or writing the row (account deletion, a data export request,
-- an audience change, email verification). The probes take ACCESS SHARE, so only an
-- ACCESS EXCLUSIVE lock on a partner table can block them, and held past 5 s it fails
-- the password write.
--
-- Residual risk of carrying on without the lock: until this write commits, nothing
-- excludes an issuer minting the climber's first connection or reconnecting a revoked
-- one, so that connection can outlive the new password. It needs another transaction
-- holding the row past 5 s and a connect in that same moment. Issuers are bounded (statement 5 s, lock
-- 2 s, idle 10 s).
--
-- Privileges. Only the trigger function is SECURITY DEFINER: staged current-store
-- roles and the runtime role need no grant on any oauth_ table for a password write
-- to work, including in the window between this migration and the runtime ACL
-- reconcile that follows it on deploy. It cannot be called directly (trigger
-- functions cannot) and refuses to run for any table but user_credentials, so
-- it cannot be attached to a caller's own table with a forged NEW row.
-- partner_revoke_user stays SECURITY INVOKER on purpose: it runs as its caller, so a
-- role that can reach it can do nothing it could not already do with DML. Both pin
-- search_path to the value every trigger function here uses (the guard in
-- db-trigger-search-path.test.ts and dev-db-image-smoke.sh checks it) and qualify
-- every table, so neither resolves names through the caller; only the owner can
-- create objects in public.
--
-- Portability. Nothing here is Railway-specific. After a pg_dump/pg_restore to a new
-- owner with --no-owner, the restoring role owns the functions, the triggers' table
-- and the partner tables alike, so the definer function keeps its access. --no-acl
-- drops the REVOKE below until the next deploy's runtime ACL reconcile; that leaves
-- the trigger function callable by no one directly (see above). A data-only reload
-- runs the INSERT trigger per row like any other write: a reload that loads partner
-- rows before user_credentials revokes them, so it needs --disable-triggers.
--
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on user_credentials only: reads and
-- sign-ins keep flowing, and it never touches users. The retry guard caps each wait
-- at 3 s so a stuck writer cannot queue every later write behind this migration.
-- There is no backfill and no table rewrite.

CREATE OR REPLACE FUNCTION public.partner_revoke_user(p_user_id text)
RETURNS integer
LANGUAGE plpgsql
STRICT
SET search_path = public, pg_catalog
SET lock_timeout = '5s'
AS $$
DECLARE
  connections_revoked integer;
  revoked_at_value timestamptz := clock_timestamp();
  users_lock_error text;
  users_lock_message text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'partner_revoke_user must run under READ COMMITTED, not %',
      current_setting('transaction_isolation')
      USING ERRCODE = '55000';
  END IF;

  BEGIN
    PERFORM 1 FROM public.users AS target WHERE target.id = p_user_id FOR NO KEY UPDATE;
  EXCEPTION
    -- query_canceled stays out on purpose: see the failure policy above.
    WHEN lock_not_available OR deadlock_detected THEN
      GET STACKED DIAGNOSTICS
        users_lock_error = RETURNED_SQLSTATE,
        users_lock_message = MESSAGE_TEXT;
  END;

  -- Read-only and before any write, so a climber with no partner rows takes no
  -- ROW EXCLUSIVE lock on a partner table. A connection already revoked has nothing
  -- left to end; if a consent screen is pending against it, that row is seen below.
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.oauth_connections AS row_found
       WHERE row_found.user_id = p_user_id AND row_found.revoked_at IS NULL
    )
    OR EXISTS (SELECT 1 FROM public.oauth_access_token AS row_found WHERE row_found.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.oauth_refresh_token AS row_found WHERE row_found.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.oauth_consent AS row_found WHERE row_found.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.oauth_refresh_ancestors AS row_found WHERE row_found.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.oauth_consent_interactions AS row_found WHERE row_found.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.oauth_session AS row_found WHERE row_found.user_id = p_user_id)
  ) THEN
    RETURN 0;
  END IF;

  -- Partner rows exist and the lock was not won: the password must not change.
  IF users_lock_error IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = users_lock_error, MESSAGE = users_lock_message;
  END IF;

  -- Bumped even on a connection already revoked, so a consent screen pending
  -- against the old generation cannot revive it. The first revocation's time and
  -- reason stay, because they say why the connection ended.
  UPDATE public.oauth_connections AS connection
     SET generation = connection.generation + 1,
         revoked_at = coalesce(connection.revoked_at, revoked_at_value),
         revocation_reason = coalesce(connection.revocation_reason, 'account_security_revocation'),
         updated_at = revoked_at_value
   WHERE connection.user_id = p_user_id;
  GET DIAGNOSTICS connections_revoked = ROW_COUNT;

  -- Pending codes have no user column. Each is keyed by its grant, so delete them
  -- through the grant before the grants go.
  DELETE FROM public.oauth_verification AS code
   WHERE code.identifier IN (
     SELECT grant_row.authorization_code_id
       FROM public.oauth_grants AS grant_row
       JOIN public.oauth_connections AS connection ON connection.id = grant_row.connection_id
      WHERE connection.user_id = p_user_id
   );
  DELETE FROM public.oauth_grants AS grant_row
   WHERE grant_row.connection_id IN (
     SELECT connection.id FROM public.oauth_connections AS connection WHERE connection.user_id = p_user_id
   );

  DELETE FROM public.oauth_access_token AS token WHERE token.user_id = p_user_id;
  DELETE FROM public.oauth_refresh_token AS token WHERE token.user_id = p_user_id;
  DELETE FROM public.oauth_consent AS consent WHERE consent.user_id = p_user_id;
  DELETE FROM public.oauth_refresh_ancestors AS ancestor WHERE ancestor.user_id = p_user_id;
  DELETE FROM public.oauth_consent_interactions AS interaction WHERE interaction.user_id = p_user_id;
  DELETE FROM public.oauth_session AS session_row WHERE session_row.user_id = p_user_id;

  RETURN connections_revoked;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.partner_revoke_on_credential_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_RELID <> 'public.user_credentials'::pg_catalog.regclass THEN
    RAISE EXCEPTION 'partner_revoke_on_credential_change is only for user_credentials'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- BEFORE INSERT fires for INSERT ... ON CONFLICT too. A conflicting row means
    -- DO NOTHING (no change), DO UPDATE (the UPDATE trigger handles it) or a
    -- unique violation that rolls back, so no hash changed here. Seed scripts
    -- that re-run land on this branch.
    IF EXISTS (SELECT 1 FROM public.user_credentials AS credential WHERE credential.user_id = NEW.user_id) THEN
      RETURN NEW;
    END IF;
  ELSE
    -- The column is naive, read back as UTC. App clocks are not trusted for the
    -- consent bridge's comparison, and the session TimeZone must not matter.
    NEW.updated_at := clock_timestamp() AT TIME ZONE 'UTC';
  END IF;

  PERFORM public.partner_revoke_user(NEW.user_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.partner_revoke_on_credential_change() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';
      LOCK TABLE "user_credentials" IN SHARE ROW EXCLUSIVE MODE;
      SET LOCAL lock_timeout = '0';
      RETURN;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempts >= 40 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_user_credentials_partner_revoke_insert
  BEFORE INSERT ON "user_credentials"
  FOR EACH ROW
  EXECUTE FUNCTION public.partner_revoke_on_credential_change();
--> statement-breakpoint
-- The WHEN clause keeps a write that does not change the hash out of the function
-- entirely, including the users row lock. BA-04's mirror writes the same hash back
-- and must not end anything.
CREATE TRIGGER trg_user_credentials_partner_revoke_update
  BEFORE UPDATE OF password_hash ON "user_credentials"
  FOR EACH ROW
  WHEN (OLD.password_hash IS DISTINCT FROM NEW.password_hash)
  EXECUTE FUNCTION public.partner_revoke_on_credential_change();
