import { useEffect, useRef, useState } from 'react';
import type { Coords } from './use-device-location';
import type { WallFinderFilter } from './wall-finder-filter';

export const DISCOVERY_SEARCH_DEBOUNCE_MS = 500;

export type DiscoverySearch = { center: Coords | null; filter: WallFinderFilter };

type SearchCallbacks = {
  resolveCameraCenter: (next: Coords, current: Coords | null) => Coords | null;
};

function sameCenter(first: Coords | null, second: Coords | null): boolean {
  return first?.latitude === second?.latitude && first?.longitude === second?.longitude;
}

function sameSearch(first: DiscoverySearch, second: DiscoverySearch): boolean {
  return sameCenter(first.center, second.center) && JSON.stringify(first.filter) === JSON.stringify(second.filter);
}

/** One trailing timer for camera movement AND filters, without per-frame React state. */
export function useDiscoverySearch(center: Coords | null, filter: WallFinderFilter, callbacks: SearchCallbacks) {
  const [search, setSearch] = useState<DiscoverySearch>(() => ({ center, filter }));
  const [isDebouncing, setIsDebouncing] = useState(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const [scheduler] = useState(() => {
    let desired: DiscoverySearch = { center, filter };
    let committed = desired;
    let cameraCenter: Coords | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let hasSearched = center !== null || !!filter.name?.trim();

    function setPending(next: boolean) {
      if (pending === next) return;
      pending = next;
      setIsDebouncing(next);
    }

    function cancelTimer() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }

    function commit() {
      cancelTimer();
      if (cameraCenter) {
        desired = { ...desired, center: callbacksRef.current.resolveCameraCenter(cameraCenter, desired.center) };
        cameraCenter = null;
      }
      if (!sameSearch(desired, committed)) {
        committed = desired;
        setSearch(desired);
      }
      hasSearched ||= desired.center !== null || !!desired.filter.name?.trim();
      setPending(false);
    }

    function schedule() {
      cancelTimer();
      if (!cameraCenter && sameSearch(desired, committed)) {
        setPending(false);
        return;
      }
      if (!hasSearched && (desired.center !== null || !!desired.filter.name?.trim())) {
        commit();
        return;
      }
      setPending(true);
      timer = setTimeout(commit, DISCOVERY_SEARCH_DEBOUNCE_MS);
    }

    return {
      updateInputs(this: void, next: DiscoverySearch, centerChanged: boolean) {
        const updated = { center: centerChanged ? next.center : desired.center, filter: next.filter };
        if (centerChanged) cameraCenter = null;
        if (sameSearch(updated, desired) && !centerChanged) return;
        desired = updated;
        schedule();
      },
      cameraMoved(this: void, next: Coords) {
        cameraCenter = next;
        schedule();
      },
      reset(this: void, next: DiscoverySearch) {
        cameraCenter = null;
        desired = next;
        schedule();
      },
      dispose: cancelTimer,
    };
  });

  const previousCenterRef = useRef(center);
  useEffect(() => {
    const centerChanged = !sameCenter(center, previousCenterRef.current);
    previousCenterRef.current = center;
    scheduler.updateInputs({ center, filter }, centerChanged);
  }, [center, filter, scheduler]);

  useEffect(() => () => scheduler.dispose(), [scheduler]);

  return { search, isDebouncing, cameraMoved: scheduler.cameraMoved, resetSearch: scheduler.reset };
}
