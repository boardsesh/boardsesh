import { View, StyleSheet } from 'react-native';
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
};

/** Overlapping avatars with a "+N" overflow tile (session participants). */
export function AvatarGroup({ participants, size = 32, max = 3 }: AvatarGroupProps) {
  const { systemColors } = useTheme();

  if (participants.length <= 1) {
    const only = participants[0];
    return <PressableAvatar userId={only?.userId} uri={only?.avatarUrl} name={only?.displayName} size={size} />;
  }

  const shown = participants.slice(0, max);
  const overflow = participants.length - shown.length;
  const overlap = Math.round(size * 0.35);

  return (
    <View style={styles.row}>
      {shown.map((participant, index) => (
        <View
          key={participant.userId ?? `anon-${index}`}
          style={[
            styles.ring,
            {
              borderColor: systemColors.secondaryBackground,
              marginLeft: index === 0 ? 0 : -overlap,
              borderRadius: size / 2,
            },
          ]}
        >
          <PressableAvatar
            userId={participant.userId}
            uri={participant.avatarUrl}
            name={participant.displayName}
            size={size}
          />
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
              marginLeft: -overlap,
              borderColor: systemColors.secondaryBackground,
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
  overflow: {
    backgroundColor: brandColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflowText: { fontWeight: '700' },
});
