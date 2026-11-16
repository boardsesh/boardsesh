import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { spacing } from '../../theme/tokens';
import { RAIL_CARD_GAP } from '../board-look/board-look-card-metrics';
import { BoardDiscoveryCardPlaceholder } from './BoardDiscoveryCardView';
import { PickerTouchContext } from './picker-touch';

/** Enough placeholder cards to run past the edge of any phone, as the real rail does. */
const PLACEHOLDER_KEYS = ['first', 'second', 'third'] as const;

type NearbyReservedSlotProps = {
  /** The search is still out: draw placeholder cards instead of `children`. */
  searching: boolean;
  /** `children` is the quiet line, not cards: centred in the space the cards held. */
  quiet: boolean;
  children: ReactNode;
};

/**
 * Near you's content, which sits right above Your boards: the search answers a
 * second or three after the picker opens, which is when most Your boards picks
 * land, so whatever it answers must not move the rows under the climber's
 * thumb. While it searches, a row of placeholder cards as tall as the real
 * ones. Then:
 * - cards keep at least that height;
 * - a quiet line ("No other boards within 20 km", a failed search) gives the
 *   space back while the climber hasn't touched the picker (no finger is on its
 *   way to a row), and keeps it, the line centred, once they have
 *   (`PickerTouchContext`), decided when the answer lands;
 * - an answer with no placeholder before it (a cached one) holds nothing,
 *   since nothing was there to hold.
 */
export function NearbyReservedSlot({ searching, quiet, children }: NearbyReservedSlotProps) {
  const { t } = useTranslation('boards');
  const touched = useContext(PickerTouchContext);
  const [reservedHeight, setReservedHeight] = useState<number | null>(null);
  const [quietGivesSpaceBack, setQuietGivesSpaceBack] = useState(false);
  const onPlaceholderLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setReservedHeight((current) => (current === height ? current : height));
  }, []);
  // When the answer lands, before it paints: whether a quiet one gives the
  // space back. Outside a picker (no touch to read), it never does.
  const wasSearching = useRef(searching);
  useLayoutEffect(() => {
    if (wasSearching.current && !searching) setQuietGivesSpaceBack(touched !== null && !touched.current);
    wasSearching.current = searching;
  }, [searching, touched]);
  const holdStyle = useMemo(() => {
    if (reservedHeight === null || (quiet && quietGivesSpaceBack)) return undefined;
    return [{ minHeight: reservedHeight }, quiet ? styles.centred : null];
  }, [reservedHeight, quiet, quietGivesSpaceBack]);

  if (searching) {
    return (
      <View
        testID="near-you-placeholder"
        style={styles.placeholderRow}
        onLayout={onPlaceholderLayout}
        accessible
        accessibilityLabel={t('mobile.firstBoard.searching')}
        accessibilityLiveRegion="polite"
      >
        {PLACEHOLDER_KEYS.map((key) => (
          <BoardDiscoveryCardPlaceholder key={key} />
        ))}
      </View>
    );
  }
  return (
    <View testID="near-you-slot" style={holdStyle}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // The rail's own inset and gap (SnapCarousel's SNAP_CARD_GAP), so the cards land where the placeholders were.
  placeholderRow: {
    flexDirection: 'row',
    gap: RAIL_CARD_GAP,
    paddingHorizontal: spacing[4],
    overflow: 'hidden',
  },
  centred: {
    justifyContent: 'center',
  },
});
