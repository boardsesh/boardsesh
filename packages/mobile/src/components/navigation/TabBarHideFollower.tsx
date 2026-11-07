import type { ReactNode } from 'react';

/**
 * Only the Android phone nav bar hides on scroll (`TabBarHideFollower.android.tsx`
 * moves chrome with it). iOS and the web keep their tree exactly as it was.
 */
export function TabBarHideFollower({ children }: { children: ReactNode; zIndex?: number }) {
  return children;
}
