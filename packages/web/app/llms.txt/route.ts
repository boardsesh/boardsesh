import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import { EXAMPLE_URL, GUIDE_SLUGS } from '../developers/guide-documents';
import { OPENAPI_URL } from '../developers/developers-docs-samples';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const state = getDeveloperDocsState();
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, follow',
  };
  if (state === 'unavailable') return new Response(null, { status: 404, headers });
  const { t } = await getServerTranslationForLocale('en-US', 'developers');
  const lines = [
    '# Boardsesh API for apps',
    '',
    '> Connect with the climber’s consent using OAuth, synchronize their logbook, and hand them planned workouts.',
    '',
    state === 'invitation'
      ? 'Registration is invite-only. Email support@boardsesh.com for access.'
      : 'Register a public/native app for a CLI. Developer email proof is required.',
    '',
    'Start at https://www.boardsesh.com/developers. Register at https://www.boardsesh.com/developers/apps.',
    'API: https://api.boardsesh.com. OAuth issuer: https://api.boardsesh.com/api/auth. Resource: https://api.boardsesh.com/v1.',
    'Discovery: https://api.boardsesh.com/.well-known/oauth-authorization-server/api/auth.',
    'Defaults: 25 active climbers and 20 new connections per app per rolling 24 hours. Use only documented scopes.',
    '',
    '## Guides',
    '',
    ...GUIDE_SLUGS.map(
      (slug) =>
        `- [${t(`guides.${slug}.title`)}](https://www.boardsesh.com/developers/${slug}.md): ${t(`guides.${slug}.description`)}`,
    ),
    '',
    '## Files',
    '',
    `- [OpenAPI 3.1](${OPENAPI_URL}): canonical REST schemas and examples.`,
    `- [Standalone Node CLI](${EXAMPLE_URL}): PKCE loopback login, serialized refresh, durable JSON sync and disconnect. Node 22.18 or newer.`,
    '',
    'Never ask for Boardsesh passwords. Use the system browser, verify state and iss, and use PKCE S256.',
    'The first sync is a staged full replacement. Commit ticks and cursors atomically. A 410 requires a new full replacement.',
    'A 401 gets one refresh; invalid_grant requires reconnect. Honor Retry-After. Unknown fields and event types are additive.',
    'Support: support@boardsesh.com. Keep all credentials out of logs and source control.',
    '',
  ];
  return new Response(lines.join('\n'), { headers });
}
