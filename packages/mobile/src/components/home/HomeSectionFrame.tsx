import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SHELF_HEADER_CONTENT_GAP, ShelfHeader } from '../ShelfHeader';
import { spacing } from '../../theme/tokens';

/**
 * A Home card under its shelf header, spaced like the Climbing now rail so the
 * sections read as one column whatever order the climber picks.
 *
 * Not a `ShelfSection` yet: its 28pt between shelves would leave these sections
 * 8pt further apart than Climbing now and Fresh beta, which keep 20pt until they
 * move to the shelf header too.
 */
export function HomeSectionFrame({ title, testID, children }: { title: string; testID: string; children: ReactNode }) {
  return (
    <View style={styles.section} testID={testID}>
      <ShelfHeader title={title} />
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: spacing[5],
  },
  body: {
    paddingTop: SHELF_HEADER_CONTENT_GAP,
    paddingHorizontal: spacing[4],
  },
});
