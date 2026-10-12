// Test stub for the platform-split CapsuleRow. Its iOS and Android
// implementations render native @expo/ui trees (SwiftUI / Jetpack Compose) that
// can't mount under Vitest's node env, and Vitest doesn't resolve
// `.ios`/`.android` platform extensions, so any suite that transitively imports
// a capsule row redirects here via a vite alias. Tests that assert the
// descriptors test the surface's builder; tests of the row itself import a
// platform file explicitly.

export function CapsuleRow(): null {
  return null;
}
