import { useRouter, useSegments, type Href } from 'expo-router';
import { memo, useCallback } from 'react';
import { hapticSelection } from '../../lib/haptics';
import { tabsActiveSegment } from '../../lib/route-segments';
import { MaterialNavigationRailView } from './MaterialNavigationRailView';
import { SidebarWallCell } from './SidebarWallCell';
export const MaterialNavigationRail = memo(function MaterialNavigationRail({
  showWallCell = true,
}: {
  showWallCell?: boolean;
}) {
  const router = useRouter();
  const segments = useSegments();
  const onNavigate = useCallback(
    (segment: string) => {
      hapticSelection();
      router.navigate(('/' + segment) as Href);
    },
    [router],
  );
  return (
    <MaterialNavigationRailView
      activeSegment={tabsActiveSegment(segments) ?? 'home'}
      onNavigate={onNavigate}
      wallCell={showWallCell ? <SidebarWallCell /> : null}
    />
  );
});
