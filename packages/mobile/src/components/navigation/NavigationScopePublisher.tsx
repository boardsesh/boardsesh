import { useLayoutEffect } from 'react';
import { useSegments } from 'expo-router';
import { publishNavigationScope } from '../../lib/routing/scoped-navigation';

export function NavigationScopePublisher() {
  const segments = useSegments();
  useLayoutEffect(() => publishNavigationScope(segments), [segments]);
  return null;
}
