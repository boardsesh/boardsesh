import { sql } from 'drizzle-orm';
import { oauthConnections } from '@boardsesh/db/schema/auth';
import { PARTNER_RESOURCE } from '../../auth/partner/configuration';

/** Connection.scopes is not authoritative: only current token families grant access. */
export function liveWebhookScopeCondition(scope: string) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM public.oauth_grants AS grant_row
    WHERE grant_row.connection_id = ${oauthConnections.id}
      AND grant_row.generation = ${oauthConnections.generation}
      AND (
        EXISTS (SELECT 1 FROM public.oauth_access_token AS token
          WHERE token.authorization_code_id = grant_row.authorization_code_id
            AND token.client_id = ${oauthConnections.clientId} AND token.user_id = ${oauthConnections.userId}
            AND token.revoked IS NULL AND token.expires_at > now() AND token.confirmation IS NULL
            AND ${scope} = ANY(token.scopes) AND ${PARTNER_RESOURCE} = ANY(token.resources)
            AND (token.session_id IS NULL OR EXISTS (SELECT 1 FROM public.oauth_session AS session_row WHERE session_row.id = token.session_id AND session_row.expires_at > now())))
        OR EXISTS (SELECT 1 FROM public.oauth_refresh_token AS token
          WHERE token.authorization_code_id = grant_row.authorization_code_id
            AND token.client_id = ${oauthConnections.clientId} AND token.user_id = ${oauthConnections.userId}
            AND token.revoked IS NULL AND token.rotated_at IS NULL AND token.expires_at > now() AND token.confirmation IS NULL
            AND ${scope} = ANY(token.scopes) AND ${PARTNER_RESOURCE} = ANY(token.resources)
            AND (token.session_id IS NULL OR EXISTS (SELECT 1 FROM public.oauth_session AS session_row WHERE session_row.id = token.session_id AND session_row.expires_at > now())))
      )
  )`;
}
