// expo-haptics points its `main` at TypeScript source (src/Haptics.ts), which
// throws `SyntaxError` under Vitest's node env (same class as expo-image /
// expo-file-system). Haptics are a no-op in tests, so this stub satisfies the
// `import * as Haptics from 'expo-haptics'` in src/lib/haptics. Suites that
// assert haptics behaviour mock `../lib/haptics` directly, which takes precedence.

export const ImpactFeedbackStyle = {
  Light: 'light',
  Medium: 'medium',
  Heavy: 'heavy',
  Soft: 'soft',
  Rigid: 'rigid',
} as const;

export const NotificationFeedbackType = {
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
} as const;

export async function selectionAsync(): Promise<void> {}
export async function impactAsync(): Promise<void> {}
export async function notificationAsync(): Promise<void> {}
