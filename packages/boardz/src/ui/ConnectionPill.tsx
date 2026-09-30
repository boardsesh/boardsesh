import { Pressable, StyleSheet, View } from 'react-native';
import { LedDot } from './LedDot';
import { Text } from './Text';
import { LED, useTheme } from './theme';
import { radius } from './tokens';

export type ConnectionState = 'disconnected' | 'scanning' | 'connected' | 'error';

const STATES: Record<ConnectionState, { text: string; led: string | null }> = {
  disconnected: { text: 'No board', led: null },
  scanning: { text: 'Scanning', led: LED.blue },
  connected: { text: 'Connected', led: LED.green },
  error: { text: 'Lost the board', led: LED.red },
};

type ConnectionPillProps = {
  state: ConnectionState;
  /** Shown instead of "Connected" when there's room. */
  boardName?: string | null;
  onPress: () => void;
};

/** The board's link, as a status light in a hairline pill. The only pill in Graphite. */
export function ConnectionPill({ state, boardName, onPress }: ConnectionPillProps) {
  const theme = useTheme();
  const { text, led } = STATES[state];
  const shown = state === 'connected' && boardName ? boardName : text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text}${boardName ? `, ${boardName}` : ''}`}
      accessibilityHint="Opens the board connection"
      onPress={onPress}
      style={styles.touch}
    >
      {({ pressed }) => (
        <View style={[styles.pill, { borderColor: pressed ? theme.borderStrong : theme.border2 }]}>
          {led ? (
            <LedDot color={led} pulse={state === 'scanning'} />
          ) : (
            <View style={[styles.off, { backgroundColor: theme.fg4 }]} />
          )}
          <Text variant="label" tone="secondary" numberOfLines={1}>
            {shown}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  touch: { height: 44, justifyContent: 'center', flexShrink: 1 },
  pill: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 10,
    paddingRight: 12,
    borderWidth: 1,
    borderRadius: radius.pill,
  },
  off: { width: 6, height: 6, borderRadius: 3 },
});
