// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'ios' }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
}));

import { LaunchReadyProvider } from '../../providers/launch-ready-context';
import { useLaunchHoldReleased } from '../launch-hold';

function renderHold(initialReady: boolean) {
  let ready = initialReady;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LaunchReadyProvider ready={ready}>{children}</LaunchReadyProvider>
  );
  const rendered = renderHook(() => useLaunchHoldReleased(), { wrapper });
  return {
    result: rendered.result,
    setReady(nextReady: boolean) {
      ready = nextReady;
      rendered.rerender();
    },
  };
}

beforeEach(() => {
  platform.os = 'ios';
});

describe('useLaunchHoldReleased', () => {
  it.each(['ios', 'android'])('holds on %s until launch is ready', (os) => {
    platform.os = os;
    // One mounted hook: the gate resolves while the held screen is on screen.
    const hold = renderHold(false);
    expect(hold.result.current).toBe(false);

    hold.setReady(true);
    expect(hold.result.current).toBe(true);
  });

  it('never holds the browser target, which is not gated', () => {
    platform.os = 'web';
    expect(renderHold(false).result.current).toBe(true);
  });
});
