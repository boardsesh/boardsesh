import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetGpuWarmConfigsForTests, isGpuConfigWarm, markGpuConfigWarm } from '../gpu-warm-configs';

describe('process-warm GPU drawings', () => {
  beforeEach(() => _resetGpuWarmConfigsForTests());

  it('starts cold and warms one drawing at a time', () => {
    expect(isGpuConfigWarm('kilter|8|player')).toBe(false);
    markGpuConfigWarm('kilter|8|player');
    expect(isGpuConfigWarm('kilter|8|player')).toBe(true);
    expect(isGpuConfigWarm('kilter|8|editor')).toBe(false);
  });

  it('keeps at most sixteen drawings, forgetting the oldest', () => {
    for (let index = 0; index < 17; index += 1) markGpuConfigWarm(`drawing-${index}`);
    expect(isGpuConfigWarm('drawing-0')).toBe(false);
    expect(isGpuConfigWarm('drawing-1')).toBe(true);
    expect(isGpuConfigWarm('drawing-16')).toBe(true);
  });

  it('starts cold again after a reload of the JS runtime', async () => {
    markGpuConfigWarm('kilter|8|player');
    vi.resetModules();
    const reloaded = await import('../gpu-warm-configs');
    expect(reloaded.isGpuConfigWarm('kilter|8|player')).toBe(false);
  });
});
