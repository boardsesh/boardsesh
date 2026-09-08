import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { MEMORY_PROFILING_ENABLED, memoryOwner, memoryProfile } from './memory-profile';

export function useMemoryListViewability() {
  const owner = useRef<string | null>(null);
  const focused = useRef(false);
  const lastVisible = useRef<string[]>([]);
  if (MEMORY_PROFILING_ENABLED && owner.current === null) owner.current = memoryOwner();
  useFocusEffect(
    useCallback(() => {
      if (!MEMORY_PROFILING_ENABLED || !owner.current) return;
      const identifier = owner.current;
      focused.current = true;
      memoryProfile.visible(identifier, 'list', lastVisible.current);
      return () => {
        focused.current = false;
        memoryProfile.visible(identifier, 'list', []);
      };
    }, []),
  );
  const observe = useCallback(
    ({ viewableItems }: { viewableItems: { item: { uuid: string }; isViewable: boolean }[] }) => {
      if (!MEMORY_PROFILING_ENABLED || !owner.current) return;
      const uuids = viewableItems.filter((token) => token.isViewable).map((token) => token.item.uuid);
      if (uuids.length > 100 || uuids.some((uuid) => uuid.length > 512)) {
        memoryProfile.invalidate('viewability-overflow');
        return;
      }
      lastVisible.current = uuids;
      if (focused.current) memoryProfile.visible(owner.current, 'list', uuids);
    },
    [],
  );
  return MEMORY_PROFILING_ENABLED ? observe : undefined;
}
