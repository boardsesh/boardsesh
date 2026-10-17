import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useSetBoardAngle } from '../../lib/boards/use-set-board-angle';
import { hapticLight } from '../../lib/haptics';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { useBoardAngleOptions } from '../../hooks/use-board-angle-options';
import { spacing } from '../../theme/tokens';
import { Text } from '../Text';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import { AnchoredPopover } from '../navigation/AnchoredPopover';
import { AngleBoardDiagram } from '../play-drawer/AngleBoardDiagram';
import { AngleSlider } from '../play-drawer/AngleSlider';
import { SheetTopBar } from '../SheetTopBar';

type AnglePresentation = { scope: string; popover: boolean; open: boolean };

/** One angle picker shared by toolbar buttons and the climb-list menu. */
export function BoardAnglePicker({ children }: { children: (open: () => void) => ReactElement }) {
  const { t: tSession } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { isPad, widthClass } = useDeviceLayout();
  const usesPopover = Platform.OS === 'ios' && isPad && widthClass === 'regular';
  const { data: activeBoard } = useActiveBoard();
  const setBoardAngle = useSetBoardAngle();
  const angles = useBoardAngleOptions(activeBoard?.boardType as BoardName | undefined);
  const [presentation, setPresentation] = useState<AnglePresentation | null>(null);
  const [selectedAngle, setSelectedAngle] = useState(activeBoard?.angle ?? 40);
  const canAdjust = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;
  // An open picker belongs to one board and starting angle. A remote angle change
  // or board switch must not apply its old preview to the new list context.
  const scope = JSON.stringify([
    activeBoard?.uuid,
    activeBoard?.boardType,
    activeBoard?.layoutId,
    activeBoard?.sizeId,
    activeBoard?.setIds,
    activeBoard?.angle,
    canAdjust,
  ]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const visible = presentation?.open === true && presentation.scope === scope && canAdjust;

  useEffect(() => {
    if (presentation?.open && presentation.scope !== scope) setPresentation({ ...presentation, open: false });
  }, [presentation, scope]);

  const open = useCallback(() => {
    if (!activeBoard || !canAdjust) return;
    hapticLight();
    setSelectedAngle(activeBoard.angle);
    setPresentation({ scope, popover: usesPopover, open: true });
  }, [activeBoard, canAdjust, usesPopover, scope]);
  const close = useCallback(() => setPresentation((current) => (current ? { ...current, open: false } : current)), []);
  const change = useCallback(
    (angle: number) => {
      if (!activeBoard || !canAdjust || !visible || currentScope.current !== scope || angle === activeBoard.angle)
        return;
      void setBoardAngle(activeBoard, angle);
    },
    [activeBoard, canAdjust, visible, scope, setBoardAngle],
  );

  const trigger = children(open);
  if (!activeBoard || !canAdjust) return trigger;

  if (presentation?.popover ?? usesPopover)
    return (
      <AnchoredPopover
        visible={visible}
        onClose={close}
        trigger={trigger}
        content={
          <View>
            <SheetTopBar
              title={tSession('mobile.angleSelector.title')}
              leading={{ kind: 'close', onPress: close }}
              trailing={{
                kind: 'confirm',
                label: tCommon('actions.done'),
                prominent: true,
                onPress: () => {
                  change(selectedAngle);
                  close();
                },
              }}
            />
            <View style={styles.popoverBody}>
              <AngleBoardDiagram
                angle={selectedAngle}
                size={150}
                accessibilityLabel={tSession('mobile.angleSelector.diagramAria', { angle: selectedAngle })}
              />
              <Text variant="largeTitle" numeric>
                {selectedAngle}°
              </Text>
              <AngleSlider angles={angles} value={selectedAngle} onChange={setSelectedAngle} />
            </View>
          </View>
        }
      />
    );

  return (
    <>
      {trigger}
      <AngleSelectorSheet
        visible={visible}
        onClose={close}
        boardName={activeBoard.boardType}
        layoutId={activeBoard.layoutId}
        currentAngle={activeBoard.angle}
        onAngleChange={change}
      />
    </>
  );
}

const styles = StyleSheet.create({
  popoverBody: { padding: spacing[4], gap: spacing[4], alignItems: 'center' },
});
