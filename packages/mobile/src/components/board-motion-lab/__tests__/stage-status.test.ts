import { describe, expect, it } from 'vitest';
import { stageStatus, type StageStatusInput } from '../stage-status';

const DRAWING: StageStatusInput = {
  hasRenderData: true,
  hasClimbs: true,
  apiVersion: 7,
  hasMotionView: true,
  gpuSettingOn: true,
  gpuAllowed: true,
  gpuBoard: true,
  renderPath: 'gpu',
  timings: { prepareMs: 42, uploadMs: 3 },
  gpuError: null,
};

describe('stageStatus', () => {
  it('reports the GPU with the last presentation’s timings', () => {
    expect(stageStatus(DRAWING)).toEqual({ path: 'gpu', apiVersion: 7, prepareMs: 42, uploadMs: 3 });
  });

  it('carries a look variant’s native look state, and none for A to C', () => {
    expect(stageStatus({ ...DRAWING, look: { state: 'on', holds: 24 } })).toEqual({
      path: 'gpu',
      apiVersion: 7,
      prepareMs: 42,
      uploadMs: 3,
      look: { state: 'on', holds: 24 },
    });
    expect(stageStatus(DRAWING)).not.toHaveProperty('look');
  });

  it('is loading until the carousel says what it draws and the GPU first presents', () => {
    expect(stageStatus({ ...DRAWING, renderPath: null })).toEqual({ path: 'loading' });
    expect(stageStatus({ ...DRAWING, timings: null })).toEqual({ path: 'loading' });
  });

  it.each([
    [{ hasRenderData: false }, 'no bundled art'],
    [{ hasClimbs: false }, 'no climbs'],
    [{ apiVersion: 0, hasMotionView: false }, 'no GPU board'],
    [{ apiVersion: 1, hasMotionView: false }, 'native API 1'],
    [{ gpuSettingOn: false, gpuAllowed: false, gpuBoard: false }, 'Settings'],
    [{ gpuAllowed: false, gpuBoard: false }, 'remotely'],
    [{ gpuBoard: false }, 'this board'],
    [{ renderPath: 'png' as const, gpuError: 'presentation-timeout' }, 'GPU failed: presentation-timeout'],
    [{ renderPath: 'png' as const }, 'latched'],
  ])('says why it draws PNG (%o)', (change, reason) => {
    const status = stageStatus({ ...DRAWING, ...change });
    expect(status.path).toBe('png');
    expect(status.path === 'png' ? status.reason : '').toContain(reason);
  });
});
