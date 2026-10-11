// @vitest-environment jsdom
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_ROW_DISPLAY } from '../../../../lib/climb-row-display';
const controls = vi.hoisted(() => ({
  set: vi.fn(),
  preset: vi.fn(),
  restore: vi.fn(),
  track: vi.fn(),
  haptic: vi.fn(),
}));
vi.mock('../../../../lib/climb-row-display-preference', () => ({
  useClimbRowDisplay: () => DEFAULT_CLIMB_ROW_DISPLAY,
  useClimbRowHasLastCustom: () => true,
  setClimbRowField: controls.set,
  applyClimbRowPreset: controls.preset,
  restoreLastCustomClimbRow: controls.restore,
}));
vi.mock('../../../../lib/analytics', () => ({ track: controls.track }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: controls.haptic }));
const { useClimbRowDisplayControls } = await import('../use-climb-row-display-controls');
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
describe('Climb row display controller', () => {
  it('emits analytics on interaction only', () => {
    const { result } = renderHook(useClimbRowDisplayControls);
    expect(controls.track).not.toHaveBeenCalled();
    act(() => result.current.setField('setter', false));
    expect(controls.set).toHaveBeenCalledWith('setter', false);
    expect(controls.track).toHaveBeenCalledWith('Climb Row Display Changed', {
      kind: 'field',
      field: 'setter',
      value: false,
    });
    act(() => result.current.selectPreset('textOnly'));
    expect(controls.preset).toHaveBeenCalledWith('textOnly');
    expect(controls.track).toHaveBeenLastCalledWith('Climb Row Display Changed', {
      kind: 'preset',
      preset: 'textOnly',
    });
  });
  it('restores Custom with the restoration writer', () => {
    const { result } = renderHook(useClimbRowDisplayControls);
    act(() => result.current.selectPreset('custom'));
    expect(controls.restore).toHaveBeenCalledOnce();
    expect(controls.preset).not.toHaveBeenCalled();
    expect(result.current.activePreset).toBe('default');
    expect(result.current.hasLastCustom).toBe(true);
  });
});
