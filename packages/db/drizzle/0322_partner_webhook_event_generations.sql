-- Connection revocation covers Disconnect, security resets and reconnect fencing.
-- Definer functions are trigger-only and pin every relation, so restricted auth
-- writer roles do not need direct privileges on new partner tables.
CREATE OR REPLACE FUNCTION public.partner_connection_lifecycle_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_RELID <> 'public.oauth_connections'::pg_catalog.regclass THEN
    RAISE EXCEPTION 'partner_connection_lifecycle_events is only for oauth_connections' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NULL AND (NEW.revoked_at IS NOT NULL OR NEW.generation <> OLD.generation) THEN
    UPDATE public.app_workouts
       SET status = 'revoked'
     WHERE connection_id = OLD.id AND connection_generation = OLD.generation
       AND status IN ('created', 'opened', 'started');
    INSERT INTO public.oauth_subjects (user_id, client_id, subject)
    SELECT OLD.user_id, OLD.client_id, 'usr_' || replace(gen_random_uuid()::text, '-', '')
     WHERE OLD.connected_at IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.oauth_client_webhooks WHERE client_id = OLD.client_id
        AND enabled AND 'connection.revoked' = ANY(events))
    ON CONFLICT DO NOTHING;
    INSERT INTO public.partner_webhook_outbox
      (client_id, connection_id, connection_generation, endpoint_version, type, subject, occurred_at)
    SELECT OLD.client_id, OLD.id, OLD.generation, webhook.version, 'connection.revoked', subject.subject, clock_timestamp()
      FROM public.oauth_subjects AS subject
      JOIN public.oauth_client_webhooks AS webhook ON webhook.client_id = subject.client_id
     WHERE subject.client_id = OLD.client_id AND subject.user_id = OLD.user_id
       AND webhook.enabled AND 'connection.revoked' = ANY(webhook.events)
       AND OLD.connected_at IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.partner_connection_lifecycle_events() FROM PUBLIC;

--> statement-breakpoint

-- Capture pairwise subjects before cascading account deletion removes them.
-- The outbox has no user/connection FK and survives, unless the receiving app
-- itself is deleted. No profile or climbing data enters its payload.
CREATE OR REPLACE FUNCTION public.partner_account_deletion_events()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_RELID <> 'public.users'::pg_catalog.regclass THEN
    RAISE EXCEPTION 'partner_account_deletion_events is only for users' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.oauth_subjects (user_id, client_id, subject)
  SELECT OLD.id, connection.client_id, 'usr_' || replace(gen_random_uuid()::text, '-', '')
    FROM public.oauth_connections AS connection
    JOIN public.oauth_client_webhooks AS webhook ON webhook.client_id = connection.client_id
   WHERE connection.user_id = OLD.id AND connection.revoked_at IS NULL AND connection.connected_at IS NOT NULL
     AND webhook.enabled AND 'connection.revoked' = ANY(webhook.events)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.partner_webhook_outbox
    (client_id, connection_id, connection_generation, endpoint_version, type, subject, occurred_at)
  SELECT connection.client_id, connection.id, connection.generation, webhook.version, 'connection.revoked', subject.subject, clock_timestamp()
    FROM public.oauth_connections AS connection
    JOIN public.oauth_subjects AS subject ON subject.client_id = connection.client_id AND subject.user_id = connection.user_id
    JOIN public.oauth_client_webhooks AS webhook ON webhook.client_id = connection.client_id
   WHERE connection.user_id = OLD.id AND connection.revoked_at IS NULL
     AND connection.connected_at IS NOT NULL
     AND webhook.enabled AND 'connection.revoked' = ANY(webhook.events)
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.partner_account_deletion_events() FROM PUBLIC;

--> statement-breakpoint
-- Publish new capabilities to existing managed clients without widening any issued credential.
UPDATE public.oauth_client AS client
   SET scopes = ARRAY['logbook:read','profile:read','workouts:read','workouts:write','offline_access']::text[]
 WHERE EXISTS (SELECT 1 FROM public.oauth_app_policy policy
                 JOIN public.oauth_client_resource resource ON resource.client_id = policy.client_id
                WHERE policy.client_id = client.client_id AND resource.resource_id = 'https://api.boardsesh.com/v1');
--> statement-breakpoint
UPDATE public.oauth_resource
   SET allowed_scopes = ARRAY['logbook:read','profile:read','workouts:read','workouts:write','offline_access']::text[],
       updated_at = clock_timestamp()
 WHERE identifier = 'https://api.boardsesh.com/v1';
