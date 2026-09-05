import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkForUpdateAsyncMock = vi.hoisted(() => vi.fn(async () => ({ isAvailable: false })));
const fetchUpdateAsyncMock = vi.hoisted(() => vi.fn(async () => ({ isNew: true })));

vi.mock('expo-updates', () => ({
  checkForUpdateAsync: checkForUpdateAsyncMock,
  fetchUpdateAsync: fetchUpdateAsyncMock,
}));

import { setNetworkPolicy } from '../network-policy';
import { checkForOtaUpdate, fetchOtaUpdate } from '../ota-network';

describe('OTA network policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNetworkPolicy('account-offline');
  });

  it.each(['account-offline', 'local-catalog-only'] as const)('blocks check and fetch in %s mode', async (policy) => {
    setNetworkPolicy(policy);

    expect(() => checkForOtaUpdate()).toThrow(expect.objectContaining({ kind: 'ota', policy }));
    expect(() => fetchOtaUpdate()).toThrow(expect.objectContaining({ kind: 'ota', policy }));
    expect(checkForUpdateAsyncMock).not.toHaveBeenCalled();
    expect(fetchUpdateAsyncMock).not.toHaveBeenCalled();
  });

  it('allows check and fetch for an online account', async () => {
    setNetworkPolicy('online');

    await checkForOtaUpdate();
    await fetchOtaUpdate();

    expect(checkForUpdateAsyncMock).toHaveBeenCalledTimes(1);
    expect(fetchUpdateAsyncMock).toHaveBeenCalledTimes(1);
  });
});
