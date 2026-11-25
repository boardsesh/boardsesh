// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import ShowcaseVideoJsonLd from '@/app/components/seo/showcase-video-json-ld';
import { showcasePosterSources, showcaseVideoJsonLd, showcaseVideoSources } from '../showcase-video';

describe('showcase video', () => {
  it('serves one 9:16 lite cut everywhere', () => {
    expect(showcaseVideoSources()).toEqual({
      webm: '/videos/home/showcase-9x16-lite.webm',
      mp4: '/videos/home/showcase-9x16-lite.mp4',
      poster: '/images/home/showcase-hero-9x16.webp',
    });
  });

  it('resolves every responsive poster candidate directly to the immutable CDN', () => {
    vi.stubEnv('NEXT_PUBLIC_STATIC_ASSET_BASE_URL', 'https://assets.boardsesh.com/');
    try {
      const poster = showcasePosterSources();
      expect(poster.src).toMatch(/^https:\/\/assets\.boardsesh\.com\/static\/v1\/[a-f\d]{64}\.webp$/);
      const candidates = poster.srcSet.split(', ');
      expect(candidates).toHaveLength(4);
      for (const candidate of candidates) {
        expect(candidate).toMatch(
          /^https:\/\/assets\.boardsesh\.com\/static\/v1\/[a-f\d]{64}\.webp (360|540|640|720)w$/,
        );
      }
      expect(poster.srcSet).not.toContain('/_next/image');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('describes the video as a VideoObject with absolute URLs', () => {
    expect(showcaseVideoJsonLd()).toMatchObject({
      '@type': 'VideoObject',
      uploadDate: '2026-10-06T00:00:00+10:00',
      duration: 'PT54.8S',
      thumbnailUrl: 'https://www.boardsesh.com/images/home/showcase-hero-9x16.webp',
      contentUrl: 'https://www.boardsesh.com/videos/home/showcase-9x16-lite.mp4',
    });
  });

  it('renders the JSON-LD script', () => {
    const html = renderToStaticMarkup(<ShowcaseVideoJsonLd />);
    expect(html).toContain('application/ld+json');
    expect(html).toContain('VideoObject');
  });
});
