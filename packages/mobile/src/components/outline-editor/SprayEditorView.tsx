import type { ReactNode, ComponentProps } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { SprayEditorKeyScope } from './SprayEditorKeyScope';
import { SPRAY_BAR_GUTTER, SPRAY_BAR_TOTAL_HEIGHT } from './spray-photo-frame';
type Props = Pick<
  ComponentProps<typeof SprayEditorKeyScope>,
  'commands' | 'onShortcut' | 'onPencilGesture' | 'onLayout'
> & {
  headerInset: number;
  board: ReactNode;
  banner?: ReactNode;
  hint?: ReactNode;
  chrome: ReactNode;
  palette?: ReactNode;
  loupe?: ReactNode;
};
/** Shared editor painting order and native keyboard/Pencil scope. */
export function SprayEditorView({ headerInset, board, banner, hint, chrome, palette, loupe, ...scope }: Props) {
  const { systemColors } = useTheme();
  return (
    <SprayEditorKeyScope
      {...scope}
      style={[styles.root, { backgroundColor: systemColors.background, marginTop: headerInset }]}
      contentStyle={styles.content}
    >
      {board}
      {banner}
      {hint}
      {chrome}
      {palette}
      {loupe}
    </SprayEditorKeyScope>
  );
}
export function SprayEditorPhoneChromeView({
  bottomInset,
  onDockLayout,
  dock,
  bottomBar,
  counts,
  menu,
}: {
  bottomInset: number;
  onDockLayout?: (event: LayoutChangeEvent) => void;
  dock?: ReactNode;
  bottomBar: ReactNode;
  counts: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <>
      <View
        pointerEvents="box-none"
        onLayout={onDockLayout}
        style={[styles.dock, { bottom: bottomInset + SPRAY_BAR_GUTTER * 2 + SPRAY_BAR_TOTAL_HEIGHT }]}
      >
        {dock}
      </View>
      {bottomBar}
      <View pointerEvents="box-none" style={styles.topStrip}>
        {counts}
        {menu}
      </View>
    </>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { alignItems: 'center' },
  dock: { position: 'absolute', left: spacing[4], right: spacing[4], alignItems: 'center', gap: spacing[2] },
  topStrip: {
    position: 'absolute',
    top: spacing[2],
    left: spacing[2],
    right: spacing[2] * 2 + glassSize.capsule,
    alignItems: 'flex-start',
    gap: spacing[2],
  },
});
