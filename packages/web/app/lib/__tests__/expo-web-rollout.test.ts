import { describe, expect, it } from 'vite-plus/test';
import { mapToExpoWebTarget } from '../expo-web-rollout';

describe('mapToExpoWebTarget', () => {
  describe('board list surfaces', () => {
    it('maps a legacy numeric list URL to the climbs tab with the board-config query', () => {
      const target = mapToExpoWebTarget('/kilter/1/10/1,20/40/list');
      expect(target).not.toBeNull();
      const url = new URL(target!, 'http://localhost');
      expect(url.pathname).toBe('/app/climbs');
      expect(url.searchParams.get('boardName')).toBe('kilter');
      expect(url.searchParams.get('layoutId')).toBe('1');
      expect(url.searchParams.get('sizeId')).toBe('10');
      expect(url.searchParams.get('setIds')).toBe('1,20');
      expect(url.searchParams.get('angle')).toBe('40');
    });

    it('maps a slug list URL to the climbs tab with slug + angle', () => {
      const target = mapToExpoWebTarget('/b/kilter-original-12x12/40/list');
      expect(target).not.toBeNull();
      const url = new URL(target!, 'http://localhost');
      expect(url.pathname).toBe('/app/climbs');
      expect(url.searchParams.get('boardSlug')).toBe('kilter-original-12x12');
      expect(url.searchParams.get('angle')).toBe('40');
    });

    it('strips a locale prefix (the /app SPA is locale-neutral)', () => {
      const target = mapToExpoWebTarget('/es/b/kilter-original-12x12/40/list');
      expect(target).not.toBeNull();
      expect(new URL(target!, 'http://localhost').pathname).toBe('/app/climbs');
    });
  });

  describe('climb view surfaces', () => {
    it('maps a legacy view URL to the climb deep-link with the mobile ClimbDetail param contract', () => {
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

    it('maps a slug view URL to the climb deep-link with slug + angle', () => {
      const target = mapToExpoWebTarget('/b/kilter-original-12x12/40/view/abc-uuid');
      expect(target).not.toBeNull();
      const url = new URL(target!, 'http://localhost');
      expect(url.pathname).toBe('/app/climbs/abc-uuid');
      expect(url.searchParams.get('boardSlug')).toBe('kilter-original-12x12');
      expect(url.searchParams.get('angle')).toBe('40');
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
