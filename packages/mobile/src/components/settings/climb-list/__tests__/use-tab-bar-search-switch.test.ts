// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: true,
  launchChoice: true,
  stored: true,
  setStored: vi.fn(),
  confirm: vi.fn(),
  restartApp: vi.fn(),
  track: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../settings', () => ({
  useSetting: () => [mocks.stored, mocks.setStored],
}));
vi.mock('../../../../providers/dialog-provider', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../lib/app-restart', () => ({ restartApp: mocks.restartApp }));
vi.mock('../../../../lib/settings-analytics', () => ({ trackSettingChanged: mocks.track }));
vi.mock('../../../../hooks/use-climbs-tab-bar-search', () => ({
  useClimbsTabBarSearchAvailable: () => mocks.available,
  climbsTabBarSearchLaunchChoice: () => mocks.launchChoice,
}));

import { useTabBarSearchSwitch } from '../use-tab-bar-search-switch';

beforeEach(() => {
  mocks.available = true;
  mocks.launchChoice = true;
  mocks.stored = true;
  mocks.setStored.mockReset();
  mocks.confirm.mockReset();
  mocks.restartApp.mockReset();
  mocks.track.mockReset();
});

describe('useTabBarSearchSwitch', () => {
  it('offers no switch where the bar has no search tab', () => {
    mocks.available = false;
    const { result } = renderHook(() => useTabBarSearchSwitch());
    expect(result.current).toBeNull();
  });

  it('stores the flip, tracks it, and restarts when the climber says Restart now', async () => {
    mocks.confirm.mockResolvedValue(true);
    const { result } = renderHook(() => useTabBarSearchSwitch());

    await act(async () => result.current?.onChange(false));

    expect(mocks.setStored).toHaveBeenCalledWith(false);
    expect(mocks.track).toHaveBeenCalledWith('climbList', 'climbsTabBarSearch', false);
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith({
      title: 'mobile.settings.tabBarSearch.restartTitle',
      message: 'mobile.settings.tabBarSearch.restartMessage',
      confirmLabel: 'mobile.settings.tabBarSearch.restartNow',
      cancelLabel: 'mobile.settings.tabBarSearch.restartLater',
    });
    expect(mocks.restartApp).toHaveBeenCalledOnce();
  });

  it('keeps the choice for the next start when the climber says Later', async () => {
    mocks.confirm.mockResolvedValue(false);
    const { result } = renderHook(() => useTabBarSearchSwitch());

    await act(async () => result.current?.onChange(false));

    expect(mocks.setStored).toHaveBeenCalledWith(false);
    expect(mocks.restartApp).not.toHaveBeenCalled();
  });

  it('asks nothing when the flip goes back to what this launch already shows', async () => {
    mocks.stored = false;
    mocks.launchChoice = true;
    const { result } = renderHook(() => useTabBarSearchSwitch());

    await act(async () => result.current?.onChange(true));

    expect(mocks.setStored).toHaveBeenCalledWith(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.restartApp).not.toHaveBeenCalled();
  });
});
