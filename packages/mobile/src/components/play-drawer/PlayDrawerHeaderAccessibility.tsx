import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { describePlayDrawerHeader, type LivePlayDrawerHeaderModel } from './PlayDrawerHeader';
import { useWallStatePillAccessibility, type WallStatePillState } from './WallStatePill';

type PlayDrawerHeaderAccessibilityProps = {
  /** The current climb's header, the same model the drawn header reads. */
  model: LivePlayDrawerHeaderModel;
  /** The wall pill in the header's leading slot; null when there is none. */
  pillState: WallStatePillState | null;
  pillBackTarget: 'wall' | 'current' | null;
  pillLatched: boolean;
  onPillPress?: () => void;
  onLongPressName?: () => void;
  onPressSetter?: () => void;
};

const COPY_NAME = 'copyName';
const OPEN_SETTER = 'openSetter';
const WALL_PILL = 'wallPill';

/**
 * What a screen reader lands on for the play drawer's header: one view over the
 * header that never moves and is never remounted, reading the current climb.
 * The drawn headers swap places on every climb change (`SwipeableHeader`), so
 * focus that sat on one would be left on a hidden view. Their controls (copy
 * the name, the setter link, the wall pill) are this view's custom actions.
 */
export const PlayDrawerHeaderAccessibility = memo(function PlayDrawerHeaderAccessibility({
  model,
  pillState,
  pillBackTarget,
  pillLatched,
  onPillPress,
  onLongPressName,
  onPressSetter,
}: PlayDrawerHeaderAccessibilityProps) {
  const { t } = useTranslation('climbs');
  const pillAccessibility = useWallStatePillAccessibility({
    state: pillState,
    backTarget: pillBackTarget,
    latched: pillLatched,
  });
  const { headerProps } = model;
  const label = describePlayDrawerHeader(headerProps, t);
  const setterUsername = headerProps.setterUsername;
  const canOpenSetter = Boolean(setterUsername) && onPressSetter !== undefined;
  const pillActionLabel = onPillPress ? pillAccessibility?.label : undefined;

  const accessibilityActions = useMemo(
    () => [
      ...(onLongPressName ? [{ name: COPY_NAME, label: t('mobile.climbActions.copyName') }] : []),
      ...(canOpenSetter ? [{ name: OPEN_SETTER, label: t('frontDoor.setterLink', { setter: setterUsername }) }] : []),
      ...(pillActionLabel ? [{ name: WALL_PILL, label: pillActionLabel }] : []),
    ],
    [onLongPressName, canOpenSetter, setterUsername, pillActionLabel, t],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const { actionName } = event.nativeEvent;
      if (actionName === COPY_NAME) onLongPressName?.();
      if (actionName === OPEN_SETTER && canOpenSetter) onPressSetter?.();
      if (actionName === WALL_PILL && pillActionLabel) onPillPress?.();
    },
    [onLongPressName, canOpenSetter, onPressSetter, pillActionLabel, onPillPress],
  );

  return (
    <View
      testID="play-drawer-header-accessibility"
      style={StyleSheet.absoluteFill}
      accessible
      accessibilityRole="header"
      accessibilityLabel={label}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
    />
  );
});
