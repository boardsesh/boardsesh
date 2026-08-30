import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

// Admin-only screen — hardcoded English literals, the tester-screen convention.

/** A dead-end state for the editor routes, with a way back. */
export function OutlineEditorMessage({ message }: { message: string }) {
  const router = useRouter();
  const { systemColors } = useTheme();

  return (
    <View style={[styles.centered, { backgroundColor: systemColors.groupedBackground }]}>
      <Text variant="headline" style={styles.title}>
        {message}
      </Text>
      <Button
        // i18n-ignore-next-line — admin-only screen
        title="Back"
        variant="outlined"
        onPress={() => router.back()}
        style={styles.button}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
  },
  title: {
    textAlign: 'center',
  },
  button: {
    marginTop: spacing[4],
  },
});
