import { beforeEach, describe, expect, it, vi } from 'vitest';

type AsyncStorageStub = {
  clear: () => Promise<void>;
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

async function getAsyncStorage(): Promise<AsyncStorageStub> {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as AsyncStorageStub;
}

describe('hold-color-overrides', () => {
  beforeEach(async () => {
    vi.resetModules();
    await (await getAsyncStorage()).clear();
  });

  it('normalizes and sanitizes role colour overrides', async () => {
    const { sanitizeHoldColorOverrides, sanitizeHoldMarkerOverrides } = await import('../hold-color-overrides');

    expect(
      sanitizeHoldColorOverrides({
        STARTING: 'ABCDEF',
        HAND: '#123456',
        FINISH: '#bad',
        ANY: '#ffffff',
        FOOT: 42,
      }),
    ).toEqual({ STARTING: '#abcdef', HAND: '#123456' });

    expect(
      sanitizeHoldMarkerOverrides({
        colors: { HAND: '#123456', FOOT: 'abcdef', ANY: '#ffffff' },
        shapes: { HAND: 'triangle-up', FOOT: 'circle', FINISH: 'hexagon' },
        brushThickness: 1.56,
        shapeSize: 0.44,
      }),
    ).toEqual({
      colors: { HAND: '#123456', FOOT: '#abcdef' },
      shapes: { HAND: 'triangle-up' },
      brushThickness: 1.6,
      shapeSize: 0.5,
    });
  });

  it('builds a stable default-or-custom signature', async () => {
    const { DEFAULT_HOLD_COLOR_SIGNATURE, buildHoldColorOverrideSignature, buildHoldRenderOverrideSignature } =
      await import('../hold-color-overrides');

    expect(buildHoldColorOverrideSignature({})).toBe(DEFAULT_HOLD_COLOR_SIGNATURE);
    expect(buildHoldColorOverrideSignature({ HAND: '#123456', STARTING: '#abcdef' })).toBe(
      'starting-abcdef.hand-123456',
    );
    expect(buildHoldRenderOverrideSignature({ colors: {}, shapes: {}, brushThickness: 1, shapeSize: 1 })).toBe(
      DEFAULT_HOLD_COLOR_SIGNATURE,
    );
    expect(
      buildHoldRenderOverrideSignature({
        colors: { HAND: '#123456' },
        shapes: {},
        brushThickness: 1,
        shapeSize: 1,
      }),
    ).toBe('hand-123456');
    expect(
      buildHoldRenderOverrideSignature({
        colors: { HAND: '#123456' },
        shapes: { FOOT: 'diamond' },
        brushThickness: 1.5,
        shapeSize: 1.8,
      }),
    ).toBe('colors-hand-123456.foot-diamond.brush-1.5.size-1.8');
  });

  it('persists configured overrides and removes the preference when reset', async () => {
    const asyncStorage = await getAsyncStorage();
    const { setHoldColorOverridesPreference, setHoldMarkerOverridesPreference, setHoldRoleMarkerOverridePreference } =
      await import('../hold-color-overrides');

    await setHoldColorOverridesPreference({ HAND: '#123456' });
    expect(await asyncStorage.getItem('holdColorOverrides')).toBe(JSON.stringify({ colors: { HAND: '#123456' } }));

    await setHoldRoleMarkerOverridePreference('HAND', '#abcdef', 'triangle-down');
    expect(await asyncStorage.getItem('holdColorOverrides')).toBe(
      JSON.stringify({ colors: { HAND: '#abcdef' }, shapes: { HAND: 'triangle-down' } }),
    );

    await setHoldMarkerOverridesPreference({
      colors: {},
      shapes: { FOOT: 'square' },
      brushThickness: 1.2,
      shapeSize: 1.7,
    });
    expect(await asyncStorage.getItem('holdColorOverrides')).toBe(
      JSON.stringify({ shapes: { FOOT: 'square' }, brushThickness: 1.2, shapeSize: 1.7 }),
    );

    await setHoldMarkerOverridesPreference({ colors: {}, shapes: {}, brushThickness: 1, shapeSize: 1 });
    expect(await asyncStorage.getItem('holdColorOverrides')).toBeNull();
  });

  it('loads sanitized stored overrides', async () => {
    const asyncStorage = await getAsyncStorage();
    await asyncStorage.setItem('holdColorOverrides', JSON.stringify({ FOOT: '#654321', ANY: '#ffffff' }));
    const { loadHoldColorOverrides, loadHoldMarkerOverrides } = await import('../hold-color-overrides');

    expect(await loadHoldColorOverrides()).toEqual({ FOOT: '#654321' });
    expect(await loadHoldMarkerOverrides()).toEqual({
      colors: { FOOT: '#654321' },
      shapes: {},
      brushThickness: 1,
      shapeSize: 1,
    });
  });

  it('merges single-role edits with stored overrides before the first load completes', async () => {
    const asyncStorage = await getAsyncStorage();
    await asyncStorage.setItem('holdColorOverrides', JSON.stringify({ HAND: '#111111', FOOT: '#222222' }));
    const { setHoldColorOverridePreference } = await import('../hold-color-overrides');

    await setHoldColorOverridePreference('HAND', '#333333');

    expect(await asyncStorage.getItem('holdColorOverrides')).toBe(
      JSON.stringify({ colors: { HAND: '#333333', FOOT: '#222222' } }),
    );
  });

  it('exposes Bluetooth overrides only when at least one custom colour is configured', async () => {
    const { getBluetoothColorOverrides } = await import('../hold-color-overrides');

    expect(getBluetoothColorOverrides({})).toBeUndefined();
    expect(getBluetoothColorOverrides({ FINISH: '#abcdef' })).toEqual({ FINISH: '#abcdef' });
    expect(
      getBluetoothColorOverrides({ colors: {}, shapes: { HAND: 'diamond' }, brushThickness: 2, shapeSize: 2 }),
    ).toBeUndefined();
    expect(
      getBluetoothColorOverrides({
        colors: { FINISH: '#abcdef' },
        shapes: { HAND: 'diamond' },
        brushThickness: 2,
        shapeSize: 2,
      }),
    ).toEqual({ FINISH: '#abcdef' });
  });

  it('converts between hex colours and editable RGB channels', async () => {
    const { hexToRgb, parseRgbChannel, rgbToHex } = await import('../hold-color-overrides');

    expect(hexToRgb('#0a10ff')).toEqual({ red: 10, green: 16, blue: 255 });
    expect(rgbToHex({ red: 10, green: 16, blue: 255 })).toBe('#0a10ff');
    expect(parseRgbChannel('255')).toBe(255);
    expect(parseRgbChannel('256')).toBeNull();
    expect(parseRgbChannel('1.5')).toBeNull();
  });
});
