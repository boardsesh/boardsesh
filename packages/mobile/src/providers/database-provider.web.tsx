import type { ReactNode } from 'react';

// Offline SQLite support is deferred. Keeping this seam mounted preserves the
// provider tree without importing expo-sqlite into the browser graph.
export function DatabaseProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
