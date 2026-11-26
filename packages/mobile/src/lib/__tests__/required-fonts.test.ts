import { beforeEach, describe, expect, it, vi } from 'vitest';

const fontLoader = vi.hoisted(() => ({
  loadAsync: vi.fn().mockResolvedValue(undefined),
  setDynamicLoadingErrorCallback: vi.fn(),
}));
vi.mock('expo-font', () => ({ loadAsync: fontLoader.loadAsync }));
vi.mock('@react-native-vector-icons/common', () => ({
  setDynamicLoadingErrorCallback: fontLoader.setDynamicLoadingErrorCallback,
}));
vi.mock('@react-native-vector-icons/material-design-icons/fonts/MaterialDesignIcons.ttf', () => ({ default: 7 }));

import { loadRequiredFonts } from '../required-fonts';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadRequiredFonts', () => {
  it('preloads the scoped pack under its exact font family before first paint', async () => {
    await loadRequiredFonts();
    expect(fontLoader.loadAsync).toHaveBeenCalledExactlyOnceWith({ MaterialDesignIcons: 7 });
  });

  it('propagates a failed preload to the existing launch error handler', async () => {
    const error = new Error('Font asset unavailable');
    fontLoader.loadAsync.mockRejectedValueOnce(error);
    await expect(loadRequiredFonts()).rejects.toBe(error);
  });

  it('reports the first mounting-time failure per family while later icons may retry', async () => {
    const reportFontError = vi.fn();
    await loadRequiredFonts(reportFontError);
    expect(fontLoader.setDynamicLoadingErrorCallback).toHaveBeenCalledTimes(1);
    const onError = fontLoader.setDynamicLoadingErrorCallback.mock.calls[0][0] as (context: {
      error: Error;
      fontFamily: string;
      fontSource: number;
    }) => void;
    const error = new Error('Native font registration failed');
    onError({ error, fontFamily: 'MaterialDesignIcons', fontSource: 7 });
    onError({ error: new Error('Same font still unavailable'), fontFamily: 'MaterialDesignIcons', fontSource: 7 });
    onError({ error, fontFamily: 'AnotherFont', fontSource: 8 });
    expect(reportFontError).toHaveBeenCalledTimes(2);
    expect(reportFontError).toHaveBeenNthCalledWith(1, error, 'MaterialDesignIcons');
    expect(reportFontError).toHaveBeenNthCalledWith(2, error, 'AnotherFont');
  });
});
