import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchInstagramPageMetadata,
  InstagramBetaValidationError,
  instagramBetaValidationInternals,
  validateInstagramBetaLink,
} from '../utils/instagram-beta-validation';

const fetchMock = vi.fn();

describe('instagram-beta-validation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('extracts public metadata from instagram html', async () => {
    fetchMock.mockResolvedValue({
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      ok: true,
      text: async () => `
        <html><head>
          <meta name="description" content="13 likes - climber on Instagram: &quot;Fell From Heaven&quot; @ 35° on the Kilter Board Homewall." />
          <meta property="og:title" content="climber on Instagram: &quot;Fell From Heaven&quot; @ 35° on the Kilter Board Homewall." />
          <meta property="og:image" content="https://cdn.example.com/image.jpg" />
          <meta property="al:ios:url" content="instagram://media?id=123456789" />
        </head></html>
      `,
    });

    await expect(fetchInstagramPageMetadata('https://www.instagram.com/reel/DLM2nf9S1h6/')).resolves.toMatchObject({
      description: expect.stringContaining('Fell From Heaven'),
      imageUrl: 'https://cdn.example.com/image.jpg',
      mediaId: '123456789',
      ogTitle: expect.stringContaining('Fell From Heaven'),
    });
  });

  it('accepts captions that mention the climb name with forgiving normalization', async () => {
    fetchMock.mockResolvedValue({
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      ok: true,
      text: async () => `
        <html><head>
          <meta name="description" content="Had a great day. Vid #3: Cut to the Chase V10 @ 35°." />
          <meta property="og:title" content="camgibbs on Instagram: Vid #3: Cut to the Chase V10 @ 35°" />
          <meta property="og:image" content="https://cdn.example.com/image.jpg" />
          <meta property="al:ios:url" content="instagram://media?id=123456789" />
        </head></html>
      `,
    });

    await expect(
      validateInstagramBetaLink('https://www.instagram.com/p/CU-NOpdL8Kf/', 'Cut to the Chase'),
    ).resolves.toBeTruthy();
  });

  it('rejects posts that do not mention the climb name', async () => {
    fetchMock.mockResolvedValue({
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      ok: true,
      text: async () => `
        <html><head>
          <meta name="description" content="Random climbing day montage." />
          <meta property="og:title" content="climber on Instagram: random climbing day montage" />
          <meta property="og:image" content="https://cdn.example.com/image.jpg" />
          <meta property="al:ios:url" content="instagram://media?id=123456789" />
        </head></html>
      `,
    });

    await expect(
      validateInstagramBetaLink('https://www.instagram.com/p/CU-NOpdL8Kf/', 'Cut to the Chase'),
    ).rejects.toThrow(
      `We couldn't confirm this video is for "Cut to the Chase". Please use a public Instagram post or reel whose caption or title mentions the climb name.`,
    );
  });

  it('rejects pages that are not previewable instagram media', async () => {
    fetchMock.mockResolvedValue({
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      ok: true,
      text: async () => '<html><head><title>Instagram</title></head></html>',
    });

    await expect(
      validateInstagramBetaLink('https://www.instagram.com/p/CU-NOpdL8Kf/', 'Cut to the Chase'),
    ).rejects.toBeInstanceOf(InstagramBetaValidationError);
  });

  it('normalizes punctuation and entity differences when matching climb names', () => {
    expect(
      instagramBetaValidationInternals.containsNormalizedClimbName(
        'climber on instagram: &quot;There, There&quot; @ 40° on the Kilter Board',
        'There, There',
      ),
    ).toBe(true);
  });

  it('extracts the same media id from equivalent instagram url variants', () => {
    expect(instagramBetaValidationInternals.parseInstagramMediaId('https://www.instagram.com/reel/ABC123xyz/')).toBe(
      'ABC123xyz',
    );
    expect(instagramBetaValidationInternals.parseInstagramMediaId('https://www.instagram.com/p/ABC123xyz/?img_index=1')).toBe(
      'ABC123xyz',
    );
  });
});
