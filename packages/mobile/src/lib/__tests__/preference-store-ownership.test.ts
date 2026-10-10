import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getItem } = vi.hoisted(() => ({ getItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem } }));

import { getPreference } from '../preference-store';

describe('strict preference reads for attribution ownership', () => {
  beforeEach(() => {
    getItem.mockReset();
  });

  it('distinguishes a missing ownership record from corrupt JSON', async () => {
    getItem.mockResolvedValue(null);
    await expect(getPreference('appleAdsAttributionV1', { strictParsing: true })).resolves.toBeNull();
    getItem.mockResolvedValue('{"ownerId":');
    await expect(getPreference('appleAdsAttributionV1', { strictParsing: true })).rejects.toThrow(SyntaxError);
    getItem.mockResolvedValue('null');
    await expect(getPreference('appleAdsAttributionV1', { strictParsing: true })).rejects.toThrow(
      'Stored preference record was null',
    );
  });

  it('preserves tolerant reads for ordinary preferences', async () => {
    getItem.mockResolvedValue('{"ownerId":');
    await expect(getPreference('ordinaryPreference')).resolves.toBeNull();
    getItem.mockRejectedValue(new Error('Storage unavailable'));
    await expect(getPreference('ordinaryPreference')).rejects.toThrow('Storage unavailable');
  });
});
