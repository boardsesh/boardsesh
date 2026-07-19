/**
 * Browsers do not expose the OS reduce-transparency preference through
 * React Native Web. Keep web surfaces opaque instead of calling the missing
 * AccessibilityInfo API or guessing at an accessibility setting.
 */
export function useReduceTransparency(): boolean {
  return true;
}
