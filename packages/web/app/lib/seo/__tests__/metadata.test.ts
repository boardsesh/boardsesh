import { describe, expect, it } from 'vitest';
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
        images: [
          {
            url: DEFAULT_OG_IMAGE_PATH,
            alt: 'API Documentation | Boardsesh',
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
