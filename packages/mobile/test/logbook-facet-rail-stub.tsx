// Test stub for LogbookFacetRail, the Logbook capsule row's inline Grade / Angle
// rail. It pulls in Reanimated through the range rails, which doesn't mount
// under Vitest's react-native mock, so any suite that transitively imports the
// Logbook tab redirects here via a vite alias. Suites that assert the rail
// register their own vi.mock, which takes precedence.

export function LogbookFacetRail(): null {
  return null;
}
