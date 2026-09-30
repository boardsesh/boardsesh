import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton } from './IconButton';
import { ChevronLeft, X } from './icons';
import { Text } from './Text';
import { spacing } from './tokens';

type TopBarProps = {
  /** A mono label in the middle: `03 / 50 · MOONBOARD 2019`. */
  label?: string;
  /** Actions on the right, laid out in a row. */
  right?: ReactNode;
  onBack?: () => void;
};

const BUTTON = 48;

/** The bar on pushed screens: back, a mono label, a few actions. */
export function TopBar({ label, right, onBack }: TopBarProps) {
  const insets = useSafeAreaInsets();
  // The label is centred on the whole bar, like an iOS title, clear of the wider side.
  const [sideWidth, setSideWidth] = useState(BUTTON);
  const inset = spacing.sm + sideWidth + spacing.xs;
  return (
    <View style={[styles.bar, { paddingTop: insets.top, height: insets.top + 52 }]}>
      <IconButton icon={ChevronLeft} label="Back" size="lg" onPress={onBack ?? (() => router.back())} />
      <View pointerEvents="none" style={[styles.labelBox, { top: insets.top, left: inset, right: inset }]}>
        <Text variant="label" align="center" numberOfLines={1}>
          {label ?? ''}
        </Text>
      </View>
      <View
        style={styles.right}
        onLayout={(event) => setSideWidth(Math.max(BUTTON, Math.round(event.nativeEvent.layout.width)))}
      >
        {right}
      </View>
    </View>
  );
}

type SheetHeaderProps = {
  title: string;
  /** Replaces the close button, e.g. a Back button inside a wizard. */
  left?: ReactNode;
  onClose?: () => void;
};

/** A sheet's title with a close button. */
export function SheetHeader({ title, left, onClose }: SheetHeaderProps) {
  return (
    <View style={styles.sheetHeader}>
      {left}
      <Text variant="title2" accessibilityRole="header" numberOfLines={1} style={styles.sheetTitle}>
        {title}
      </Text>
      <IconButton icon={X} label="Close" onPress={onClose ?? (() => router.back())} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.sm },
  labelBox: { position: 'absolute', height: 52, justifyContent: 'center' },
  right: { minWidth: BUTTON, flexDirection: 'row', justifyContent: 'flex-end' },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
    paddingLeft: spacing.xl,
    paddingRight: spacing.md,
  },
  sheetTitle: { flex: 1 },
});
