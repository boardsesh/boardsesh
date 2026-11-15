import type { FlashListRef } from '@shopify/flash-list';
import { useCallback, useRef } from 'react';
/** Observe the assets in the first painted viewport; offscreen virtual rows never block capture. */
export function useVisibleArtReadiness<T>(assetId: (item: T) => string | null, onReady: () => void) {
  const expected = useRef<Set<string> | null>(null);
  const displayed = useRef(new Set<string>());
  const report = useCallback(() => {
    const pending = expected.current;
    if (pending && [...pending].every((id) => displayed.current.has(id))) onReady();
  }, [onReady]);
  const onDisplayed = useCallback(
    (id: string) => {
      displayed.current.add(id);
      report();
    },
    [report],
  );
  const onInitialViewport = useCallback(
    (items: readonly T[]) => {
      expected.current = new Set(
        items.flatMap((item) => {
          const id = assetId(item);
          return id ? [id] : [];
        }),
      );
      report();
    },
    [assetId, report],
  );
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: readonly { item: T }[] }) => {
      if (!viewableItems.length) return;
      expected.current = new Set(
        viewableItems.flatMap(({ item }) => {
          const id = assetId(item);
          return id ? [id] : [];
        }),
      );
      report();
    },
    [assetId, report],
  );
  return { onDisplayed, onViewableItemsChanged, onInitialViewport };
}

/** Called after FlashList's first paint, when row and header geometry is measured. */
export function readFlashListViewport<T>(list: FlashListRef<T>, items: readonly T[]): T[] {
  const { startIndex, endIndex } = list.computeVisibleIndices();
  const offset = list.getAbsoluteLastScrollOffset() - list.getFirstItemOffset();
  const height = list.getWindowSize().height;
  const visible: T[] = [];
  for (let index = Math.max(0, startIndex); index <= endIndex && index < items.length; index += 1) {
    const layout = list.getLayout(index);
    if (layout && layout.y < offset + height && layout.y + layout.height > offset) visible.push(items[index]!);
  }
  return visible;
}
