import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { BoardName } from '@boardsesh/shared-schema';
import type { getCreateBoardHolds } from '../../lib/create-board-holds';
import { CreateDrawer } from './CreateDrawer';
import { HoldRoleSheet } from './HoldRoleSheet';
import { MoonBoardBackground } from './MoonBoardBackground';
import { MoonBoardCreateDrawerForm } from './MoonBoardCreateDrawerForm';
import { MOONBOARD_PAINT_ROLES } from './brush-roles';
import { useMoonBoardCreateScreen } from './use-moonboard-create-screen';
import type { CreateClimbBoard } from './use-create-climb-screen';

type MoonBoardCreateClimbScreenProps = {
  board: CreateClimbBoard;
  boardHolds: NonNullable<ReturnType<typeof getCreateBoardHolds>>;
};

/**
 * MoonBoard create-climb editor. It reuses the main create drawer chrome, but
 * supplies MoonBoard background layers and MoonBoard-specific form controls.
 */
export function MoonBoardCreateClimbScreen({ board, boardHolds }: MoonBoardCreateClimbScreenProps) {
  const router = useRouter();
  const controller = useMoonBoardCreateScreen({ board });

  const [longPressHoldId, setLongPressHoldId] = useState<number | null>(null);
  const setIds = useMemo(() => board.setIds.split(',').map(Number).filter(Boolean), [board.setIds]);

  const handleLongPress = useCallback((holdId: number) => setLongPressHoldId(holdId), []);
  const closeHoldRole = useCallback(() => setLongPressHoldId(null), []);

  const handleViewDuplicate = useCallback(
    (uuid: string) => {
      router.push({
        pathname: '/(tabs)/climbs/[climbUuid]',
        params: {
          climbUuid: uuid,
          boardName: board.boardName,
          layoutId: String(board.layoutId),
          sizeId: String(board.sizeId),
          setIds: board.setIds,
          angle: String(controller.angle),
        },
      });
    },
    [router, board, controller.angle],
  );

  return (
    <View style={styles.container}>
      <CreateDrawer
        board={board}
        controller={controller}
        boardHolds={boardHolds}
        background={<MoonBoardBackground layoutId={board.layoutId} setIds={setIds} />}
        paintRoles={MOONBOARD_PAINT_ROLES}
        onLongPressHold={handleLongPress}
        subSheetOpen={longPressHoldId !== null}
        onClose={() => router.back()}
        onViewDuplicate={handleViewDuplicate}
        belowFold={
          <MoonBoardCreateDrawerForm
            description={controller.description}
            isDraft={controller.isDraft}
            showAllHolds={controller.showAllHolds}
            angle={controller.angle}
            userGrade={controller.userGrade}
            isBenchmark={controller.isBenchmark}
            onChangeDescription={controller.setDescription}
            onChangeIsDraft={controller.setIsDraft}
            onChangeShowAllHolds={controller.setShowAllHolds}
            onChangeAngle={controller.setAngle}
            onChangeUserGrade={controller.setUserGrade}
            onChangeIsBenchmark={controller.setIsBenchmark}
          />
        }
      />

      <HoldRoleSheet
        holdId={longPressHoldId}
        boardName={board.boardName as BoardName}
        litUpHoldsMap={controller.litUpHoldsMap}
        startingCount={controller.startingCount}
        finishCount={controller.finishCount}
        paintRoles={MOONBOARD_PAINT_ROLES}
        onSelectRole={controller.handleAssignRole}
        onClose={closeHoldRole}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
