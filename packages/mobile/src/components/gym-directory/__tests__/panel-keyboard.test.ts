import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../../../hooks/use-keyboard-height', () => ({ useKeyboardHeight: () => 0 }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));

const { keyboardOverlap, panelBoxHeight } = await import('../panel-keyboard');

describe('keyboardOverlap', () => {
  it('is nothing while the keyboard is down, whatever the inset', () => {
    expect(keyboardOverlap({ keyboardHeight: 0, platform: 'android', windowBottomInset: 48 })).toBe(0);
  });

  it('is the keyboard height on iOS, which already counts the home indicator', () => {
    expect(keyboardOverlap({ keyboardHeight: 336, platform: 'ios', windowBottomInset: 34 })).toBe(336);
  });

  it('adds the navigation bar on Android, whose IME inset leaves it out', () => {
    expect(keyboardOverlap({ keyboardHeight: 300, platform: 'android', windowBottomInset: 48 })).toBe(348);
  });
});

describe('panelBoxHeight', () => {
  it('keeps the measured box while the keyboard is down', () => {
    expect(panelBoxHeight(690, 0)).toBe(690);
  });

  it('ends the box at the keyboard top', () => {
    expect(panelBoxHeight(690, 336)).toBe(354);
  });

  it('never goes below zero', () => {
    expect(panelBoxHeight(200, 336)).toBe(0);
  });
});
