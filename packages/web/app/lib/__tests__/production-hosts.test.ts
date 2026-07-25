import { describe, expect, it } from 'vite-plus/test';
import { PRODUCTION_HOSTS, isProductionHost } from '../production-hosts';

describe('isProductionHost', () => {
  it.each(['boardsesh.com', 'www.boardsesh.com'])('treats %s as production', (hostname) => {
    expect(isProductionHost(hostname)).toBe(true);
  });

  it.each([
    // app.boardsesh.com is a separate deployment (standalone Expo-web export
    // on Cloudflare Pages) and never loads this Next.js app — see
    // docs/expo-web-deployment.md.
    'app.boardsesh.com',
    // The exact bug this module fixes: preview deploys contain "boardsesh.com"
    // as a substring and must NOT match.
    '123.preview.boardsesh.com',
    'pr-42.preview.boardsesh.com',
    'foo.boardsesh.com',
    // Look-alike hosts that a substring check would also wrongly accept.
    'boardsesh.com.evil.com',
    'evil-boardsesh.com',
    'boardsesh-preview.vercel.app',
    'localhost',
  ])('does not treat %s as production', (hostname) => {
    expect(isProductionHost(hostname)).toBe(false);
  });

  it('exposes the exact-match host set used by the Sentry gate', () => {
    expect(PRODUCTION_HOSTS.has('boardsesh.com')).toBe(true);
    expect(PRODUCTION_HOSTS.has('www.boardsesh.com')).toBe(true);
    expect(PRODUCTION_HOSTS.size).toBe(2);
  });
});
