import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/instagram-meta', async () => {
  const actual = await vi.importActual<typeof import('../lib/instagram-meta')>('../lib/instagram-meta');
  return {
    ...actual,
    fetchInstagramMeta: vi.fn(),
  };
});

import { fetchInstagramMeta } from '../lib/instagram-meta';
import { InstagramBetaValidationError, validateInstagramBetaLink } from '../utils/instagram-beta-validation';

const fetchInstagramMetaMock = vi.mocked(fetchInstagramMeta);

describe('validateInstagramBetaLink', () => {
  beforeEach(() => {
    fetchInstagramMetaMock.mockReset();
  });

  it('returns metadata for a public post', async () => {
    fetchInstagramMetaMock.mockResolvedValue({
      status: 'ok',
      thumbnail: 'https://cdn.example.com/photo.jpg',
      username: 'camgibbs',
      caption: null,
    });

    await expect(validateInstagramBetaLink('https://www.instagram.com/p/CU-NOpdL8Kf/')).resolves.toEqual({
      imageUrl: 'https://cdn.example.com/photo.jpg',
      mediaId: 'CU-NOpdL8Kf',
      username: 'camgibbs',
    });
  });

  it('returns metadata even when the caption does not mention the climb', async () => {
    // Regression: write-time validation no longer requires the caption to
    // mention the climb name. A reel with a caption like
    // `"Giraff" v6 @ 35° on the Kilter Board` should attach successfully
    // regardless of whether the resolver knows the climb's name.
    fetchInstagramMetaMock.mockResolvedValue({
      status: 'ok',
      thumbnail: 'https://cdn.example.com/photo.jpg',
      username: 'someone',
      caption: null,
    });

    await expect(validateInstagramBetaLink('https://www.instagram.com/reel/DLM2nf9S1h6/')).resolves.toMatchObject({
      mediaId: 'DLM2nf9S1h6',
    });
  });

  it('rejects a deleted/private post with the post-unavailable message', async () => {
    fetchInstagramMetaMock.mockResolvedValue({ status: 'gone' });

    await expect(validateInstagramBetaLink('https://www.instagram.com/p/CU-NOpdL8Kf/')).rejects.toThrowError(
      "This Instagram post isn't available",
    );
  });

  it('surfaces transient Instagram failures with a retry-friendly message', async () => {
    fetchInstagramMetaMock.mockResolvedValue({ status: 'transient_error' });

    await expect(validateInstagramBetaLink('https://www.instagram.com/p/CU-NOpdL8Kf/')).rejects.toThrowError(
      'Instagram is temporarily blocking us',
    );
  });

  it('rejects URLs with no parseable media id without hitting the network', async () => {
    await expect(validateInstagramBetaLink('https://www.instagram.com/explore/')).rejects.toBeInstanceOf(
      InstagramBetaValidationError,
    );
    expect(fetchInstagramMetaMock).not.toHaveBeenCalled();
  });

  it('normalizes an empty-string thumbnail to null', async () => {
    // fetchInstagramMeta in practice returns 'gone' when no thumbnail is
    // found, so a status:'ok' with thumbnail:'' is a defensive contract test
    // — the validator shouldn't propagate '' as a fake imageUrl since
    // downstream consumers may null-check rather than truthy-check.
    fetchInstagramMetaMock.mockResolvedValue({
      status: 'ok',
      thumbnail: '',
      username: null,
      caption: null,
    });

    await expect(validateInstagramBetaLink('https://www.instagram.com/p/CU-NOpdL8Kf/')).resolves.toEqual({
      imageUrl: null,
      mediaId: 'CU-NOpdL8Kf',
      username: null,
    });
  });

  it('wraps unexpected fetchInstagramMeta errors as a transient validation error', async () => {
    // fetchInstagramMeta is designed to return status enums, never throw —
    // but if it ever does (regex blowup, dependency regression), the user
    // should see our specific transient-error message, not Yoga's generic
    // "Unexpected error." toast from masked errors in production.
    fetchInstagramMetaMock.mockRejectedValue(new Error('boom'));

    await expect(validateInstagramBetaLink('https://www.instagram.com/p/CU-NOpdL8Kf/')).rejects.toThrowError(
      'Instagram is temporarily blocking us',
    );
  });
});
