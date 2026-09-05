import { memo, useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { DraftStatusView } from './draft-status-view';

type CreateDraftStatusRowProps = {
  /** The line to show, or null when the editor is empty and has nothing to say. */
  status: DraftStatusView | null;
  /** The action bar's shared, rate-limited voice. See useRateLimitedAnnouncer. */
  announce: (text: string) => void;
};

/** caption1 line box, used as the row's floor when there is no text. */
export const RESERVED_LINE_HEIGHT = 16;

/**
 * The persistent one-line answer to "is my work safe?", sitting directly under
 * the Save row so the answer and the button that changes it are in one glance.
 *
 * Left-aligned on purpose: a caption right-aligned under the pill is under your
 * thumb at exactly the moment you want to read it, and the left rule is shared
 * with the brush chips and the description label.
 *
 * The row ALWAYS occupies its line box, even with nothing to say. It is not free
 * to collapse: the drawer sizes the board against the chrome and derives the peek
 * snap-point from the measured above-fold height, so a row that appeared when the
 * first hold landed changed `peekHeight` mid-session and re-snapped an expanded
 * sheet back down to peek — a one-shot jolt at exactly the moment someone starts
 * working. Reserving the height keeps the chrome constant, which also stops the
 * content below shifting as the line comes and goes.
 */
export const CreateDraftStatusRow = memo(function CreateDraftStatusRow({
  status,
  announce,
}: CreateDraftStatusRowProps) {
  const { systemColors, brandColors } = useTheme();

  const color =
    status?.tone === 'error'
      ? brandColors.error
      : status?.tone === 'warning'
        ? brandColors.warning
        : systemColors.secondaryLabel;

  // Speak only on a TRANSITION into an announce-worthy state, and never on first
  // paint (opening an already-saved draft should not narrate itself).
  const lastTextRef = useRef<string | null>(null);
  const statusText = status?.text ?? null;
  const shouldAnnounce = status?.announce ?? false;
  useEffect(() => {
    const previousText = lastTextRef.current;
    lastTextRef.current = statusText;
    if (statusText === null || !shouldAnnounce) {
      // An announce-worthy warning may be waiting at the rate limiter's trailing
      // edge. Moving to a quiet/empty state makes that warning stale.
      announce('');
      return;
    }
    if (previousText === null || previousText === statusText) return;
    announce(statusText);
  }, [statusText, shouldAnnounce, announce]);

  return (
    <View style={statusRowStyles.row} testID="create-draft-status-row">
      {statusText === null ? null : (
        <Text
          variant="caption1"
          color={color}
          numberOfLines={1}
          ellipsizeMode="tail"
          // Explicitly NOT a live region: the state behind this line flips on a
          // 500ms autosave debounce, so `polite` would re-announce on every
          // keystroke and every hold tap. The effect above narrates transitions.
          accessibilityLiveRegion="none"
        >
          {statusText}
        </Text>
      )}
    </View>
  );
});

export const statusRowStyles = StyleSheet.create({
  row: {
    // Left edge lines up with the brush chips and the "Description" label.
    paddingHorizontal: spacing[4],
    paddingTop: spacing[1],
    paddingBottom: spacing[3],
    // Floor, not a fixed height: larger Dynamic Type still grows the line.
    //
    // The padding is part of it. Yoga measures minHeight against the border
    // box, so a bare RESERVED_LINE_HEIGHT was already satisfied by the 16dp of
    // padding alone — the row stood 16dp empty and 32dp once it had something
    // to say. That 16dp step landed the moment the first hold was painted,
    // which moved the measured above-fold height and re-snapped the sheet: the
    // exact jolt the comment on this component promises it prevents.
    minHeight: RESERVED_LINE_HEIGHT + spacing[1] + spacing[3],
  },
});
