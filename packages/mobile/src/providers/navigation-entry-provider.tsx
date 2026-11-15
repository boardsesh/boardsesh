import { createContext, useContext, type ReactNode } from 'react';
import type { Href } from 'expo-router';

const NavigationEntryContext = createContext<Href | undefined>(undefined);

/** A root navigator can choose its own launcher destination. */
export function NavigationEntryProvider({ href, children }: { href: Href; children: ReactNode }) {
  return <NavigationEntryContext value={href}>{children}</NavigationEntryContext>;
}

export function useNavigationEntryOverride(): Href | undefined {
  return useContext(NavigationEntryContext);
}
