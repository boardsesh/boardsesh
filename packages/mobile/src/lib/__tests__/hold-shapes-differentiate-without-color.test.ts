// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// HIG Color / WCAG 1.4.1: with iOS "Differentiate Without Color" on, hold roles
// get a shape cue on top of colour, unless the climber chose a shape themselves.

type AsyncStorageStub = {
  clear: () => Promise<void>;
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

async function getAsyncStorage(): Promise<AsyncStorageStub> {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as AsyncStorageStub;
}

async function loadStore() {
  const store = await import('../hold-color-overrides');
  const { result } = renderHook(() => store.useHoldColorOverrides());
  await waitFor(() => expect(result.current.loaded).toBe(true));
  return { store, result };
}

describe('hold shapes under Differentiate Without Color', () => {
  beforeEach(async () => {
    vi.resetModules();
    await (await getAsyncStorage()).clear();
  });

  it('draws circles while the setting is off', async () => {
    const { result } = await loadStore();

    expect(result.current.shapes).toEqual({});
    expect(result.current.renderSignature).toBe('default');
  });

  it('gives every role its own shape when the setting turns on, and a new render key', async () => {
    const { store, result } = await loadStore();

    act(() => store.setSystemPrefersRoleShapes(true));

    expect(result.current.shapes).toEqual({ STARTING: 'triangle-up', FINISH: 'square', FOOT: 'triangle-down' });
    expect(store.getEffectiveHoldStateShape('STARTING', result.current.shapes)).toBe('triangle-up');
    expect(store.getEffectiveHoldStateShape('HAND', result.current.shapes)).toBe('circle');
    // The render cache key changes, so no board art drawn with circles is reused.
    expect(result.current.renderSignature).toBe('starting-triangle-up.finish-square.foot-triangle-down');

    act(() => store.setSystemPrefersRoleShapes(false));
    expect(result.current.shapes).toEqual({});
    expect(result.current.renderSignature).toBe('default');
  });

  it("keeps the climber's own shape over the per-role default", async () => {
    const asyncStorage = await getAsyncStorage();
    await asyncStorage.setItem('holdColorOverrides', JSON.stringify({ shapes: { STARTING: 'octagon' } }));
    const { store, result } = await loadStore();

    act(() => store.setSystemPrefersRoleShapes(true));

    expect(result.current.shapes.STARTING).toBe('octagon');
    expect(result.current.shapes.FOOT).toBe('triangle-down');
  });

  it('stores an explicit circle picked while the setting is on, and it wins', async () => {
    const asyncStorage = await getAsyncStorage();
    const { store, result } = await loadStore();
    act(() => store.setSystemPrefersRoleShapes(true));

    await act(() => store.setHoldShapeOverridePreference('FOOT', 'circle'));

    expect(await asyncStorage.getItem('holdColorOverrides')).toBe(JSON.stringify({ shapes: { FOOT: 'circle' } }));
    expect(result.current.shapes.FOOT).toBeUndefined();
    expect(result.current.shapes.STARTING).toBe('triangle-up');
    // The Reset row offers to undo the climber's choice, not the OS's.
    expect(store.hasStoredHoldMarkerChoices(result.current.markerOverrides)).toBe(true);
  });

  it('does not freeze the system shape when only the colour changes', async () => {
    const asyncStorage = await getAsyncStorage();
    const { store, result } = await loadStore();
    act(() => store.setSystemPrefersRoleShapes(true));

    // An untouched shape picker does not pass a shape selection.
    await act(() => store.setHoldRoleMarkerOverridePreference('STARTING', '#123456'));

    expect(await asyncStorage.getItem('holdColorOverrides')).toBe(JSON.stringify({ colors: { STARTING: '#123456' } }));
    expect(result.current.markerOverrides.shapes).toEqual({});

    // So the role keeps following the setting.
    act(() => store.setSystemPrefersRoleShapes(false));
    expect(result.current.shapes.STARTING).toBeUndefined();
  });

  it('preserves an explicit circle chosen before the system setting turns on', async () => {
    const { store, result } = await loadStore();
    await act(() => store.setHoldShapeOverridePreference('STARTING', 'circle'));

    act(() => store.setSystemPrefersRoleShapes(true));
    expect(result.current.shapes.STARTING).toBeUndefined();
    expect(result.current.markerOverrides.shapes.STARTING).toBe('circle');
  });

  it('preserves an explicit system-matching shape after the setting turns off', async () => {
    const { store, result } = await loadStore();
    act(() => store.setSystemPrefersRoleShapes(true));
    await act(() => store.setHoldRoleMarkerOverridePreference('STARTING', null, 'triangle-up'));

    act(() => store.setSystemPrefersRoleShapes(false));
    expect(result.current.shapes.STARTING).toBe('triangle-up');
    expect(result.current.markerOverrides.shapes.STARTING).toBe('triangle-up');
  });

  it('does not count OS-supplied shapes as customised', async () => {
    const { store, result } = await loadStore();
    act(() => store.setSystemPrefersRoleShapes(true));

    expect(store.countHoldMarkerOverrides(result.current.markerOverrides)).toBe(0);
    expect(store.hasStoredHoldMarkerChoices(result.current.markerOverrides)).toBe(false);
  });

  it('never sends a shape to the board LEDs', async () => {
    const { store, result } = await loadStore();
    act(() => store.setSystemPrefersRoleShapes(true));

    expect(store.getBluetoothColorOverrides(result.current.markerOverrides)).toBeUndefined();
  });
});
