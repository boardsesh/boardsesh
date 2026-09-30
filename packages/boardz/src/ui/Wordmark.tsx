import { StyleSheet, View } from 'react-native';
import { FONT } from './fonts';
import { LedDot } from './LedDot';
import { Text } from './Text';
import { LED } from './theme';

/** "boardz" in Geist 600, followed by one lit blue LED. */
export function Wordmark({ size = 38 }: { size?: number }) {
  return (
    <View style={[styles.row, { gap: size * 0.12 }]} accessible accessibilityRole="header" accessibilityLabel="Boardz">
      <Text
        style={{ fontFamily: FONT.sansSemiBold, fontSize: size, lineHeight: size * 1.05, letterSpacing: -size * 0.06 }}
      >
        boardz
      </Text>
      <View style={{ marginBottom: size * 0.16 }}>
        <LedDot color={LED.blue} size={Math.round(size * 0.2)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end' },
});
