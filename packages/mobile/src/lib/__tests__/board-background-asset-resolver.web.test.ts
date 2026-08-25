import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBoardBackgroundAsset } from '../board-background-asset-resolver.web';

const asset = { objectKey: `static/v1/${'a'.repeat(64)}.webp` };

afterEach(() => vi.unstubAllEnvs());

describe('Expo web board background URL resolution', () => {
  it('uses same-origin public images for local and PR builds', () => {
    vi.stubEnv('EXPO_PUBLIC_STATIC_ASSET_BASE_URL', undefined);
    expect(resolveBoardBackgroundAsset(asset, 'kilter/example.webp')).toBe('/images/kilter/example.webp');
  });

  it('uses the configured immutable asset origin in production', () => {
    vi.stubEnv('EXPO_PUBLIC_STATIC_ASSET_BASE_URL', 'https://assets.boardsesh.com/');
    expect(resolveBoardBackgroundAsset(asset, 'kilter/example.webp')).toBe(
      `https://assets.boardsesh.com/static/v1/${'a'.repeat(64)}.webp`,
    );
  });
});
