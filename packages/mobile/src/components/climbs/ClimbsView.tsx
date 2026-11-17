import { memo, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  StyleSheet,
  View,
  type ColorValue,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import type { Climb } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { ContentRenderMarker } from '../ContentRenderObserver';
import { ClimbListThumbnailSizeContext, type ClimbListThumbnailSize } from '../climb-list-thumbnail-metrics';

export type ClimbsViewProps = {
  listProps: FlashListProps<Climb>;
  listRef?: Ref<FlashListRef<Climb>>;
  thumbnailSize: ClimbListThumbnailSize;
  clipStyle?: StyleProp<ViewStyle>;
  onClipLayout?: (event: LayoutChangeEvent) => void;
  placeholder?: boolean;
  /** Native headers and filter controls share this slot in production and stories. */
  chrome?: ReactNode;
  overlays?: ReactNode;
  /** Controller-owned scroll reset and optional render prewarming. */
  listReset?: ReactNode;
  listEffects?: ReactNode;
};

/**
 * The Climbs screen's virtualized presentation. Its caller supplies rows, states,
 * actions and chrome; rendering this view never starts a search or changes a board.
 */
export function ClimbsView({
  listProps,
  listRef,
  thumbnailSize,
  clipStyle,
  onClipLayout,
  placeholder = false,
  chrome,
  overlays,
  listReset,
  listEffects,
}: ClimbsViewProps) {
  const { systemColors } = useTheme();
  return (
    <View testID="climbs-screen" style={[styles.container, { backgroundColor: systemColors.background }]}>
      <ContentRenderMarker route="/climbs" count={listProps.data?.length ?? 0} />
      <View style={[styles.listClip, clipStyle]} onLayout={onClipLayout}>
        {listReset}
        <ClimbListThumbnailSizeContext.Provider value={thumbnailSize}>
          {/* FlashList must remount when changing between its grid and linear layouts. */}
          <FlashList
            key={`climb-list-${listProps.numColumns ?? 1}-columns`}
            ref={listRef}
            testID="climb-list"
            {...listProps}
          />
          {listEffects}
        </ClimbListThumbnailSizeContext.Provider>
      </View>
      <PlaceholderTint active={placeholder} color={systemColors.background} />
      {chrome}
      {overlays}
    </View>
  );
}

const PLACEHOLDER_TINT_DELAY_MS = 500;

// Delay the stale-result tint without re-rendering the list. A group opacity on
// the scrolling wrapper would force offscreen compositing on every frame.
const PlaceholderTint = memo(function PlaceholderTint({ active, color }: { active: boolean; color: ColorValue }) {
  const [isDelayElapsed, setIsDelayElapsed] = useState(false);
  const isDelayElapsedRef = useRef(isDelayElapsed);
  isDelayElapsedRef.current = isDelayElapsed;
  useEffect(() => {
    if (!active) {
      if (isDelayElapsedRef.current) setIsDelayElapsed(false);
      return;
    }
    const handle = setTimeout(() => setIsDelayElapsed(true), PLACEHOLDER_TINT_DELAY_MS);
    return () => clearTimeout(handle);
  }, [active]);
  if (!active || !isDelayElapsed) return null;
  return (
    <View
      testID="climb-list-placeholder-tint"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.placeholderTint, { backgroundColor: color }]}
    />
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  listClip: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  placeholderTint: { opacity: 0.4 },
});
