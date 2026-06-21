import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useBoard, useProfile, useUpdateBoard } from '../../src/lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useAuth } from '../../src/providers/auth-provider';
import { useToast } from '../../src/providers/toast-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { useBoardBuilder, type BoardBuilderSeed } from '../../src/components/board-discovery/use-board-builder';
import { BoardForm } from '../../src/components/board-discovery/BoardForm';
import { formatDefaultBoardName } from '../../src/components/board-discovery/board-builder-labels';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { useTheme } from '../../src/providers/theme-provider';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing } from '../../src/theme/tokens';

export default function EditBoard() {
  const router = useRouter();
  const { boardUuid } = useLocalSearchParams<{ boardUuid?: string }>();
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  const { data: board, isLoading } = useBoard(boardUuid ?? null);
  const boardName = board ? toBoardName(board.boardType) : null;

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Missing (deleted elsewhere / stale link) or an unrenderable board type:
  // there's nothing to edit, so offer a way back rather than a broken form.
  if (!board || !boardName) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="error" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.edit.notFound')}
        </Text>
        <Button
          title={t('mobile.edit.back')}
          variant="outlined"
          onPress={() => router.back()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  // Remount the form per board so the builder seeds (incl. the More-options meta,
  // which only applies via the state initialisers) from a fully-loaded board.
  return <EditBoardForm key={board.uuid} board={board} />;
}

function EditBoardForm({ board }: { board: UserBoard }) {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();

  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const updateBoard = useUpdateBoard();

  // Config edits are server-rejected once a board has ticks; lock the chips and
  // omit the config from the update so we don't trip that guard.
  const lockedConfig = board.totalAscents > 0;

  const seed = useMemo<BoardBuilderSeed>(() => {
    const seedBoardName = toBoardName(board.boardType)!;
    return {
      boardName: seedBoardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
      name: board.name,
      isOwned: board.isOwned,
      isPublic: board.isPublic,
      isUnlisted: board.isUnlisted,
      hideLocation: board.hideLocation,
      isAngleAdjustable: board.isAngleAdjustable,
      locationName: board.locationName ?? undefined,
      latitude: board.latitude ?? undefined,
      longitude: board.longitude ?? undefined,
      serialNumber: board.serialNumber ?? undefined,
    };
  }, [board]);

  const builder = useBoardBuilder(seed);

  const selectedSize = useMemo(
    () => builder.sizes.find((size) => size.id === builder.sizeId) ?? null,
    [builder.sizes, builder.sizeId],
  );
  const defaultName = useMemo(
    () =>
      formatDefaultBoardName({
        userName: profile?.displayName,
        boardName: builder.boardName,
        layoutName: builder.rawLayoutName,
        size: selectedSize,
      }),
    [profile?.displayName, builder.boardName, builder.rawLayoutName, selectedSize],
  );

  const [submitting, setSubmitting] = useState(false);

  const handleUpdate = useCallback(async () => {
    if (submitting) return;
    const input = builder.buildUpdateInput(board.uuid, { lockedConfig, fallbackName: defaultName });
    if (!input) return;
    setSubmitting(true);
    hapticSelection();
    try {
      const updated = await updateBoard.mutateAsync(input);
      // The active board is a denormalised AsyncStorage copy — re-persist it so
      // the rename / angle / visibility change reaches BLE + the play drawer.
      if (activeBoard?.uuid === updated.uuid) await setActiveBoard(updated);
      router.back();
      // Navigated away on success — leave `submitting` set (unmounting).
    } catch {
      // Covers the config-locked race and the duplicate-config guard, both of
      // which the server enforces authoritatively.
      showToast(t('mobile.edit.updateError'), 'error');
      setSubmitting(false);
    }
  }, [
    submitting,
    builder,
    board.uuid,
    lockedConfig,
    defaultName,
    updateBoard,
    activeBoard?.uuid,
    setActiveBoard,
    router,
    showToast,
    t,
  ]);

  return (
    <BoardForm
      builder={builder}
      defaultName={defaultName}
      submitting={submitting}
      onSubmit={() => void handleUpdate()}
      submitLabel={t('mobile.edit.save')}
      lockedConfig={lockedConfig}
    />
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateButton: {
    marginTop: spacing[4],
  },
});
