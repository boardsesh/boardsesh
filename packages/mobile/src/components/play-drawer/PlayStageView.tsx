import { memo, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { spacing } from '../../theme/tokens';

export type PlayStageViewProps = {
  topChrome: ReactNode;
  header: ReactNode;
  notice?: ReactNode;
  board: ReactNode;
  controls: ReactNode;
  controlsAbove?: boolean;
  controlsBelowFold?: boolean;
  onBoardLayout?: (event: LayoutChangeEvent) => void;
  /** Interactive boards own their resting gutter inside a full-width zoom viewport. */
  boardHorizontalInset?: number;
};
/** The player's first screen. Live controllers and isolated stories compose the same layout. */
export const PlayStageView = memo(function PlayStageView({
  topChrome,
  header,
  notice,
  board,
  controls,
  controlsAbove = false,
  controlsBelowFold = false,
  onBoardLayout,
  boardHorizontalInset = spacing[4],
}: PlayStageViewProps) {
  return (
    <View style={styles.root}>
      {topChrome}
      {header}
      {controlsAbove ? controls : null}
      {notice}
      <View style={[styles.board, { marginHorizontal: boardHorizontalInset }]} onLayout={onBoardLayout}>
        {board}
      </View>
      {controlsAbove || controlsBelowFold ? null : controls}
    </View>
  );
});
const styles = StyleSheet.create({
  root: { flex: 1 },
  board: { flex: 1, position: 'relative' },
});
