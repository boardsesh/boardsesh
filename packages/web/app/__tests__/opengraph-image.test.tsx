import { describe, it, expect } from 'vite-plus/test';
import OgImage, { alt, size, contentType } from '../opengraph-image';
import { contentType as twitterContentType } from '../twitter-image';

describe('opengraph-image', () => {
  it('exports correct size (1200x630)', () => {
    expect(size).toEqual({ width: 1200, height: 630 });
  });

  it('exports png content type', () => {
    expect(contentType).toBe('image/png');
    expect(twitterContentType).toBe('image/png');
  });

  it('exports descriptive alt text', () => {
    expect(alt).toBeTruthy();
    expect(alt.toLowerCase()).toContain('boardsesh');
  });

  it('returns an ImageResponse', () => {
    const response = OgImage();
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get('content-type')).toContain('image/png');
  });
});
