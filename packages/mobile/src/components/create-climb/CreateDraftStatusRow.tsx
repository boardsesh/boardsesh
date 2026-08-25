import { memo, useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { DraftStatusView } from './draft-status-view';

type CreateDraftStatusRowProps = {
  status: DraftStatusView;
  /** The action bar's shared, rate-limited voice. See useRateLimitedAnnouncer. */
  announce: (text: string) => void;
};

/**
 * The persistent one-line answer to "is my work safe?", sitting directly under
 * the Save row so the answer and the button that changes it are in one glance.
 *
 * Left-aligned on purpose: a caption right-aligned under the pill is under your
 * thumb at exactly the moment you want to read it, and the left rule is shared
 * with the brush chips and the description label.
 */
export const CreateDraftStatusRow = memo(function CreateDraftStatusRow({
  status,
  announce,
}: CreateDraftStatusRowProps) {
  const { systemColors, brandColors } = useTheme();

  const color =
    status.tone === 'error'
      ? brandColors.error
      : status.tone === 'warning'
        ? brandColors.warning
        : systemColors.secondaryLabel;

  // Speak only on a TRANSITION into an announce-worthy state, and never on first
  // paint (opening an already-saved draft should not narrate itself).
  const lastTextRef = useRef<string | null>(null);
  useEffect(() => {
    const previousText = lastTextRef.current;
    lastTextRef.current = status.text;
    if (previousText === null || previousText === status.text) return;
    if (!status.announce) return;
    announce(status.text);
  }, [status.text, status.announce, announce]);

  return (
    <View style={styles.row}>
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
        {status.text}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    // Left edge lines up with the brush chips and the "Description" label.
    paddingHorizontal: spacing[4],
    paddingTop: spacing[1],
    paddingBottom: spacing[3],
  },
});
