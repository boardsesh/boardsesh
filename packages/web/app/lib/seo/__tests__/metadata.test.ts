import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_OG_IMAGE_PATH,
  SITE_NAME,
  createNoIndexMetadata,
  createPageMetadata,
  withBrandTitle,
} from '../metadata';

describe('SEO metadata helper', () => {
  describe('withBrandTitle', () => {
    it('appends the brand suffix when missing', () => {
      expect(withBrandTitle('About')).toBe('About | Boardsesh');
    });

    it('preserves already branded titles', () => {
      expect(withBrandTitle('About | Boardsesh')).toBe('About | Boardsesh');
      expect(withBrandTitle('Boardsesh - Train smarter on your climbing board')).toBe(
        'Boardsesh - Train smarter on your climbing board',
      );
    });
  });

  describe('createPageMetadata', () => {
    it('builds canonical, Open Graph, and Twitter metadata with normalized paths', () => {
      const metadata = createPageMetadata({
        title: 'API Documentation',
        description: 'REST and WebSocket docs for Boardsesh.',
        path: 'docs',
      });

      expect(metadata.title).toBe('API Documentation | Boardsesh');
      expect(metadata.description).toBe('REST and WebSocket docs for Boardsesh.');
      expect(metadata.alternates?.canonical).toBe('/docs');
      expect(metadata.openGraph).toEqual({
        title: 'API Documentation | Boardsesh',
        description: 'REST and WebSocket docs for Boardsesh.',
        type: 'website',
        url: '/docs',
        siteName: SITE_NAME,
        // Default locale (en-US) is now emitted as the OG locale tag so non-English
        // surfaces can opt into es_ES via the createPageMetadata({ locale }) param.
        locale: 'en_US',
        images: [
          {
            url: DEFAULT_OG_IMAGE_PATH,
            alt: 'API Documentation | Boardsesh',
            width: 1200,
            height: 630,
          },
        ],
      });
      expect(metadata.twitter).toEqual({
        card: 'summary_large_image',
        title: 'API Documentation | Boardsesh',
        description: 'REST and WebSocket docs for Boardsesh.',
        images: [DEFAULT_OG_IMAGE_PATH],
      });
    });

    it('passes an absolute image URL through untouched for OG and Twitter', () => {
      const absoluteImageUrl = 'https://ws.boardsesh.com/og/climb?board_name=kilter&variant=og&format=jpeg';
      const metadata = createPageMetadata({
        title: 'Kilter Climb',
        description: 'A shared climb card.',
        path: 'b/my-board/40/view/test-climb',
        imagePath: absoluteImageUrl,
      });

      const image = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images[0] : undefined;
      expect(image).toMatchObject({ url: absoluteImageUrl });
      expect(metadata.twitter?.images).toEqual([absoluteImageUrl]);
    });

    it('supports pages without a canonical path or social image', () => {
      const metadata = createPageMetadata({
        title: 'Standalone',
        description: 'No canonical or image.',
        imagePath: null,
      });

      expect(metadata.alternates).toBeUndefined();
      expect(metadata.openGraph?.url).toBeUndefined();
      expect(metadata.openGraph?.images).toBeUndefined();
      expect(metadata.twitter?.images).toBeUndefined();
    });
  });

  describe('createNoIndexMetadata', () => {
    it('marks utility pages as noindex while preserving canonical metadata', () => {
      const metadata = createNoIndexMetadata({
        title: 'Login',
        description: 'Sign in to Boardsesh.',
        path: '/auth/login',
      });

      expect(metadata.robots).toEqual({ index: false, follow: true });
      expect(metadata.alternates?.canonical).toBe('/auth/login');
      expect(metadata.title).toBe('Login | Boardsesh');
    });
  });
});
