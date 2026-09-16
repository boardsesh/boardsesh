import { View, StyleSheet, type ColorValue } from 'react-native';
import { Avatar } from '../Avatar';
import { PressableAvatar } from '../PressableAvatar';
import { Text } from '../Text';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { useTheme } from '../../providers/theme-provider';

// userId is the profile to open on tap; it's nullable because some rosters
// include unauthenticated connections (e.g. session presence), which have no
// linked profile. PressableAvatar degrades those to a plain, non-tappable avatar.
type Participant = { userId?: string | null; displayName?: string | null; avatarUrl?: string | null };

type AvatarGroupProps = {
  participants: Participant[];
  size?: number;
  max?: number;
  /**
   * The real roster size when `participants` is a capped sample (a live session
   * sends at most 5). "+N" counts against this, not the sample. Defaults to
   * `participants.length`.
   */
  total?: number;
  /**
   * False inside a card that is itself the press target: plain avatars, no
   * per-avatar navigation, no overlapping 44pt hit slops stealing the card tap.
   */
  interactive?: boolean;
  /** Ring colour between overlapping avatars. Defaults to the card surface. */
  ringColor?: ColorValue;
  /** One participant whose ring is drawn in `highlightColor` (a session host). */
  highlightUserId?: string | null;
  highlightColor?: ColorValue;
};

/** Overlapping avatars with a "+N" overflow tile (session participants). */
export function AvatarGroup({
  participants,
  size = 32,
  max = 3,
  total,
  interactive = true,
  ringColor,
  highlightUserId,
  highlightColor,
}: AvatarGroupProps) {
  const { systemColors } = useTheme();
  const separatorRing = ringColor ?? systemColors.secondaryBackground;

  const shown = participants.slice(0, max);
  const overflow = Math.max(0, (total ?? participants.length) - shown.length);

  const renderAvatar = (participant: Participant | undefined) =>
    interactive ? (
      <PressableAvatar
        userId={participant?.userId}
        uri={participant?.avatarUrl}
        name={participant?.displayName}
        size={size}
      />
    ) : (
      <Avatar uri={participant?.avatarUrl} name={participant?.displayName} size={size} />
    );

  const isHighlighted = (participant: Participant | undefined): boolean =>
    Boolean(highlightColor && highlightUserId && participant?.userId === highlightUserId);
  const ringFor = (participant: Participant | undefined): ColorValue =>
    isHighlighted(participant) && highlightColor ? highlightColor : separatorRing;

  if (participants.length <= 1 && overflow === 0) {
    const only = participants[0];
    if (!highlightColor || !highlightUserId || only?.userId !== highlightUserId) return renderAvatar(only);
    return (
      <View style={[styles.ring, { borderColor: ringFor(only), borderRadius: size / 2 }]}>{renderAvatar(only)}</View>
    );
  }

  const overlap = Math.round(size * 0.35);

  return (
    <View style={styles.row}>
      {shown.map((participant, index) => (
        <View
          key={participant.userId ?? `anon-${index}`}
          style={[
            styles.ring,
            // The highlight ring sits above its neighbours so the next avatar's
            // overlap can't cut through it.
            isHighlighted(participant) && styles.onTop,
            {
              borderColor: ringFor(participant),
              marginLeft: index === 0 ? 0 : -overlap,
              borderRadius: size / 2,
            },
          ]}
        >
          {renderAvatar(participant)}
        </View>
      ))}
      {overflow > 0 && (
        <View
          style={[
            styles.ring,
            styles.overflow,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              marginLeft: shown.length === 0 ? 0 : -overlap,
              borderColor: separatorRing,
            },
          ]}
        >
          <Text variant="caption2" color={iosSystemColors.white} style={styles.overflowText}>
            {`+${overflow}`}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  ring: { borderWidth: 2 },
  onTop: { zIndex: 1 },
  overflow: {
    backgroundColor: brandColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflowText: { fontWeight: '700' },
});
