import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { reportError } from '../../lib/error-reporting';
import { useTheme } from '../../providers/theme-provider';

type BoardRenderUnavailableProps = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  climbUuid?: string | null;
  climbName?: string | null;
};

export const BoardRenderUnavailable = memo(function BoardRenderUnavailable({
  boardName,
  layoutId,
  sizeId,
  setIds,
  climbUuid,
  climbName,
}: BoardRenderUnavailableProps) {
  const { systemColors } = useTheme();
  useEffect(() => {
    reportError(new Error('Play drawer board render data unavailable'), {
      tags: {
        feature: 'mobile_play_drawer',
        boardName,
      },
      extra: {
        layoutId,
        sizeId,
        setIds,
        climbUuid,
        climbName,
      },
    });
  }, [boardName, climbName, climbUuid, layoutId, setIds, sizeId]);

  return (
    <View
      testID="play-drawer-board-unavailable"
      style={[styles.container, { backgroundColor: systemColors.fill }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
