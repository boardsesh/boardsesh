import { useEffect, useRef } from 'react';
import { MEMORY_PROFILING_ENABLED, memoryOwner, memoryProfile } from './memory-profile';
import type { MemorySurface } from './memory-collector';

/** UUID is a dependency: FlashList recycling is not a mount boundary. */
export function useMemoryClimbObservation(uuid: string | undefined, surface: MemorySurface, visible = false): void {
  const owner = useRef<string | null>(null);
  if (MEMORY_PROFILING_ENABLED && owner.current === null) owner.current = memoryOwner();
  useEffect(() => {
    if (!MEMORY_PROFILING_ENABLED || !owner.current || !uuid) return;
    const identifier = owner.current;
    memoryProfile.incidental(identifier, uuid);
    if (visible) memoryProfile.visible(identifier, surface, [uuid]);
    return () => {
      memoryProfile.visible(identifier, surface, []);
      memoryProfile.incidental(identifier, null);
    };
  }, [uuid, surface, visible]);
}
