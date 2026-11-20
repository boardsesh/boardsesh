import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const viewer = vi.hoisted(() => vi.fn());
const evaluate = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId: viewer }));
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({ getServerFeatureFlag: evaluate }));
import { getBoardVisibilityFlags } from '../board-visibility.server';

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
});
