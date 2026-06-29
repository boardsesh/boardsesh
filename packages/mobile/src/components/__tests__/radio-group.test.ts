import { describe, it, expect, vi } from 'vitest';

// Mock the haptics module so importing RadioGroup.logic never pulls in react-native
// (its only transitive dependency) under the node test env, and so we can assert
// the haptic fires — including via makeRadioSelectHandler's default.
const hapticSelectionMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));

import { makeRadioSelectHandler } from '../RadioGroup.logic';
import type { RadioOption } from '../RadioGroup.types';

// The RadioGroup render path is native @expo/ui (SwiftUI inline Picker / Compose
// RadioButton group) and is exercised in screen tests via the passthrough stub
// (test/radio-group-stub.tsx, wired through the vite alias). The selection behaviour
// both platforms share lives in makeRadioSelectHandler, which is what we unit-test.
const option = (over: Partial<RadioOption<'a' | 'b'>> = {}): RadioOption<'a' | 'b'> => ({
  value: 'a',
  label: 'A',
  ...over,
});

describe('makeRadioSelectHandler', () => {
  it('fires the haptic then onChange with the chosen value', () => {
    const haptic = vi.fn();
    const onChange = vi.fn();

    makeRadioSelectHandler(onChange, haptic)(option({ value: 'b', label: 'B' }));

    expect(haptic).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('selects an enabled option', () => {
    const haptic = vi.fn();
    const onChange = vi.fn();

    makeRadioSelectHandler(onChange, haptic)(option({ value: 'a', disabled: false }));

    expect(haptic).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('is a no-op for a disabled option — no haptic, no callback', () => {
    const haptic = vi.fn();
    const onChange = vi.fn();

    makeRadioSelectHandler(onChange, haptic)(option({ value: 'b', disabled: true }));

    expect(haptic).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('defaults the haptic to hapticSelection', () => {
    hapticSelectionMock.mockClear();
    const onChange = vi.fn();

    makeRadioSelectHandler(onChange)(option({ value: 'a' }));

    expect(hapticSelectionMock).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('a');
  });
});
