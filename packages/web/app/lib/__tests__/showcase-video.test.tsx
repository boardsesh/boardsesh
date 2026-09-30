// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';
import ShowcaseVideoJsonLd from '@/app/components/seo/showcase-video-json-ld';
import { SHOWCASE_FPS } from '../../../../../scripts/lib/showcase-video/contract';
import { SHOWCASE_TOTAL_FRAMES } from '../../../../../scripts/lib/showcase-video/timeline';
import { showcaseVideoJsonLd, showcaseVideoSources } from '../showcase-video';

describe('showcase video', () => {
  it('serves one 9:16 lite cut everywhere', () => {
    expect(showcaseVideoSources()).toEqual({
      webm: '/videos/home/showcase-9x16-lite.webm',
      mp4: '/videos/home/showcase-9x16-lite.mp4',
      poster: '/images/home/showcase-hero-9x16.webp',
    });
  });

  it('describes the video as a VideoObject with absolute URLs', () => {
    expect(showcaseVideoJsonLd()).toMatchObject({
      '@type': 'VideoObject',
      uploadDate: '2026-09-30T00:00:00+10:00',
      duration: 'PT41.6S',
      thumbnailUrl: 'https://www.boardsesh.com/images/home/showcase-hero-9x16.webp',
      contentUrl: 'https://www.boardsesh.com/videos/home/showcase-9x16-lite.mp4',
    });
  });

  it('declares a duration equal to the timeline length', () => {
    const seconds = SHOWCASE_TOTAL_FRAMES / SHOWCASE_FPS;
    expect(showcaseVideoJsonLd().duration).toBe(`PT${seconds.toFixed(1)}S`);
  });

  it('renders the JSON-LD script', () => {
    const html = renderToStaticMarkup(<ShowcaseVideoJsonLd />);
    expect(html).toContain('application/ld+json');
    expect(html).toContain('VideoObject');
  });
});
