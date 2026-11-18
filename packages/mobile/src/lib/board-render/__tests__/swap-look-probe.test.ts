import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ addErrorBreadcrumb: vi.fn() }));
vi.mock('../../error-reporting', () => ({ addErrorBreadcrumb: controls.addErrorBreadcrumb }));

import { parseSwapLookProbe } from '../gpu-native-capability';

beforeEach(() => {
  controls.addErrorBreadcrumb.mockClear();
  vi.resetModules();
});

describe('swapLookProbe', () => {
  it('reads the Android constant and nothing else', () => {
    expect(parseSwapLookProbe({ result: 'timeout', ms: 1004 })).toEqual({ result: 'timeout', ms: 1004 });
    expect(parseSwapLookProbe({ result: 'failed', ms: 38, failure: 'compile' })).toEqual({
      result: 'failed',
      ms: 38,
      failure: 'compile',
    });
    expect(parseSwapLookProbe({ result: 'cached-built', ms: 6, failure: '' })).toEqual({
      result: 'cached-built',
      ms: 6,
    });
    // iOS and older Android binaries have no constant.
    expect(parseSwapLookProbe(undefined)).toBeNull();
    expect(parseSwapLookProbe({ result: 'not-applicable', ms: 0 })).toBeNull();
    expect(parseSwapLookProbe({ result: 'built' })).toBeNull();
    expect(parseSwapLookProbe({ result: 'built', ms: -1 })).toBeNull();
    expect(parseSwapLookProbe({ result: 'built', ms: Number.NaN })).toBeNull();
  });

  it('leaves a breadcrumb only for a probe that left the look off', async () => {
    const { swapLookProbeBreadcrumb } = await import('../swap-look-probe');
    expect(swapLookProbeBreadcrumb({ result: 'timeout', ms: 1004 })).toEqual({
      category: 'board-render',
      message: 'Swap look off: probe timeout',
      level: 'warning',
      data: { result: 'timeout', ms: 1004 },
    });
    expect(swapLookProbeBreadcrumb({ result: 'failed', ms: 38, failure: 'link' })).toEqual({
      category: 'board-render',
      message: 'Swap look off: probe failed',
      level: 'warning',
      data: { result: 'failed', ms: 38, failure: 'link' },
    });
    expect(swapLookProbeBreadcrumb({ result: 'cached-failed', ms: 9, failure: 'compile' })?.level).toBe('info');
    expect(swapLookProbeBreadcrumb({ result: 'built', ms: 210 })).toBeNull();
    expect(swapLookProbeBreadcrumb({ result: 'cached-built', ms: 9 })).toBeNull();
    expect(swapLookProbeBreadcrumb(null)).toBeNull();
  });

  it('leaves it once per process, however many boards mount', async () => {
    const { noteSwapLookProbe } = await import('../swap-look-probe');
    noteSwapLookProbe({ result: 'timeout', ms: 1004 });
    noteSwapLookProbe({ result: 'timeout', ms: 1004 });
    expect(controls.addErrorBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it('leaves none on iOS or when the look built', async () => {
    const { noteSwapLookProbe } = await import('../swap-look-probe');
    noteSwapLookProbe(null);
    expect(controls.addErrorBreadcrumb).not.toHaveBeenCalled();
  });
});
