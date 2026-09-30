import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { GlassCluster } from '../GlassCluster';
import { spacing } from '../../theme/tokens';

type SprayHoldChipBarProps = {
  /** Distance from the screen's bottom edge — docked just above the bottom bar. */
  bottom: number;
  canShrink: boolean;
  canGrow: boolean;
  onShrink: () => void;
  onGrow: () => void;
  onTrace: () => void;
  onJoin: () => void;
  onRemove: () => void;
};

/**
 * What a long-pressed hold can have done to it: size, shape, join, remove.
 *
 * Only on screen while a hold is selected, so the resting editor shows the wall
 * and three controls, and the fixing tools appear exactly when there is a hold
 * to fix. Tonal buttons drawn `over="content"`, because this row sits on the
 * photograph rather than on an app surface.
 */
export const SprayHoldChipBar = React.memo(function SprayHoldChipBar({
  bottom,
  canShrink,
  canGrow,
  onShrink,
  onGrow,
  onTrace,
  onJoin,
  onRemove,
}: SprayHoldChipBarProps) {
  const { t } = useTranslation('boards');
  return (
    <View pointerEvents="box-none" style={[styles.root, { bottom }]}>
      <GlassCluster spacing={spacing[2]} style={styles.row}>
        <Button
          title={t('sprayEditor.chips.smaller')}
          variant="tonal"
          size="small"
          over="content"
          onPress={onShrink}
          disabled={!canShrink}
        />
        <Button
          title={t('sprayEditor.chips.bigger')}
          variant="tonal"
          size="small"
          over="content"
          onPress={onGrow}
          disabled={!canGrow}
        />
        <Button title={t('sprayEditor.chips.trace')} variant="tonal" size="small" over="content" onPress={onTrace} />
        <Button title={t('sprayEditor.chips.join')} variant="tonal" size="small" over="content" onPress={onJoin} />
        <Button
          title={t('sprayEditor.chips.remove')}
          variant="tonal"
          size="small"
          role="destructive"
          over="content"
          onPress={onRemove}
        />
      </GlassCluster>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing[2],
  },
});
