import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const viewer = vi.hoisted(() => vi.fn());
const evaluate = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId: viewer }));
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({ getServerFeatureFlag: evaluate }));
import { getBoardVisibilityFlags, pairLaunchFlagValues } from '../board-visibility.server';

describe('server board visibility', () => {
  it('uses the admitted viewer identity and permits anonymous public rollout', async () => {
    viewer.mockResolvedValue('viewer-id');
    evaluate.mockResolvedValue(false);
    expect(await getBoardVisibilityFlags()).toEqual({ 'quantum-board': false });
    expect(evaluate).toHaveBeenLastCalledWith('quantum-board', { distinctId: 'viewer-id', allowAnonymous: true });
    evaluate.mockResolvedValue(true);
    expect(await getBoardVisibilityFlags(null)).toEqual({ 'quantum-board': true });
    expect(evaluate).toHaveBeenLastCalledWith('quantum-board', { distinctId: null, allowAnonymous: true });
    expect(viewer).toHaveBeenCalledTimes(1);
  });

  it('gives each launch flag the answer at its own position', () => {
    // One launch flag ships today, so only this reaches a second position.
    expect(pairLaunchFlagValues(['flag-a', 'flag-b', 'flag-c'], [true, false, true])).toEqual({
      'flag-a': true,
      'flag-b': false,
      'flag-c': true,
    });
  });
});
