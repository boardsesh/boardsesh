// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';

const native = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android', flag: undefined as boolean | string | undefined }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => (key === 'sheet-keyboard-calibration' ? native.flag : undefined),
}));

import { SheetKeyboardCalibrationPublisher } from '../SheetKeyboardCalibrationPublisher';
import {
  resetSheetKeyboardCalibrationForTests,
  useSheetKeyboardCalibrationEnabled,
  useSheetKeyboardCalibrationWindowTopInset,
} from '../../lib/sheet-keyboard-calibration-store';

function published() {
  const { result } = renderHook(() => ({
    enabled: useSheetKeyboardCalibrationEnabled(),
    windowTopInset: useSheetKeyboardCalibrationWindowTopInset(),
  }));
  return result.current;
}

describe('SheetKeyboardCalibrationPublisher', () => {
  beforeEach(() => {
    resetSheetKeyboardCalibrationForTests();
    native.os = 'ios';
    native.flag = undefined;
  });

  it('stays off when the flag has no value', () => {
    render(<SheetKeyboardCalibrationPublisher />);
    expect(published()).toEqual({ enabled: false, windowTopInset: 62 });
  });

  it('turns the readout on for iOS when the flag is exactly true', () => {
    native.flag = true;
    render(<SheetKeyboardCalibrationPublisher />);
    expect(published()).toEqual({ enabled: true, windowTopInset: 62 });
  });

  it('stays off on Android, which has no SwiftUI probe and no #5964 gap', () => {
    native.os = 'android';
    native.flag = true;
    render(<SheetKeyboardCalibrationPublisher />);
    expect(published().enabled).toBe(false);
  });
});
