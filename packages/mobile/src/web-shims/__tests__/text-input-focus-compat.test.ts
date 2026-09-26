import { describe, expect, it, vi } from 'vitest';
import { installWebTextInputFocusCompat } from '../text-input-focus-compat';

describe('Expo web text input focus compatibility', () => {
  it('returns the focused web input through the React Native API', () => {
    const input = { blur: vi.fn(), focus: vi.fn() };
    const state: Parameters<typeof installWebTextInputFocusCompat>[0] = {
      currentlyFocusedField: vi.fn(() => input),
    };

    installWebTextInputFocusCompat(state);
    expect(state.currentlyFocusedInput?.()).toBe(input);
    expect(state.currentlyFocusedField).toHaveBeenCalledOnce();
  });

  it('preserves an existing implementation', () => {
    const existingInput = { blur: vi.fn() };
    const currentlyFocusedInput = vi.fn(() => existingInput);
    const state = {
      currentlyFocusedField: vi.fn(() => null),
      currentlyFocusedInput,
    };

    installWebTextInputFocusCompat(state);
    expect(state.currentlyFocusedInput).toBe(currentlyFocusedInput);
    expect(state.currentlyFocusedInput()).toBe(existingInput);
    expect(state.currentlyFocusedField).not.toHaveBeenCalled();
  });
});
