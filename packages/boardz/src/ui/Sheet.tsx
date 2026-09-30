import type { ReactNode } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';
import { spacing } from './tokens';
import { SheetHeader } from './TopBar';

type SheetProps = {
  title: string;
  /** Replaces nothing on the left by default; e.g. a Back button in a wizard. */
  left?: ReactNode;
  /** Pinned under the content: the sheet's buttons. */
  footer?: ReactNode;
  /** Space between the blocks of content. */
  gap?: number;
  /** For sheets with text fields. */
  avoidKeyboard?: boolean;
  children: ReactNode;
};

/**
 * A sheet's page: a pinned title bar, the content scrolling under it, and an
 * optional pinned footer.
 *
 * On iOS 26, react-native-screens resizes a form sheet's scroll view by hand
 * when it finds one among the sheet's top-level views or down its first
 * children, as if nothing else were there. That drew the title bar over the
 * first fields, or squashed the content to nothing. `collapsable={false}` stops
 * Fabric from hoisting these views to the top level, and the title bar comes
 * first, so it finds no scroll view and plain flex layout sizes everything.
 */
export function Sheet({ title, left, footer, gap = spacing.lg, avoidKeyboard = false, children }: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const content = (
    <>
      <SheetHeader title={title} left={left} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.body, { gap }]}>{children}</View>
      </ScrollView>
      {footer ? (
        <View style={[styles.footer, { borderTopColor: theme.border2, paddingBottom: spacing.md + insets.bottom }]}>
          {footer}
        </View>
      ) : null}
    </>
  );
  const rootStyle = [styles.flex, { backgroundColor: theme.bgApp }];
  return avoidKeyboard ? (
    <KeyboardAvoidingView behavior="padding" collapsable={false} style={rootStyle}>
      {content}
    </KeyboardAvoidingView>
  ) : (
    <View collapsable={false} style={rootStyle}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingTop: spacing.xs, paddingBottom: spacing.xxl },
  body: { paddingHorizontal: spacing.xl },
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderTopWidth: 1,
  },
});
