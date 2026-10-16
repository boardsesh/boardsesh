import { useCallback, useRef, useState, type RefObject } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type ListScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;
type ScrollableList = { scrollToOffset: (options: { offset: number; animated?: boolean }) => void };
type ScrollPosition = { list: ScrollableList; offset: number };
const TOP_SLACK = 2;

/** Reserve measured controls without displacing the rows a climber is reading. */
export function useListChromeClearance({
  initialHeight,
  topOffset,
  listRef,
  onScroll,
}: {
  initialHeight: number;
  topOffset: number;
  listRef: RefObject<ScrollableList | null>;
  onScroll?: (event: ListScrollEvent) => void;
}) {
  const [chromeHeight, setChromeHeight] = useState(initialHeight);
  const measuredHeightRef = useRef<number | null>(null);
  const lastScrollRef = useRef<ScrollPosition | null>(null);
  const pendingScrollRef = useRef<ScrollPosition | null>(null);
  const topOffsetRef = useRef(topOffset);
  topOffsetRef.current = topOffset;
  const forwardedScrollRef = useRef(onScroll);
  forwardedScrollRef.current = onScroll;

  const handleScroll = useCallback(
    (event: ListScrollEvent) => {
      const list = listRef.current;
      if (list) {
        const offset = event.nativeEvent.contentOffset.y;
        const previous = lastScrollRef.current;
        const pending = pendingScrollRef.current;
        if (pending?.list === list && previous?.list === list) {
          if (offset <= topOffsetRef.current + TOP_SLACK) pendingScrollRef.current = null;
          else pending.offset += offset - previous.offset;
        }
        lastScrollRef.current = { list, offset };
      }
      forwardedScrollRef.current?.(event);
    },
    [listRef],
  );

  const handleHeightChange = useCallback(
    (height: number) => {
      const previousHeight = measuredHeightRef.current;
      if (height === previousHeight) return;
      measuredHeightRef.current = height;
      const previousScroll = lastScrollRef.current;
      const list = listRef.current;
      if (
        previousHeight !== null &&
        list !== null &&
        previousScroll?.list === list &&
        previousScroll.offset > topOffsetRef.current + TOP_SLACK
      ) {
        const pending = pendingScrollRef.current;
        const offset = pending?.list === list ? pending.offset : previousScroll.offset;
        pendingScrollRef.current = {
          list,
          offset: offset + height - previousHeight,
        };
      } else {
        // At rest, the first result moves below the disclosed controls. Mount
        // measurements and a pull-to-refresh must not initiate a scroll.
        pendingScrollRef.current = null;
      }
      setChromeHeight(height);
    },
    [listRef],
  );

  const handleCommitLayout = useCallback(() => {
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (!pending || pending.list !== listRef.current) return;
    const offset = Math.max(topOffsetRef.current, pending.offset);
    lastScrollRef.current = { list: pending.list, offset };
    pending.list.scrollToOffset({ offset, animated: false });
  }, [listRef]);

  const resetScrollToTop = useCallback(() => {
    pendingScrollRef.current = null;
    const list = listRef.current;
    const offset = topOffsetRef.current;
    lastScrollRef.current = list ? { list, offset } : null;
    list?.scrollToOffset({ offset, animated: false });
  }, [listRef]);

  return {
    chromeHeight,
    onChromeHeightChange: handleHeightChange,
    onScroll: handleScroll,
    onCommitLayoutEffect: handleCommitLayout,
    resetScrollToTop,
  };
}
