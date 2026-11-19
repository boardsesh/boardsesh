import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { EXAMPLE_URL, GUIDE_SLUGS, guideDocument, MOCK_COMMAND } from '../guide-documents';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslationForLocale: async () => ({ t: (key: string) => tFromCatalog('developers', key) }),
}));

const { guideMarkdownResponse } = await import('../guide-response');
const { GET: llmsResponse } = await import('../../llms.txt/route');
const translator = ((key: string) => tFromCatalog('developers', key)) as unknown as TFunction;
afterEach(() => vi.unstubAllEnvs());

describe('machine-readable developer guides', () => {
  it.each(['off', 'hold'])('does not advertise unavailable registration in %s mode', async (mode) => {
    vi.stubEnv('PARTNER_OAUTH_MODE', mode);
    expect((await llmsResponse()).status).toBe(404);
    expect((await guideMarkdownResponse('auth')).status).toBe(404);
  });

  it('publishes discoverable Markdown with the same safety instructions as the HTML source', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'open');
    const index = await llmsResponse();
    const content = await index.text();
    for (const slug of GUIDE_SLUGS) {
      expect(content).toContain(`/developers/${slug}.md`);
      const response = await guideMarkdownResponse(slug);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(response.headers.get('link')).toContain(`/developers/${slug}>; rel="canonical"`);
      expect(await response.text()).toBe(guideDocument(slug, translator));
    }
    expect(content).toContain(EXAMPLE_URL);
    const auth = guideDocument('auth', translator);
    expect(auth).toContain('verify state and iss');
    expect(auth).toContain('invalid_grant');
    const sync = guideDocument('sync', translator);
    expect(sync).toContain('one durable transaction');
    expect(sync).toContain('Persist a full-sync-required marker');
    expect(sync).toContain('logbook:read sessions:read offline_access');
    expect(sync).toContain('session.deleted');
    expect(sync).toContain('including workouts supplied by other apps');
    expect(sync).toContain('replace the stored token pair');
    expect(sync).toContain('primary view must visibly credit Boardsesh');
    expect(sync).toContain('action may live in an ellipsis menu');
    expect(MOCK_COMMAND).toContain('@stoplight/prism-cli@5.16.0');
  });

  it('keeps early access invitation requirements explicit', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    expect(await (await llmsResponse()).text()).toContain('Registration is invite-only');
  });
});
