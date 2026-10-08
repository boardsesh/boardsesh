import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Keyboard: { addListener: () => ({ remove: () => {} }) },
  LayoutAnimation: { configureNext: () => {} },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

import { sheetKeyboardInset } from '../sheet-keyboard-inset';

// The sheet's bottom edge is the window's, so the keyboard's reach into the
// sheet is the whole keyboard (iOS) or the keyboard plus the nav bar it is
// reported without (Android). The footer's resting inset is REPLACED while the
// keyboard is up, never added, so the bar rests one gap above the keyboard.
describe('sheetKeyboardInset', () => {
  it('owes only the window inset while the keyboard is down, on every platform', () => {
    for (const platform of ['ios', 'android', 'web'] as const) {
      expect(sheetKeyboardInset(platform, 0, 34)).toEqual({ keyboardOverlap: 0, bottomInset: 34 });
    }
  });

  it('pads by the keyboard height on iOS, whose keyboard already covers the home indicator', () => {
    expect(sheetKeyboardInset('ios', 336, 34)).toEqual({ keyboardOverlap: 336, bottomInset: 0 });
  });

  it('pads by keyboard + inset on Android, whose IME height leaves out the nav bar', () => {
    expect(sheetKeyboardInset('android', 280, 48)).toEqual({ keyboardOverlap: 328, bottomInset: 0 });
  });

  it('adds nothing on a phone with no bottom inset beyond the keyboard itself', () => {
    expect(sheetKeyboardInset('ios', 291, 0)).toEqual({ keyboardOverlap: 291, bottomInset: 0 });
    expect(sheetKeyboardInset('android', 280, 0)).toEqual({ keyboardOverlap: 280, bottomInset: 0 });
  });

  it('leaves web to the Gorhom shim, which handles the keyboard itself', () => {
    expect(sheetKeyboardInset('web', 300, 34)).toEqual({ keyboardOverlap: 0, bottomInset: 34 });
  });
});
