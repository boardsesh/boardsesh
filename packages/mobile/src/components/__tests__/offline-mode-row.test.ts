import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TFunction } from 'i18next';

const setOfflineMode = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  setOfflineMode: (enabled: boolean, source: string) => setOfflineMode(enabled, source),
}));

const hapticSelection = vi.hoisted(() => vi.fn());
vi.mock('../../lib/haptics', () => ({ hapticSelection: () => hapticSelection() }));

import { buildOfflineModeRow } from '../offline-mode-row';

// The screen's real `t` resolves the catalog; here the key itself is the useful
// assertion, because what can silently break is the key, not the translation.
const translate = ((key: string) => key) as unknown as TFunction<'common'>;

describe('buildOfflineModeRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a switch labelled from the catalog', () => {
    const row = buildOfflineModeRow(translate, false);

    expect(row).toMatchObject({
      kind: 'toggle',
      key: 'offlineMode',
      label: 'mobile.more.offline.offlineMode',
      subtitle: 'mobile.more.offline.offlineModeDescription',
      value: false,
    });
  });

  it('shows the store as the source of truth, not a local setting read', () => {
    expect(buildOfflineModeRow(translate, true).value).toBe(true);
  });

  // Through the store, with the source attached: `setSetting` would still reach
  // the store (it subscribes) but would file an event nobody could attribute.
  it('routes the flip through the store, tagged as the More screen', () => {
    buildOfflineModeRow(translate, false).onValueChange(true);

    expect(setOfflineMode).toHaveBeenCalledExactlyOnceWith(true, 'more');
  });

  it('turns it back off the same way', () => {
    buildOfflineModeRow(translate, true).onValueChange(false);

    expect(setOfflineMode).toHaveBeenCalledExactlyOnceWith(false, 'more');
  });

  it('taps back, like every other switch on the screen', () => {
    buildOfflineModeRow(translate, false).onValueChange(true);

    expect(hapticSelection).toHaveBeenCalledOnce();
  });
});
