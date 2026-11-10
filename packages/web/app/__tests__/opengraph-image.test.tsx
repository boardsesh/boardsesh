import { describe, it, expect } from 'vite-plus/test';
import sharp from 'sharp';
import OgImage, { alt, size, contentType } from '../opengraph-image';
import TwitterImage, { contentType as twitterContentType } from '../twitter-image';

describe('opengraph-image', () => {
  it('declares the size the committed card really is', async () => {
    const metadata = await sharp(Buffer.from(await OgImage().arrayBuffer())).metadata();

    expect(size).toEqual({ width: 1200, height: 630 });
    expect(metadata).toMatchObject({ format: 'jpeg', width: size.width, height: size.height });
  });

  it('declares the content type it serves', () => {
    const response = OgImage();

    expect(contentType).toBe('image/jpeg');
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('keeps the file small enough for an unfurler', async () => {
    const bytes = await OgImage().arrayBuffer();

    expect(bytes.byteLength).toBeGreaterThan(10_000);
    expect(bytes.byteLength).toBeLessThan(300_000);
  });

  it('names the brand in the alt text', () => {
    expect(alt.toLowerCase()).toContain('boardsesh');
  });

  it('serves the same card to Twitter', async () => {
    expect(twitterContentType).toBe('image/jpeg');
    expect(await TwitterImage().arrayBuffer()).toEqual(await OgImage().arrayBuffer());
  });
});
