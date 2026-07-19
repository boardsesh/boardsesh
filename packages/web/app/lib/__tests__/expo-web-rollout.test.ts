import { describe, expect, it } from 'vite-plus/test';
import { mapToExpoWebTarget } from '../expo-web-rollout';

/**
 * SPA-contract parity: every URL this map emits must be one the /app Expo SPA
 * actually handles today.
 *
 * - `/app/climbs` (the Climbs tab, packages/mobile/app/(tabs)/climbs/index.tsx)
 *   reads NO board-context search params — its board comes from the visitor's
 *   persisted active board. So list redirects must carry no query string.
 * - `/app/climbs/[uuid]` (ClimbDetail, packages/mobile/app/(tabs)/climbs/
 *   [climbUuid].tsx) requires boardName/layoutId/sizeId/setIds/angle and
 *   `Number(...)`s the IDs, so only the fully-numeric legacy form may redirect
 *   there. Named-slug segments (`original`, `12x12-square`) and `/b/[slug]`
 *   URLs have no SPA-side resolution and must stay classic (null) — a redirect
 *   would land on a permanent not-found screen.
 */
describe('mapToExpoWebTarget', () => {
  describe('board list surfaces -> /app/climbs with no query (SPA ignores board-context params)', () => {
    it.each([
      ['legacy numeric', '/kilter/1/10/1,20/40/list'],
      ['legacy named-slug', '/kilter/original/12x12-square/screw_bolt/40/list'],
      ['slug', '/b/kilter-original-12x12/40/list'],
    ])('maps the %s list URL to the bare climbs tab', (_form, pathname) => {
      const target = mapToExpoWebTarget(pathname);
      expect(target).not.toBeNull();
      const url = new URL(target!, 'http://localhost');
      expect(url.pathname).toBe('/app/climbs');
      expect(url.search).toBe('');
    });

    it('strips a locale prefix (the /app SPA is locale-neutral)', () => {
      const target = mapToExpoWebTarget('/es/b/kilter-original-12x12/40/list');
      expect(target).not.toBeNull();
      expect(new URL(target!, 'http://localhost').pathname).toBe('/app/climbs');
    });
  });

  describe('climb view surfaces', () => {
    it('maps a fully-numeric legacy view URL to the climb deep-link with the mobile ClimbDetail param contract', () => {
      const target = mapToExpoWebTarget('/kilter/1/10/1,20/40/view/abc-uuid');
      expect(target).not.toBeNull();
      const url = new URL(target!, 'http://localhost');
      expect(url.pathname).toBe('/app/climbs/abc-uuid');
      expect(url.searchParams.get('boardName')).toBe('kilter');
      expect(url.searchParams.get('layoutId')).toBe('1');
      expect(url.searchParams.get('sizeId')).toBe('10');
      expect(url.searchParams.get('setIds')).toBe('1,20');
      expect(url.searchParams.get('angle')).toBe('40');
    });

    it('decodes an encoded setIds segment before forwarding it', () => {
      const target = mapToExpoWebTarget('/kilter/1/10/1%2C20/40/view/abc-uuid');
      expect(target).not.toBeNull();
      const url = new URL(target!, 'http://localhost');
      expect(url.searchParams.get('setIds')).toBe('1,20');
    });

    it('keeps the canonical named-slug view URL classic (ClimbDetail would get layoutId=NaN)', () => {
      // This is what constructClimbViewUrlWithSlugs emits — the URL shape real
      // users share. Number('original') is NaN, so it must not redirect.
      expect(mapToExpoWebTarget('/kilter/original/12x12-square/screw_bolt/40/view/abc-uuid')).toBeNull();
    });

    it('keeps a mixed numeric/named view URL classic', () => {
      expect(mapToExpoWebTarget('/grasshopper/2020/grandmaster-12-x-12/1,20/40/view/abc-uuid')).toBeNull();
    });

    it('keeps the slug view URL classic (no boardSlug resolution in the SPA)', () => {
      expect(mapToExpoWebTarget('/b/kilter-original-12x12/40/view/abc-uuid')).toBeNull();
    });
  });

  describe('non-migrated surfaces stay classic (null)', () => {
    it.each([
      '/',
      '/playlists',
      '/playlists/abc',
      '/gym/some-gym',
      '/u/marco',
      '/kilter/1/10/1,20/40/create',
      '/kilter/1/10/1,20/40/queue',
      '/b/kilter-original-12x12/40/create',
      '/api/v1/kilter/proxy/login',
      '/kilter/1/10/1,20/40', // board page, not a list/view
    ])('returns null for %s', (pathname) => {
      expect(mapToExpoWebTarget(pathname)).toBeNull();
    });
  });
});
