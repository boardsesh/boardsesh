import type { ComponentProps, ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { ActivityIndicator } from '../ActivityIndicator';
import { InteractiveFilterBoard } from '../search/InteractiveFilterBoard';
import { HoldFilterPicker } from '../search/HoldFilterPicker';

export type HoldFilterViewProps = {
  board: ComponentProps<typeof InteractiveFilterBoard> | null;
  picker: ComponentProps<typeof HoldFilterPicker>;
  heatmapPanel?: ReactNode;
  onHeatmapPanelLayout?: (event: LayoutChangeEvent) => void;
};
export function HoldFilterView({ board, picker, heatmapPanel, onHeatmapPanelLayout }: HoldFilterViewProps) {
  const { systemColors } = useTheme();
  if (!board)
    return (
      <View style={[styles.loading, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={styles.boardSection}>
        <InteractiveFilterBoard {...board} />
      </View>
      <View onLayout={onHeatmapPanelLayout}>{heatmapPanel}</View>
      <HoldFilterPicker {...picker} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
