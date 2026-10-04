// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'ios' }));
const launch = vi.hoisted(() => ({ ready: false }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
}));
vi.mock('../../providers/launch-ready-context', () => ({ useLaunchReady: () => launch.ready }));

import { useLaunchHoldReleased } from '../launch-hold';

beforeEach(() => {
  platform.os = 'ios';
  launch.ready = false;
});

describe('useLaunchHoldReleased', () => {
  it.each(['ios', 'android'])('holds on %s until launch is ready', (os) => {
    platform.os = os;
    expect(renderHook(() => useLaunchHoldReleased()).result.current).toBe(false);

    launch.ready = true;
    expect(renderHook(() => useLaunchHoldReleased()).result.current).toBe(true);
  });

  it('never holds the browser target, which is not gated', () => {
    platform.os = 'web';
    expect(renderHook(() => useLaunchHoldReleased()).result.current).toBe(true);
  });
});
