import { describe, it, expect, vi, afterEach } from 'vitest';

// query-provider imports AppState/Platform from react-native, which can't load
// under vitest's node env — mock it. NetInfo resolves via the netinfo-stub alias
// (vite.config.ts), which reports connected, so the module-load seed leaves
// onlineManager online; each test drives it offline explicitly below.
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, _handler: (status: string) => void) => ({ remove: () => {} }),
  },
  Platform: { OS: 'ios' },
}));

vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));

import { onlineManager } from '@tanstack/react-query';
import { createQueryClient } from '../query-provider';

describe('createQueryClient network mode', () => {
  afterEach(() => {
    // onlineManager is a process-global singleton; restore it so this offline
    // state doesn't bleed into other assertions.
    onlineManager.setOnline(true);
  });

  it('fetches queries while offline (offlineFirst) instead of pausing them', async () => {
    onlineManager.setOnline(false);
    const queryClient = createQueryClient();
    const queryFn = vi.fn().mockResolvedValue('payload');

    // With the default networkMode 'online', an offline query pauses and this
    // promise would never settle (the test would time out). 'offlineFirst' runs
    // the fetch once regardless, so it resolves — proving data screens can't be
    // stranded by a wrong/late NetInfo offline signal.
    await expect(queryClient.fetchQuery({ queryKey: ['offline-first-probe'], queryFn })).resolves.toBe('payload');
    expect(queryFn).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });
});
