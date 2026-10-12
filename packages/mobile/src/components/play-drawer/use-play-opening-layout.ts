import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { PlayDrawerSectionId } from '../../lib/play-drawer-sections-preference';
import { readOpeningLayout, rememberOpeningLayout } from './opening-layout-cache';

/** These measurements are needed before Core can construct its complete cache key. */
export function usePlayLayoutMeasurements() {
  const [sheetViewportHeight, setSheetViewportHeight] = useState(0);
  const [headerBottomY, setHeaderBottomY] = useState(0);
  const [sectionHeaderMeasurement, setSectionHeaderMeasurement] = useState<{
    sectionId: PlayDrawerSectionId | undefined;
    height: number;
  }>({ sectionId: undefined, height: 0 });
  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    setSheetViewportHeight((previous) => (Math.abs(previous - measured) > 2 ? Math.round(measured) : previous));
  }, []);
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    const measured = Math.round(y + height);
    setHeaderBottomY((previous) => (Math.abs(previous - measured) > 2 ? measured : previous));
  }, []);
  return {
    sheetViewportHeight,
    headerBottomY,
    sectionHeaderMeasurement,
    setSectionHeaderMeasurement,
    handleViewportLayout,
    handleHeaderLayout,
  };
}

type PlayOpeningLayoutInputs = {
  openingLayoutKey: string | undefined;
  windowWidth: number;
  windowHeight: number;
  sheetViewportHeight: number;
  headerBottomY: number;
  hasVisibleSections: boolean;
  firstSectionHeaderHeight: number;
  handleViewportLayout: (event: LayoutChangeEvent) => void;
  handleHeaderLayout: (event: LayoutChangeEvent) => void;
  handleFirstSectionHeaderLayout: (height: number) => void;
};

/** Synchronous cached geometry; only complete, current-key measurements are written. */
export function usePlayOpeningLayout({
  openingLayoutKey,
  windowWidth,
  windowHeight,
  sheetViewportHeight,
  headerBottomY,
  hasVisibleSections,
  firstSectionHeaderHeight,
  handleViewportLayout,
  handleHeaderLayout,
  handleFirstSectionHeaderLayout,
}: PlayOpeningLayoutInputs) {
  const cachedOpeningLayout = readOpeningLayout(openingLayoutKey);
  const currentOpeningLayoutKey = useRef(openingLayoutKey);
  currentOpeningLayoutKey.current = openingLayoutKey;
  const [boardContainerMeasurement, setBoardContainerMeasurement] = useState<{
    layoutKey: string | undefined;
    viewportWidth: number;
    viewportHeight: number;
    width: number;
    height: number;
  } | null>(null);
  const handleBoardContainerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (currentOpeningLayoutKey.current !== openingLayoutKey) return;
      const { width, height } = event.nativeEvent.layout;
      if (width <= 0 || height <= 0) return;
      setBoardContainerMeasurement((previous) =>
        previous !== null &&
        previous.layoutKey === openingLayoutKey &&
        previous.viewportWidth === windowWidth &&
        previous.viewportHeight === windowHeight &&
        previous.width === width &&
        previous.height === height
          ? previous
          : {
              layoutKey: openingLayoutKey,
              viewportWidth: windowWidth,
              viewportHeight: windowHeight,
              width,
              height,
            },
      );
    },
    [openingLayoutKey, windowWidth, windowHeight],
  );
  const measuredForCurrentLayout = boardContainerMeasurement?.layoutKey === openingLayoutKey;
  const boardContainerSize =
    !measuredForCurrentLayout && cachedOpeningLayout
      ? cachedOpeningLayout.containerSize
      : boardContainerMeasurement?.viewportWidth === windowWidth &&
          boardContainerMeasurement.viewportHeight === windowHeight
        ? boardContainerMeasurement
        : cachedOpeningLayout?.containerSize;
  const layoutMeasurementKeys = useRef<{ viewport?: string; header?: string; section?: string }>({});
  const onViewportMeasured = useCallback(
    (event: LayoutChangeEvent) => {
      if (currentOpeningLayoutKey.current !== openingLayoutKey) return;
      layoutMeasurementKeys.current.viewport = openingLayoutKey;
      handleViewportLayout(event);
    },
    [openingLayoutKey, handleViewportLayout],
  );
  const onHeaderMeasured = useCallback(
    (event: LayoutChangeEvent) => {
      if (currentOpeningLayoutKey.current !== openingLayoutKey) return;
      layoutMeasurementKeys.current.header = openingLayoutKey;
      handleHeaderLayout(event);
    },
    [openingLayoutKey, handleHeaderLayout],
  );
  const onSectionHeaderMeasured = useCallback(
    (height: number) => {
      if (currentOpeningLayoutKey.current !== openingLayoutKey) return;
      layoutMeasurementKeys.current.section = openingLayoutKey;
      handleFirstSectionHeaderLayout(height);
    },
    [openingLayoutKey, handleFirstSectionHeaderLayout],
  );
  useEffect(() => {
    if (
      !openingLayoutKey ||
      !boardContainerSize ||
      boardContainerMeasurement?.layoutKey !== openingLayoutKey ||
      layoutMeasurementKeys.current.viewport !== openingLayoutKey ||
      layoutMeasurementKeys.current.header !== openingLayoutKey ||
      (hasVisibleSections && layoutMeasurementKeys.current.section !== openingLayoutKey)
    )
      return;
    rememberOpeningLayout(openingLayoutKey, {
      viewportHeight: sheetViewportHeight,
      headerBottomY,
      firstSectionHeaderHeight: hasVisibleSections ? firstSectionHeaderHeight : 0,
      containerSize: boardContainerSize,
    });
  }, [
    openingLayoutKey,
    sheetViewportHeight,
    headerBottomY,
    hasVisibleSections,
    firstSectionHeaderHeight,
    boardContainerSize,
    boardContainerMeasurement,
  ]);

  return {
    cachedOpeningLayout,
    boardContainerSize,
    handleBoardContainerLayout,
    onViewportMeasured,
    onHeaderMeasured,
    onSectionHeaderMeasured,
  };
}
