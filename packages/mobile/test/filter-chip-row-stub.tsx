// Test stub for the platform-split FilterChipRow. Its iOS implementation renders
// native @expo/ui SwiftUI views that can't mount under Vitest's node env, and
// Vitest doesn't resolve `.ios`/`.android` platform extensions, so any suite that
// transitively imports the climbs screen redirects here via a vite alias.
// Component tests that assert chip behaviour register their own vi.mock, which
// takes precedence over this alias.

export function FilterChipRow(): null {
  return null;
}
